// SPDX-License-Identifier: EUPL-1.2
import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';

import type { PatchInfo } from '../types/commands/index.js';
import { pathExists, readText } from '../utils/fs.js';
import { extractAffectedFiles, extractOrder } from './patch-parse.js';

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

/**
 * Returns all target file paths referenced by a multi-file patch.
 *
 * Delegates to {@link extractAffectedFiles} so `GIT binary patch` sections
 * (which have no `+++ b/…` line, only a `diff --git a/… b/…` header) are
 * included alongside text hunks. Matching only `+++ b/…` lines drops every
 * binary file from `filesAffected`, so verify reports
 * `files-affected-mismatch` against branding patches and
 * `doctor --repair-patches-manifest` "repairs" the manifest by rewriting it
 * to the text-only subset, hiding the true scope of the patch.
 */
export async function getAllTargetFilesFromPatch(patchPath: string): Promise<string[]> {
  const content = await readText(patchPath);
  return extractAffectedFiles(content);
}
