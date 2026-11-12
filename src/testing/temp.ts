// SPDX-License-Identifier: EUPL-1.2
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach } from 'vitest';

/** File contents by forward-slash relative path. */
export type FileTree = Readonly<Record<string, string | Uint8Array>>;

/**
 * Creates a temporary directory. The path is canonical, so it compares equal
 * to what a child process or `git` reports for it.
 *
 * @param prefix - Name prefix
 */
export async function makeTempDir(prefix = 'fireforge-test-'): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

/**
 * Removes a temporary directory, retrying while a just-exited child still holds files in it.
 *
 * @param path - The directory
 */
export async function removeTempDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

/**
 * Gives each test in the enclosing `describe` (or file) a fresh temporary
 * directory, removed afterwards.
 *
 * @param prefix - Name prefix
 * @returns A getter for the current test's directory
 */
export function useTempDir(prefix?: string): () => string {
  let current = '';
  beforeEach(async () => {
    current = await makeTempDir(prefix);
  });
  afterEach(async () => {
    await removeTempDir(current);
  });
  return () => current;
}

/**
 * Writes files under a root, creating directories as needed.
 *
 * @param root - The directory
 * @param files - Contents by relative path
 */
export async function writeTree(root: string, files: FileTree): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

/**
 * Reads every file under a root as text, by forward-slash relative path,
 * for comparing a whole tree in one assertion.
 *
 * @param root - The directory
 * @param skip - Top-level names to leave out (`.git` by default)
 */
export async function readTree(
  root: string,
  skip: readonly string[] = ['.git']
): Promise<Record<string, string>> {
  const tree: Record<string, string> = {};
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (prefix === '' && skip.includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path, `${prefix}${entry.name}/`);
      else if (entry.isFile()) tree[`${prefix}${entry.name}`] = await readFile(path, 'utf8');
    }
  };
  await visit(root, '');
  return tree;
}
