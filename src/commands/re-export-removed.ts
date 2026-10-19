// SPDX-License-Identifier: EUPL-1.2
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import { listTrackedInHead } from '../core/git-file-ops.js';
import { getDirtyFiles } from '../core/git-status.js';
import { parseDiffSections } from '../core/patch-parse.js';
import { InvalidArgumentError } from '../errors/base.js';
import type { PatchMetadata, ReExportOptions } from '../types/commands/index.js';
import type { ProjectPaths } from '../types/config.js';
import { getNodeErrorCode } from '../utils/errors.js';
import { readText } from '../utils/fs.js';
import { normalizeEngineRelativeInput } from './re-export-scan.js';

/**
 * Validates every retirement before any patch is written; typos never
 * silently grant a carve-out. Two shapes retire a file from its one
 * selected owner:
 *
 *  - a file the patch created (`new file mode` section), now absent from
 *    disk and untracked in engine HEAD;
 *  - an upstream file the patch modified or deleted, whose engine copy is
 *    back at HEAD (present, tracked, no diff). A scan-less re-export keeps
 *    `filesAffected` as it is, so without this the stale entry would stay
 *    in the manifest and in the reserved-range policy check.
 */
export async function validateExpectedRemovals(
  paths: ProjectPaths,
  patches: PatchMetadata[],
  options: ReExportOptions,
  queue: readonly PatchMetadata[] = patches
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
  const dirty = new Set(await getDirtyFiles(paths.engine, [...tracked]));
  for (const file of removed) {
    const owners = patches.filter((patch) => patch.filesAffected.includes(file));
    const owner = owners[0];
    if (owners.length !== 1 || owner === undefined) {
      throw new InvalidArgumentError(
        `--expect-removed ${file} must be owned by exactly one selected patch.` +
          unselectedOwnerHint(file, patches, queue),
        '--expect-removed'
      );
    }
    const section = parseDiffSections(await readText(join(paths.patches, owner.filename))).find(
      (candidate) => candidate.targetPath === file
    );
    if (tracked.has(file)) {
      assertUpstreamFileBackAtHead(file, owner, section !== undefined && !section.isNewFile, dirty);
    } else {
      await assertCreatedFileAbsent(paths, file, owner, section?.isNewFile === true);
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

/**
 * Each path retires from its own owner, so one run may retire paths from
 * several selected patches. A path whose owner was left out of the
 * selection names that owner, since adding it is the usual fix.
 */
function unselectedOwnerHint(
  file: string,
  selected: readonly PatchMetadata[],
  queue: readonly PatchMetadata[]
): string {
  const selectedNames = new Set(selected.map((patch) => patch.filename));
  const outside = queue
    .filter((patch) => !selectedNames.has(patch.filename) && patch.filesAffected.includes(file))
    .map((patch) => patch.filename);
  if (outside.length === 0) return '';
  return ` It is owned by ${outside.join(', ')}, which this run did not select; add it to the selection to retire both in one run.`;
}

async function assertCreatedFileAbsent(
  paths: ProjectPaths,
  file: string,
  owner: PatchMetadata,
  createdByOwner: boolean
): Promise<void> {
  if (await removalPathPresent(join(paths.engine, file))) {
    throw new InvalidArgumentError(
      `--expect-removed ${file} is untracked in engine HEAD and still present on disk; ` +
        'a patch-created file can be retired only once it is deleted.',
      '--expect-removed'
    );
  }
  if (!createdByOwner) {
    throw new InvalidArgumentError(
      `--expect-removed ${file} was not created by its selected patch ${owner.filename}.`,
      '--expect-removed'
    );
  }
}

function assertUpstreamFileBackAtHead(
  file: string,
  owner: PatchMetadata,
  changedByOwner: boolean,
  dirty: ReadonlySet<string>
): void {
  if (dirty.has(file)) {
    throw new InvalidArgumentError(
      `--expect-removed ${file} is tracked in engine HEAD, but its engine copy still differs ` +
        'from HEAD. Restore the HEAD copy first, then retire it.',
      '--expect-removed'
    );
  }
  if (!changedByOwner) {
    throw new InvalidArgumentError(
      `--expect-removed ${file} is not changed by its selected patch ${owner.filename}.`,
      '--expect-removed'
    );
  }
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
