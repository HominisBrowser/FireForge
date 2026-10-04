// SPDX-License-Identifier: EUPL-1.2
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import { listTrackedInHead } from '../core/git-file-ops.js';
import { parseDiffSections } from '../core/patch-parse.js';
import { InvalidArgumentError } from '../errors/base.js';
import type { PatchMetadata, ReExportOptions } from '../types/commands/index.js';
import type { ProjectPaths } from '../types/config.js';
import { getNodeErrorCode } from '../utils/errors.js';
import { readText } from '../utils/fs.js';
import { normalizeEngineRelativeInput } from './re-export-scan.js';

/** Validates every retirement before any patch is written; typos never silently grant a carve-out. */
export async function validateExpectedRemovals(
  paths: ProjectPaths,
  patches: PatchMetadata[],
  options: ReExportOptions
): Promise<string[]> {
  const removed = [
    ...new Set(
      (options.expectRemoved ?? []).map((file) =>
        normalizeEngineRelativeInput(file, '--expect-removed')
      )
    ),
  ];
  if (removed.length === 0) return removed;
  const tracked = await listTrackedInHead(paths.engine, removed);
  for (const file of removed) {
    const owners = patches.filter((patch) => patch.filesAffected.includes(file));
    if (
      owners.length !== 1 ||
      tracked.has(file) ||
      (await removalPathPresent(join(paths.engine, file)))
    ) {
      throw new InvalidArgumentError(
        `--expect-removed ${file} must be absent, untracked in engine HEAD, and owned by exactly one selected patch.`,
        '--expect-removed'
      );
    }
    const owner = owners[0];
    if (!owner) throw new InvalidArgumentError(`No selected owner for ${file}`, '--expect-removed');
    const body = await readText(join(paths.patches, owner.filename));
    if (
      !parseDiffSections(body).some((section) => section.targetPath === file && section.isNewFile)
    ) {
      throw new InvalidArgumentError(
        `--expect-removed ${file} was not created by its selected patch.`,
        '--expect-removed'
      );
    }
    if (owner.filesAffected.every((path) => removed.includes(path))) {
      throw new InvalidArgumentError(
        'Retiring every file would empty the patch; use patch delete instead.',
        '--expect-removed'
      );
    }
  }
  return removed;
}

/** A dangling symlink is still an existing owned path, not an approved absence. */
async function removalPathPresent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (getNodeErrorCode(error) === 'ENOENT') return false;
    throw error;
  }
}
