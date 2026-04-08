// SPDX-License-Identifier: EUPL-1.2
/**
 * Cache validation, invalidation, and download-to-cache logic.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { toError } from '../utils/errors.js';
import { pathExists, readJson, removeFile, writeJson } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';
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
  onProgress?: ProgressCallback
): Promise<void> {
  if (await validateCachedArchive(archive, cacheDir)) {
    return;
  }

  await invalidateArchiveCache(archive, cacheDir);
  await downloadToCache(archive, cacheDir, onProgress);
}

/**
 * Validates a cached archive using sidecar metadata and SHA-256 checksum.
 * @param archive - Resolved archive descriptor
 * @param cacheDir - Cache directory
 * @returns True if the cache entry is valid
 */
async function validateCachedArchive(archive: ResolvedArchive, cacheDir: string): Promise<boolean> {
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

    if (metadata.sha256) {
      const actualHash = await sha256File(tarballPath);
      if (actualHash !== metadata.sha256) {
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
  onProgress?: ProgressCallback
): Promise<void> {
  const tarballPath = join(cacheDir, archive.filename);
  // Use a unique .part path so concurrent downloads for the same archive
  // do not clobber each other's partial files.
  const partPath = `${tarballPath}.part-${randomUUID()}`;
  const metadataPath = join(cacheDir, archive.metadataFilename);

  try {
    const contentLength = await downloadFile(archive.url, partPath, onProgress);
    await rename(partPath, tarballPath);
    const sha256 = await sha256File(tarballPath);
    await writeJson(metadataPath, {
      requestedVersion: archive.requestedVersion,
      product: archive.product,
      archiveVersion: archive.archiveVersion,
      url: archive.url,
      ...(contentLength !== undefined ? { contentLength } : {}),
      sha256,
      downloadedAt: new Date().toISOString(),
    } satisfies ArchiveMetadata);
  } catch (error: unknown) {
    await removeFile(partPath);
    await removeFile(tarballPath);
    await removeFile(metadataPath);
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

  // Clean up any partial download files (may have unique suffixes from
  // concurrent download attempts).
  const partPrefix = `${archive.filename}.part`;
  try {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(cacheDir);
    await Promise.all(
      entries
        .filter((name) => name.startsWith(partPrefix))
        .map((name) => removeFile(join(cacheDir, name)))
    );
  } catch {
    // Cache dir may not exist yet — that's fine.
  }

  await removeFile(tarballPath);
  await removeFile(metadataPath);
}
