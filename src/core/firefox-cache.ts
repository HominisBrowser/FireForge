// SPDX-License-Identifier: EUPL-1.2
/**
 * Cache validation, invalidation, and download-to-cache logic.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { DownloadError } from '../errors/download.js';
import { toError } from '../utils/errors.js';
import { pathExists, readJson, removeFile, writeJson } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';
import { createSiblingLockPath, withFileLock } from './file-lock.js';
import type { ArchiveMetadata, ResolvedArchive } from './firefox-archive.js';
import { validateArchiveMetadata } from './firefox-archive.js';
import type { ProgressCallback } from './firefox-download.js';
import { downloadFile } from './firefox-download.js';

/**
 * Computes the SHA-256 hex digest of a file.
 * @param filePath - Path to the file
 */
export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  await pipeline(stream, hash);
  return hash.digest('hex');
}

/**
 * Ensures a valid cached archive exists, downloading it if needed.
 * @param archive - Resolved archive descriptor
 * @param cacheDir - Cache directory
 * @param onProgress - Optional progress callback
 */
export async function ensureCachedArchive(
  archive: ResolvedArchive,
  cacheDir: string,
  onProgress?: ProgressCallback,
  expectedSha256?: string,
  onCacheProgress?: (message: string) => void
): Promise<void> {
  const lockPath = createSiblingLockPath(join(cacheDir, archive.filename), '.fireforge-cache.lock');
  await withFileLock(lockPath, async () => {
    onCacheProgress?.(`Validating source archive cache metadata for ${archive.filename}...`);
    if (await validateCachedArchive(archive, cacheDir, expectedSha256)) {
      onCacheProgress?.(`Using validated cached source archive ${archive.filename}`);
      return;
    }

    if (await cacheEntryExists(archive, cacheDir)) {
      onCacheProgress?.(`Invalid cached source archive metadata; refreshing ${archive.filename}`);
      await invalidateArchiveCache(archive, cacheDir);
    } else {
      await removeArchivePartFiles(archive, cacheDir);
    }
    await downloadToCache(archive, cacheDir, onProgress, expectedSha256, onCacheProgress);
  });
}

async function cacheEntryExists(archive: ResolvedArchive, cacheDir: string): Promise<boolean> {
  return (
    (await pathExists(join(cacheDir, archive.filename))) ||
    (await pathExists(join(cacheDir, archive.metadataFilename)))
  );
}

/**
 * Validates a cached archive using sidecar metadata and SHA-256 checksum.
 * @param archive - Resolved archive descriptor
 * @param cacheDir - Cache directory
 * @returns True if the cache entry is valid
 */
async function validateCachedArchive(
  archive: ResolvedArchive,
  cacheDir: string,
  expectedSha256?: string
): Promise<boolean> {
  const tarballPath = join(cacheDir, archive.filename);
  const metadataPath = join(cacheDir, archive.metadataFilename);

  if (!(await pathExists(tarballPath)) || !(await pathExists(metadataPath))) {
    return false;
  }

  try {
    const metadata = validateArchiveMetadata(await readJson<unknown>(metadataPath));
    if (
      metadata.product !== archive.product ||
      metadata.archiveVersion !== archive.archiveVersion ||
      metadata.url !== archive.url
    ) {
      return false;
    }

    if (metadata.contentLength !== undefined) {
      const { stat } = await import('node:fs/promises');
      const archiveStats = await stat(tarballPath);
      if (archiveStats.size !== metadata.contentLength) {
        return false;
      }
    }

    if (expectedSha256 || metadata.sha256) {
      const actualHash = await sha256File(tarballPath);
      if (expectedSha256 && actualHash !== expectedSha256) {
        return false;
      }
      if (metadata.sha256 && actualHash !== metadata.sha256) {
        return false;
      }
    }

    return true;
  } catch (error: unknown) {
    verbose(
      `Cache validation failed for ${tarballPath}; treating cache entry as invalid: ${toError(error).message}`
    );
    return false;
  }
}

/**
 * Downloads an archive to cache using an atomic temp file and sidecar metadata.
 * @param archive - Resolved archive descriptor
 * @param cacheDir - Cache directory
 * @param onProgress - Optional progress callback
 */
async function downloadToCache(
  archive: ResolvedArchive,
  cacheDir: string,
  onProgress?: ProgressCallback,
  expectedSha256?: string,
  onCacheProgress?: (message: string) => void
): Promise<void> {
  const tarballPath = join(cacheDir, archive.filename);
  // Use a unique .part path so concurrent downloads for the same archive
  // do not clobber each other's partial files.
  const partPath = `${tarballPath}.part-${randomUUID()}`;
  const metadataPath = join(cacheDir, archive.metadataFilename);
  let promotedTarball = false;

  try {
    onCacheProgress?.(`Downloading source archive to cache: ${archive.filename}`);
    const contentLength = await downloadFile(archive.url, partPath, onProgress);
    await rename(partPath, tarballPath);
    promotedTarball = true;
    onCacheProgress?.(`Calculating source archive SHA-256 for ${archive.filename}...`);
    const sha256 = await sha256File(tarballPath);
    if (expectedSha256 && sha256 !== expectedSha256) {
      throw new DownloadError(
        `Downloaded archive SHA-256 mismatch: expected ${expectedSha256}, got ${sha256}`,
        archive.url
      );
    }
    onCacheProgress?.(`Writing source archive cache metadata for ${archive.metadataFilename}...`);
    await writeJson(metadataPath, {
      requestedVersion: archive.requestedVersion,
      product: archive.product,
      archiveVersion: archive.archiveVersion,
      url: archive.url,
      ...(contentLength !== undefined ? { contentLength } : {}),
      sha256,
      downloadedAt: new Date().toISOString(),
    } satisfies ArchiveMetadata);
    onCacheProgress?.(`Source archive cache metadata written: ${archive.metadataFilename}`);
  } catch (error: unknown) {
    await removeFile(partPath);
    if (promotedTarball) {
      await removeFile(tarballPath);
      await removeFile(metadataPath);
    }
    throw error;
  }
}

/**
 * Removes cached tarball, metadata, and partial download files for an archive.
 * @param archive - Resolved archive descriptor
 * @param cacheDir - Cache directory
 */
export async function invalidateArchiveCache(
  archive: ResolvedArchive,
  cacheDir: string
): Promise<void> {
  const tarballPath = join(cacheDir, archive.filename);
  const metadataPath = join(cacheDir, archive.metadataFilename);

  await removeArchivePartFiles(archive, cacheDir);

  await removeFile(tarballPath);
  await removeFile(metadataPath);
}

async function removeArchivePartFiles(archive: ResolvedArchive, cacheDir: string): Promise<void> {
  const partPrefix = `${archive.filename}.part`;
  try {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(cacheDir);
    await Promise.all(
      entries
        .filter((name) => name.startsWith(partPrefix))
        .map((name) => removeFile(join(cacheDir, name)))
    );
  } catch (error: unknown) {
    void error;
    // Cache dir may not exist yet — that's fine.
  }
}
