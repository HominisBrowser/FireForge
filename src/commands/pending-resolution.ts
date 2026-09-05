// SPDX-License-Identifier: EUPL-1.2
import { updateState } from '../core/config.js';

/**
 * Clears `pendingResolution` from `state.json` transactionally.
 *
 * Five commands (`doctor --clear-resolution`, `resolve`, `rebase --continue`,
 * `rebase --abort`, and the rebase patch loop) had each copied the same
 * spread-then-`delete` updater. The clear routes through `updateState` instead
 * of a load/modify/save pair so the updater runs inside the state-file lock
 * against the freshest on-disk state: a concurrent write to an unrelated key
 * (`buildMode`, `baseCommit`) is then not clobbered by a stale reload. Keeping
 * it in one place stops the copies from drifting apart.
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
