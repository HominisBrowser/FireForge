// SPDX-License-Identifier: EUPL-1.2
import { getFurnacePaths, loadFurnaceState } from '../core/furnace-config.js';
import { type FurnaceOperationContext, runFurnaceMutation } from '../core/furnace-operation.js';
import {
  createRollbackJournal,
  type RollbackJournal,
  snapshotFile,
} from '../core/furnace-rollback.js';

/** Doctor repairs share one lock, signal lifecycle and rollback boundary. */
export async function runDoctorFurnaceRepair<T>(
  root: string,
  repair: (context: FurnaceOperationContext, journal: RollbackJournal) => Promise<T>
): Promise<T> {
  return runFurnaceMutation(
    root,
    'apply-rollback',
    async (context) => {
      const journal = createRollbackJournal();
      context.registerJournal(journal);
      const paths = getFurnacePaths(root);
      const originalMarker = (await loadFurnaceState(root)).pendingRepair;
      let activeJournal = journal;
      await snapshotFile(journal, paths.furnaceConfig);
      await snapshotFile(journal, paths.furnaceState, { compareBeforeRestore: true });
      // apply owns a growing engine journal. Retain the repair's state/config
      // preimages when it installs that journal, before its first publication.
      const joined: FurnaceOperationContext = {
        ...context,
        registerJournal: (next) => {
          for (const [path, image] of journal.files)
            if (!next.files.has(path)) next.files.set(path, image);
          activeJournal = next;
          context.registerJournal(next);
        },
      };
      try {
        return await repair(joined, journal);
      } catch (error) {
        const currentMarker = (await loadFurnaceState(root)).pendingRepair;
        // A newer failed operation owns its marker. The failed Doctor body
        // must restore its engine changes without restoring an older state
        // file over that marker. The operation still fails and remains gated.
        if (currentMarker && JSON.stringify(currentMarker) !== JSON.stringify(originalMarker))
          activeJournal.files.delete(paths.furnaceState);
        throw error;
      }
    },
    { skipPendingRepairCheck: true }
  );
}
