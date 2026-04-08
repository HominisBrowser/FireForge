// SPDX-License-Identifier: EUPL-1.2
import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';

import type { PatchInfo } from '../types/commands/index.js';
import { pathExists, readText } from '../utils/fs.js';
import { extractOrder } from './patch-parse.js';

/** Discovers patch files in a directory and returns them in apply order. */
export async function discoverPatches(patchesDir: string): Promise<PatchInfo[]> {
  if (!(await pathExists(patchesDir))) {
    return [];
  }

  const entries = await readdir(patchesDir, { withFileTypes: true });
  const patches: PatchInfo[] = entries
    .filter((entry) => entry.isFile() && extname(entry.name) === '.patch')
    .map((entry) => ({
      path: join(patchesDir, entry.name),
      filename: entry.name,
      order: extractOrder(entry.name),
    }));

  patches.sort((a, b) => a.order - b.order || a.filename.localeCompare(b.filename));
  return patches;
}

/** Counts the patch files currently present in a patch directory. */
export async function countPatches(patchesDir: string): Promise<number> {
  const patches = await discoverPatches(patchesDir);
  return patches.length;
}

/** Checks whether a patch creates a new file rather than modifying an existing one. */
export async function isNewFilePatch(patchPath: string): Promise<boolean> {
  const content = await readText(patchPath);
  return content.includes('new file mode') && content.includes('--- /dev/null');
}

/** Returns the first target file path referenced by a patch, if any. */
export async function getTargetFileFromPatch(patchPath: string): Promise<string | null> {
  const content = await readText(patchPath);
  const match = /^\+\+\+ b\/(.+)$/m.exec(content);
  return match?.[1] ?? null;
}

/** Returns all target file paths referenced by a multi-file patch. */
export async function getAllTargetFilesFromPatch(patchPath: string): Promise<string[]> {
  const content = await readText(patchPath);
  const files: string[] = [];
  const regex = /^\+\+\+ b\/(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    if (match[1]) {
      files.push(match[1]);
    }
  }
  return files;
}
