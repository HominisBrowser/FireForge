// SPDX-License-Identifier: EUPL-1.2
import { updateState } from '../core/config.js';

/**
 * Clears `pendingResolution` from `state.json` transactionally.
 *
 * Five commands (`doctor --clear-resolution`, `resolve`, `rebase --continue`,
 * `rebase --abort`, and the rebase patch loop) had each copied the same
 * spread-then-`delete` updater. Routing the clear through `updateState` rather
 * than a load/modify/save pair is the load-bearing part: the updater runs
 * inside the state-file lock against the freshest on-disk state, so a
 * concurrent write to an unrelated key (`buildMode`, `baseCommit`) is not
 * clobbered by a stale reload. Copies of that reasoning drift; one does not.
 *
 * A no-op when nothing is pending, so callers need no guard of their own.
 * @param projectRoot - Project root holding `.fireforge/state.json`.
 */
export async function clearPendingResolution(projectRoot: string): Promise<void> {
  await updateState(projectRoot, (current) => {
    if (!current.pendingResolution) return current;
    const next = { ...current };
    delete next.pendingResolution;
    return next;
  });
}
