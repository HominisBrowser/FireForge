// SPDX-License-Identifier: EUPL-1.2
/**
 * Cache validation, invalidation, and download-to-cache logic.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { ChecksumMismatchError, ChecksumUnavailableError } from '../errors/download.js';
import { toError } from '../utils/errors.js';
import { pathExistsStrict, readJson, removeFile, writeJson } from '../utils/fs.js';
import { verbose, warn } from '../utils/logger.js';
import { createSiblingLockPath, withFileLock } from './file-lock.js';
import type { ArchiveMetadata, ResolvedArchive } from './firefox-archive.js';
import { validateArchiveMetadata } from './firefox-archive.js';
import type { ProgressCallback } from './firefox-download.js';
import { downloadFile, fetchWithRetry } from './firefox-download.js';

/** Options governing the default (unpinned) integrity check. */
export interface ArchiveIntegrityOptions {
  /**
   * Accept the download with a warning when the published SHA256SUMS cannot
   * be obtained (`firefox.allowUnverifiedDownload`). Default: fail closed.
   */
  allowUnverifiedDownload?: boolean;
}

/** Outcome of a SHA256SUMS lookup: the digest, or why there is none. */
type PublishedSha256Lookup = { sha256: string } | { sha256: null; reason: string };

/**
 * Computes the SHA-256 hex digest of a file.
 * @param filePath - Path to the file
 */
async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  await pipeline(stream, hash);
  return hash.digest('hex');
}

/**
 * Fetches Mozilla's published SHA256SUMS for the release and extracts the
 * digest for this archive. Yields a reason instead of a digest when the
 * checksum file cannot be fetched (non-2xx, network error, timeout) or does
 * not list the archive (a captive portal's HTML page lands here too) — the
 * caller decides whether that fails closed. The request goes through the
 * same `fetchWithRetry` as the archive download — same 60 s abort ceiling
 * per attempt, same three-attempt back-off on 429/5xx and network errors —
 * so an unresponsive checksum host cannot hang the command after the
 * tarball has landed, and one transient blip on the small checksum request
 * does not fail the verification closed and discard the archive.
 *
 * Line format (both variants appear in the wild):
 *   `<64-hex-digest>  <release-relative-path>`
 *   `<64-hex-digest> *<release-relative-path>`
 */
async function fetchPublishedSha256(archive: ResolvedArchive): Promise<PublishedSha256Lookup> {
  try {
    const response = await fetchWithRetry(archive.checksumsUrl);
    if (!response.ok) {
      return { sha256: null, reason: `HTTP ${response.status} fetching SHA256SUMS` };
    }
    const body = await response.text();
    for (const line of body.split('\n')) {
      const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
      if (match?.[1] && match[2] === archive.pathInChecksums) {
        return { sha256: match[1] };
      }
    }
    return {
      sha256: null,
      reason: `SHA256SUMS does not list ${archive.pathInChecksums} (wrong file, or a non-Mozilla response)`,
    };
  } catch (error: unknown) {
    return { sha256: null, reason: `SHA256SUMS fetch failed: ${toError(error).message}` };
  }
}

/**
 * Default integrity check for a download with no operator pin: the archive
 * digest must equal the one Mozilla publishes. TLS alone is thin trust for
 * the artifact that becomes the git baseline every patch is built on — a
 * compromised CDN response would otherwise be trusted with no signal.
 *
 * Fails CLOSED both on a mismatch and when the published digest cannot be
 * obtained: a 404, a captive-portal HTML page, or a dropped connection
 * would otherwise quietly downgrade the check to "TLS looked fine", which
 * is precisely the condition an attacker positioned on the network can
 * arrange. `allowUnverifiedDownload` (an explicit config opt-in for offline
 * mirrors) degrades the unavailable case to a loud warning; a FETCHED but
 * mismatching digest is never accepted.
 */
async function verifyAgainstPublishedSha256(
  archive: ResolvedArchive,
  actualSha256: string,
  options: ArchiveIntegrityOptions
): Promise<void> {
  const published = await fetchPublishedSha256(archive);
  if (published.sha256 !== null) {
    if (actualSha256 !== published.sha256) {
      throw new ChecksumMismatchError(archive.product, published.sha256, actualSha256, archive.url);
    }
    return;
  }
  verbose(`${published.reason} (${archive.checksumsUrl})`);
  if (options.allowUnverifiedDownload !== true) {
    throw new ChecksumUnavailableError(
      archive.product,
      archive.checksumsUrl,
      published.reason,
      archive.url
    );
  }
  warn(
    `Could not verify ${archive.filename} against Mozilla's published SHA256SUMS ` +
      `(${published.reason}). firefox.allowUnverifiedDownload is set, so the download is ` +
      'trusted on TLS alone — pin firefox.sha256 in fireforge.json to verify it.'
  );
}

/**
 * Ensures a valid cached archive exists, downloading it if needed.
 * @param archive - Resolved archive descriptor
 * @param cacheDir - Cache directory
 * @param onProgress - Optional progress callback
 * @param expectedSha256 - Operator-pinned digest; when set it replaces the
 *   published-SHA256SUMS check
 * @param onCacheProgress - Phase progress messages
 * @param integrity - Default integrity-check options (unpinned downloads)
 */
export async function ensureCachedArchive(
  archive: ResolvedArchive,
  cacheDir: string,
  onProgress?: ProgressCallback,
  expectedSha256?: string,
  onCacheProgress?: (message: string) => void,
  integrity: ArchiveIntegrityOptions = {}
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
    await downloadToCache(
      archive,
      cacheDir,
      onProgress,
      expectedSha256,
      onCacheProgress,
      integrity
    );
  });
}

async function cacheEntryExists(archive: ResolvedArchive, cacheDir: string): Promise<boolean> {
  return (
    (await pathExistsStrict(join(cacheDir, archive.filename))) ||
    (await pathExistsStrict(join(cacheDir, archive.metadataFilename)))
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

  // Deliberately outside the try/catch below: a permission error probing the
  // cache must propagate instead of reading as "invalid cache" and triggering
  // a re-download into a directory we cannot write anyway.
  if (!(await pathExistsStrict(tarballPath)) || !(await pathExistsStrict(metadataPath))) {
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
  onCacheProgress?: (message: string) => void,
  integrity: ArchiveIntegrityOptions = {}
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
    if (expectedSha256) {
      // Operator-pinned digest (firefox.sha256 config): takes precedence
      // and always fails closed.
      if (sha256 !== expectedSha256) {
        throw new ChecksumMismatchError(archive.product, expectedSha256, sha256, archive.url);
      }
    } else {
      // Default integrity check (see verifyAgainstPublishedSha256): any
      // failure throws, and the catch below deletes the promoted artifact.
      onCacheProgress?.(`Verifying archive against published SHA256SUMS...`);
      await verifyAgainstPublishedSha256(archive, sha256, integrity);
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
