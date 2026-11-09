// SPDX-License-Identifier: EUPL-1.2
import { lstat, readlink } from 'node:fs/promises';
import { join } from 'node:path';

import { chunkPathspecs, git } from './git-base.js';
import type { PatchedContentContext } from './patch-apply.js';
import { type DiffSection, parseDiffSections } from './patch-parse.js';

interface ModeInventory {
  modes: Map<string, string>;
  binary: Set<string>;
  sections: Map<string, DiffSection>;
}
const modes = new WeakMap<PatchedContentContext, Promise<ModeInventory>>();

/** Batch the baseline metadata once, then apply ordered patch mode publications. */
export function prepareOwnedModes(
  context: PatchedContentContext,
  engineDir: string,
  paths: string[]
): void {
  const preparation = collectModes(context, engineDir, paths);
  // The per-file classifier reports failure as drift; attach immediately so
  // an early unrelated prefetch error cannot leave an unhandled rejection.
  void preparation.catch(() => undefined);
  modes.set(context, preparation);
}

async function collectModes(
  context: PatchedContentContext,
  engine: string,
  paths: string[]
): Promise<ModeInventory> {
  const result = new Map<string, string>(),
    selected = new Set(paths),
    binary = new Set<string>(),
    sections = new Map<string, DiffSection>();
  const patches = new Map(
    paths.flatMap((path) =>
      context.getAffectingPatches(path).map((patch) => [patch.filename, patch] as const)
    )
  );
  for (const patch of [...patches.values()].sort((left, right) => left.order - right.order)) {
    const body = await context.readPatchBody(patch);
    for (const section of parseDiffSections(body)) {
      if (selected.has(section.sourcePath)) sections.set(section.sourcePath, section);
      if (!selected.has(section.targetPath)) continue;
      sections.set(section.targetPath, section);
      if (section.newMode) result.set(section.targetPath, section.newMode);
      if (section.isBinary) binary.add(section.targetPath);
      else binary.delete(section.targetPath);
    }
  }
  const unknown = paths.filter((path) => !result.has(path));
  for (const chunk of chunkPathspecs(unknown)) {
    const output = await git(['ls-tree', '-r', '-z', 'HEAD', '--', ...chunk], engine);
    for (const row of output.split('\0')) {
      const tab = row.indexOf('\t');
      if (tab > 0) result.set(row.slice(tab + 1), row.slice(0, 6));
    }
  }
  return { modes: result, binary, sections };
}

/** Reuse the parsed owning section; do not reparse every shared patch per dirty file. */
export async function ownedLastSection(
  context: PatchedContentContext,
  file: string
): Promise<DiffSection | undefined> {
  return (await modes.get(context))?.sections.get(file);
}

/** Recorded binary sections determine batching even for non-UTF8 data without NUL. */
export async function ownedBinaryPaths(
  context: PatchedContentContext
): Promise<ReadonlySet<string>> {
  try {
    return (await modes.get(context))?.binary ?? new Set();
  } catch {
    return new Set();
  } // Mode comparison separately refuses the failed inventory.
}

/** Unknown baseline or an object-type/mode mismatch cannot count as durable. */
export async function ownedModeMatches(
  context: PatchedContentContext,
  engine: string,
  path: string
): Promise<boolean> {
  const expected = (await modes.get(context))?.modes.get(path);
  const actual = await lstat(join(engine, path));
  const mode = actual.isSymbolicLink()
    ? '120000'
    : actual.isFile()
      ? (actual.mode & 0o111) === 0
        ? '100644'
        : '100755'
      : undefined;
  return expected !== undefined && expected === mode;
}

/** A Git link blob contains its link target, never the referred-to bytes. */
export async function readOwnedText(path: string): Promise<string | undefined> {
  return (await lstat(path)).isSymbolicLink() ? readlink(path) : undefined;
}
