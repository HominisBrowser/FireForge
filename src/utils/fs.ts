// SPDX-License-Identifier: EUPL-1.2
import { randomUUID } from 'node:crypto';
import {
  access,
  copyFile as fsCopyFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

const RETRIABLE_REMOVE_ERRORS = new Set(['ENOTEMPTY', 'EBUSY', 'EPERM']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Checks if a path exists.
 * @param path - Path to check
 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error: unknown) {
    void error;
    return false;
  }
}

/**
 * Ensures a directory exists, creating it recursively if needed.
 * @param path - Directory path to ensure
 */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/**
 * Ensures the parent directory of a file exists.
 * @param filePath - Path to a file
 */
export async function ensureParentDir(filePath: string): Promise<void> {
  const parent = dirname(filePath);
  await ensureDir(parent);
}

/**
 * Removes a directory recursively.
 * @param path - Directory path to remove
 */
export async function removeDir(path: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error: unknown) {
      const code =
        error instanceof Error && 'code' in error && typeof error.code === 'string'
          ? error.code
          : undefined;

      if (!code || !RETRIABLE_REMOVE_ERRORS.has(code) || attempt === 4) {
        throw error;
      }

      await sleep(50 * (attempt + 1));
    }
  }
}

/**
 * Removes a file.
 * @param path - File path to remove
 */
export async function removeFile(path: string): Promise<void> {
  await rm(path, { force: true });
}

/**
 * Copies a file from source to destination.
 * Creates parent directories if needed.
 * @param src - Source file path
 * @param dest - Destination file path
 */
export async function copyFile(src: string, dest: string): Promise<void> {
  await ensureParentDir(dest);
  await fsCopyFile(src, dest);
}

/**
 * Reads a JSON file and parses it.
 * @param path - Path to JSON file
 * @returns Parsed JSON content
 * @throws Error if file doesn't exist or contains invalid JSON
 */
export async function readJson<T>(path: string): Promise<T> {
  const content = await readFile(path, 'utf-8');
  return JSON.parse(content, (key, value: unknown) =>
    key === '__proto__' || key === 'constructor' || key === 'prototype' ? undefined : value
  ) as T;
}

/**
 * Writes data to a JSON file with pretty formatting.
 * Creates parent directories if needed.
 * @param path - Path to JSON file
 * @param data - Data to write
 */
export async function writeJson(path: string, data: unknown): Promise<void> {
  const content = JSON.stringify(data, null, 2) + '\n';
  await writeText(path, content);
}

/**
 * Reads a text file.
 * @param path - Path to text file
 * @returns File content as string
 */
export async function readText(path: string): Promise<string> {
  return readFile(path, 'utf-8');
}

/**
 * Writes text to a file.
 * Creates parent directories if needed.
 * @param path - Path to text file
 * @param content - Content to write
 */
export async function writeText(path: string, content: string): Promise<void> {
  await writeFileAtomic(path, content);
}

/**
 * Writes content atomically using a temp-file-and-rename strategy.
 * Temp files are created in the destination directory so rename stays atomic.
 * @param path - Destination file path
 * @param content - Content to write
 */
export async function writeFileAtomic(path: string, content: string | Buffer): Promise<void> {
  await ensureParentDir(path);

  const tempPath = createAtomicTempPath(path);
  const handle = await open(tempPath, 'w');

  try {
    await handle.writeFile(content);
    await handle.sync();
  } catch (error: unknown) {
    await handle.close();
    await rm(tempPath, { force: true });
    throw error;
  }

  await handle.close();

  try {
    await rename(tempPath, path);
  } catch (error: unknown) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

/**
 * Copies a directory recursively.
 * @param src - Source directory path
 * @param dest - Destination directory path
 */
export async function copyDir(src: string, dest: string): Promise<void> {
  await ensureDir(dest);

  const entries = await readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isSymbolicLink()) {
      // Skip symlinks to avoid circular recursion and symlink attacks
      continue;
    }

    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fsCopyFile(srcPath, destPath);
    }
  }
}

/**
 * Generates a unique temp file path for atomic writes.
 *
 * Each invocation gets its own path via PID + UUID, so concurrent writers
 * targeting the same destination never interfere with each other. Cleanup of
 * the temp file is the caller's responsibility on error; we intentionally do
 * NOT glob-delete peer temp files here to avoid racing with other writers.
 */
function createAtomicTempPath(path: string): string {
  const directory = dirname(path);
  const filename = path.slice(directory.length + 1);
  return join(directory, `.${filename}.fireforge-tmp-${process.pid}-${randomUUID()}`);
}
