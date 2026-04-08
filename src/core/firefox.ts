// SPDX-License-Identifier: EUPL-1.2
/**
 * Firefox source download, extraction, and cache management.
 *
 * Re-exports from focused sub-modules and provides the top-level
 * {@link downloadFirefoxSource} orchestrator.
 */

import { randomUUID } from 'node:crypto';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';

import type { FirefoxProduct } from '../types/config.js';
import { ensureDir, removeDir } from '../utils/fs.js';
import { resolveArchive } from './firefox-archive.js';
import { ensureCachedArchive, invalidateArchiveCache } from './firefox-cache.js';
import type { ProgressCallback } from './firefox-download.js';
import { extractTarXz } from './firefox-extract.js';

// ── Re-exports (preserve public API) ──
export { resolveArchive } from './firefox-archive.js';
export type { ProgressCallback } from './firefox-download.js';
export { formatBytes, getFirefoxVersion } from './firefox-extract.js';

/**
 * Gets the download URL for a Firefox source tarball.
 * @param version - Firefox version (e.g., "140.0esr")
 * @param product - Firefox product type
 * @returns Full URL to the source tarball
 */
export function getDownloadUrl(version: string, product: FirefoxProduct = 'firefox'): string {
  return resolveArchive(version, product).url;
}

/**
 * Gets the filename for a Firefox source tarball.
 * @param version - Firefox version
 * @param product - Firefox product type
 * @returns Tarball filename
 */
export function getTarballFilename(version: string, product: FirefoxProduct = 'firefox'): string {
  return resolveArchive(version, product).filename;
}

/**
 * Downloads and extracts Firefox source.
 * @param version - Firefox version to download
 * @param product - Firefox product type
 * @param destDir - Destination directory for extracted source
 * @param cacheDir - Directory to store downloaded tarball
 * @param onProgress - Optional progress callback
 */
export async function downloadFirefoxSource(
  version: string,
  product: FirefoxProduct,
  destDir: string,
  cacheDir: string,
  onProgress?: ProgressCallback
): Promise<void> {
  const archive = resolveArchive(version, product);
  const tarballPath = join(cacheDir, archive.filename);

  // Ensure cache directory exists
  await ensureDir(cacheDir);

  await ensureCachedArchive(archive, cacheDir, onProgress);

  // Extract to a unique temporary directory so concurrent downloads for
  // the same destination do not clobber each other.
  const tempDir = `${destDir}.tmp-${randomUUID()}`;
  try {
    await extractTarXz(tarballPath, tempDir);
  } catch (error: unknown) {
    await removeDir(tempDir);
    await invalidateArchiveCache(archive, cacheDir);
    throw error;
  }

  // Firefox source extracts to a subdirectory (e.g., firefox-140.0/)
  // Find it dynamically since ESR versions may have different naming
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(tempDir, { withFileTypes: true });
  const extractedSubdir = entries.find(
    (entry) => entry.isDirectory() && entry.name.startsWith('firefox-')
  );

  if (extractedSubdir) {
    const extractedDir = join(tempDir, extractedSubdir.name);
    await removeDir(destDir);
    await rename(extractedDir, destDir);
    await removeDir(tempDir);
  } else {
    // If no subdirectory, the temp dir is the source
    await removeDir(destDir);
    await rename(tempDir, destDir);
  }
}
