// SPDX-License-Identifier: EUPL-1.2
/**
 * The one place that asks which mode a project is in. It turns either
 * storage into the owned-change set, gives a command its workspace and its
 * tracked-file writer, reports status and integrity in one shape, follows a
 * project's inputs during a watch, answers the diagnostics that differ by
 * mode, and holds the operations that cross the two storages or their
 * formats: exporting a source-mode project as a patch queue, migrating a
 * patch-mode project to source mode, upgrading a project of the previous
 * format, and moving either to a new Firefox pin.
 */
export {
  lintSubject,
  mutationRoots,
  ownedChanges,
  type OwnedFiles,
  ownedFiles,
  typeCacheDir,
} from './changes.js';
export { diagnose, type Diagnosis } from './diagnose.js';
export { exportChanges } from './export.js';
export { migrate } from './migrate.js';
export { download, pinnedPristine } from './pristine.js';
export { rebase } from './rebase.js';
export { status, verify, verifyOutcome } from './report.js';
export { createProject, type ProjectSpec, refuseExistingProject } from './setup.js';
export { editTracked, enginePathOf, trackedFiles } from './tracked.js';
export { upgrade } from './upgrade.js';
export { watch } from './watch.js';
export {
  deployComponents,
  listAllWorkspaces,
  requireCurrentTyping,
  withOwnedRead,
  withWorkspace,
  withWorkspaceOnDemand,
} from './workspace.js';
