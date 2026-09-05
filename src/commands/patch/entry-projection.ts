// SPDX-License-Identifier: EUPL-1.2
import type { PatchQueueEntry } from '../../core/patch-lint.js';
import { buildModifiedFileAdditionsFromDiff } from '../../core/patch-lint.js';
import { detectNewFilesInDiff } from '../../core/patch-lint-diff.js';
import { buildNewFileTextProjection } from '../../core/patch-transform.js';

/**
 * Projects a rewritten patch body into the three fields cross-patch lint reads
 * off a queue entry.
 *
 * `patch split` and `patch move-files` each had a byte-identical copy of this
 * (`buildEntryProjection` / `projectEntryBody`). Both feed the same linter, so
 * a change to what the projection carries has to reach both or the two
 * commands start refusing different things for the same queue.
 * @param diff - The rewritten patch body.
 * @returns The diff plus its derived new-file and modified-file projections.
 */
export function projectEntryBody(
  diff: string
): Pick<PatchQueueEntry, 'diff' | 'newFiles' | 'createdFiles' | 'modifiedFileAdditions'> {
  const newFiles = buildNewFileTextProjection(diff);
  return {
    diff,
    newFiles,
    // Body-kind agnostic: a binary creation is still a creation.
    createdFiles: detectNewFilesInDiff(diff),
    modifiedFileAdditions: buildModifiedFileAdditionsFromDiff(diff),
  };
}
