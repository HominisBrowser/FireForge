// SPDX-License-Identifier: EUPL-1.2
import { updateState } from '../core/config.js';
import type { FireForgeState } from '../types/config.js';

/**
 * Clears `pendingResolution` from `state.json` transactionally.
 *
 * Shared by `doctor --clear-resolution`, `resolve`, `rebase --continue`,
 * `rebase --abort` and the rebase patch loop. The clear routes through
 * `updateState` rather than a load/modify/save pair, so the updater runs inside
 * the state-file lock against the freshest on-disk state: a concurrent write to
 * an unrelated key (`buildMode`, `baseCommit`) is not clobbered by a stale
 * reload.
 *
 * A no-op when nothing is pending, so callers need no guard of their own.
 * @param projectRoot - Project root holding `.fireforge/state.json`.
 */
export async function clearPendingResolution(
  projectRoot: string,
  expected?: FireForgeState['pendingResolution']
): Promise<void> {
  await updateState(projectRoot, (current) => {
    if (
      expected !== undefined &&
      JSON.stringify(current.pendingResolution) !== JSON.stringify(expected)
    )
      throw new Error(
        'Pending resolution changed during validation; retaining the current marker.'
      );
    if (!current.pendingResolution) return current;
    const next = { ...current };
    delete next.pendingResolution;
    return next;
  });
}
