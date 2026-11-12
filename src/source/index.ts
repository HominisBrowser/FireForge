// SPDX-License-Identifier: EUPL-1.2
/**
 * Source mode: the project's owned files are tracked files under the source
 * root (`<source>/<path>` supplies engine file `<path>`), an upstream file
 * is touched only after its override record captures its upstream identity,
 * and the patch queue is generated output.
 *
 * Every function reads the checkout's working files directly (tracked files
 * and untracked files git does not ignore) and judges them against a
 * {@link Pristine} repository it is handed, which it only reads.
 */
export { type Adopted, adoptTrees } from './adopt.js';
export { sourceChanges, type SourceStatus, sourceStatus, verifySource } from './changes.js';
export { override, readSourceFile, requireSourceMode, restore, writeSourceFile } from './edit.js';
export { planQueueExport, type QueueExportPlan } from './export.js';
export { exportedPatchName } from './groups.js';
export { materialize, type MaterializeResult, recordDeployment } from './materialize.js';
export {
  completedAttributes,
  installMergeDriver,
  MERGE_DRIVER,
  mergeDriverCommand,
  runMergeDriver,
} from './merge.js';
export {
  parsePreviousWaivers,
  parseScopeDecisions,
  PREVIOUS_MERGE_DRIVER,
  PREVIOUS_METADATA_FILES,
  type PreviousWaiver,
  upgradeAttributes,
  upgradeRecord,
} from './previous.js';
export { refreshPin } from './refresh.js';
