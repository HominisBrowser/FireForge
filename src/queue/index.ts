// SPDX-License-Identifier: EUPL-1.2
/**
 * Patch mode: the patch queue in `patches/` and the engine it applies to.
 *
 * - The manifest (`manifest.ts`) is the one source of truth for the queue's
 *   patches, their order and metadata; filenames, categories and touched
 *   files are derived.
 * - Every change to the queue is one transaction ({@link mutateQueue}).
 * - Every patch application goes through `apply.ts`: index-only replays
 *   onto trees, with the reduced-context ladder and new-file replacement as
 *   options, plus the working-tree apply that leaves `.rej` files.
 * - The baseline (`baseline.ts`) is what the engine holds with the queue
 *   applied, and how the engine compares with it. Every change to engine
 *   files is one transaction on the engine journal.
 * - `import` and `rebase` are one resumable session (`session.ts`).
 * - `export` and `re-export` capture engine edits (`capture.ts`); the
 *   queue operations (`operations.ts`) rename, reorder, split, merge,
 *   remove and annotate patches, and those that only move work around
 *   prove the queue still produces the same tree.
 * - Where a patch goes, and the ordering half of `patchPolicy`, is
 *   `placement.ts`.
 * - Every patch body is produced by {@link regeneratePatchBody}.
 *
 * Commands that change the engine or the queue hold the engine lock
 * exclusively (`withEngineLock` of the engine module); the functions here assume it.
 */
import { ExitCode } from '../kernel/errors.js';
import type { PatchProject, Project } from '../project/index.js';
import { queueError } from './queue.js';

export { replayQueue } from './apply.js';
export { type EnginePath, regeneratePatchBody } from './baseline.js';
export { exportPatch, reExport } from './capture.js';
export { engineChanges, queueChanges } from './changes.js';
export { type LintIgnoreEntry, type PatchEntry } from './manifest.js';
export {
  compactQueue,
  deletePatch,
  moveFiles,
  type QueueEdit,
  renamePatch,
  reorderPatch,
  retirePatch,
  setPatchMeta,
  splitPatch,
  stagedDependencyOf,
} from './operations.js';
export { type Placement } from './placement.js';
export { mutateQueue, type Queue, type QueuePatch, readQueue, writeQueue } from './queue.js';
export { discard, enginePaths, resetEngine } from './restore.js';
export { importQueue, rebaseQueue, type RebaseResult, resolvePatchFromEngine } from './session.js';
export { queueStatus, verifyQueue } from './status.js';

/**
 * The project as a patch-mode project, for the commands only patch mode has.
 *
 * @param project - A loaded project
 * @throws `patch-mode-required` (exit code 8) for a source-mode project
 */
export function requirePatchMode(project: Project): PatchProject {
  if (project.mode === 'patches') return project;
  throw queueError(
    'patch-mode-required',
    'This command works on a patch-mode project only.',
    'A source-mode project keeps its owned files under the source root; edit them there.',
    ExitCode.INVALID_ARGUMENT
  );
}
