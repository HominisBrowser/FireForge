// SPDX-License-Identifier: EUPL-1.2
/**
 * New-file creators map for the patch queue, split out of
 * `patch-lint-cross.ts` to stay under the per-file line budget.
 * Re-exported from there so callers keep importing from `patch-lint.ts`
 * unchanged.
 *
 * Memoised per context object: ownership resolution and cache-key
 * fingerprints call this 2-3× per linted patch, and each call otherwise
 * re-runs `detectNewFilesInDiff` over EVERY queue entry's diff. Keyed weakly
 * so a discarded context frees its map; a caller that mutates a context
 * entry in place must call {@link invalidateNewFileCreatorsCache}.
 */

import { detectNewFilesInDiff } from './patch-lint-diff.js';
import type { PatchQueueBodyEntry, PatchQueueView } from './patch-lint-queue-types.js';

/** The slice of a queue context the creators map is derived from. */
type CreatorsContext = PatchQueueView<PatchQueueBodyEntry>;

const newFileCreatorsMemo = new WeakMap<CreatorsContext, Map<string, string[]>>();

/** Drops the memoised creators map after an in-place context entry update. */
export function invalidateNewFileCreatorsCache(ctx: CreatorsContext): void {
  newFileCreatorsMemo.delete(ctx);
}

/**
 * Returns the raw `path → patches[]` map of files created in `new file
 * mode` by at least one patch in the queue. Paths created by only one
 * patch are also included so callers can distinguish "no creator" from
 * "exactly one creator" without re-scanning the diffs. The returned map
 * is memoised and shared — treat it as read-only.
 */
export function collectNewFileCreatorsByPath(ctx: CreatorsContext): Map<string, string[]> {
  const memoised = newFileCreatorsMemo.get(ctx);
  if (memoised) return memoised;
  const creators = new Map<string, string[]>();
  for (const entry of ctx.entries) {
    const newFiles = detectNewFilesInDiff(entry.diff);
    for (const file of newFiles) {
      let owners = creators.get(file);
      if (!owners) {
        owners = [];
        creators.set(file, owners);
      }
      owners.push(entry.filename);
    }
  }
  newFileCreatorsMemo.set(ctx, creators);
  return creators;
}
