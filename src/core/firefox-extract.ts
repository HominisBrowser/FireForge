// SPDX-License-Identifier: EUPL-1.2
/**
 * Firefox source extraction and installed version detection.
 */

import { join } from 'node:path';

import { ExtractionError } from '../errors/download.js';
import { ensureDir, pathExists } from '../utils/fs.js';
import { exec, executableExists } from '../utils/process.js';

/**
 * Extracts a tar.xz archive.
 * @param archivePath - Path to the archive
 * @param destDir - Destination directory
 */
export async function extractTarXz(archivePath: string, destDir: string): Promise<void> {
  if (!(await executableExists('tar'))) {
    throw new ExtractionError(
      archivePath,
      new Error(
        'The "tar" command was not found. Please install tar (or ensure it is on your PATH) and try again.'
      )
    );
  }

  await ensureDir(destDir);

  const result = await exec('tar', ['-xf', archivePath, '-C', destDir]);

  if (result.exitCode !== 0) {
    throw new ExtractionError(
      archivePath,
      new Error(`tar exited with code ${result.exitCode}:\n${result.stderr}`)
    );
  }
}

/**
 * Gets the Firefox version from an existing source directory.
 * @param engineDir - Path to the engine directory
 * @returns Firefox version string
 */
export async function getFirefoxVersion(engineDir: string): Promise<string | undefined> {
  const versionPath = join(engineDir, 'browser', 'config', 'version.txt');

  if (!(await pathExists(versionPath))) {
    return undefined;
  }

  const { readText } = await import('../utils/fs.js');
  const version = await readText(versionPath);
  return version.trim();
}

/**
 * Formats bytes into a human-readable string.
 * @param bytes - Number of bytes
 * @returns Formatted string (e.g., "1.5 GB")
 */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(1)} ${units[unitIndex]}`;
}
