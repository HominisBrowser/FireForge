// SPDX-License-Identifier: EUPL-1.2
/**
 * Patch ownership resolution for `.sys.mjs` files.
 *
 * A file is "patch-owned" when it was created by the project's patch
 * queue rather than being an upstream Firefox file that happens to be
 * modified. This module computes the set of patch-owned `.sys.mjs`
 * paths so lint rules can scope enforcement to project code only.
 */

import type { PatchQueueContext } from './patch-lint-cross.js';
import { collectNewFileCreatorsByPath } from './patch-lint-cross.js';

/**
 * Returns the set of file paths that are patch-owned `.sys.mjs` files.
 *
 * A file is patch-owned if:
 * 1. It is newly created in the current diff, OR
 * 2. It was created by an existing patch already in the queue.
 *
 * When no queue context is provided the result is limited to (1),
 * which matches the pre-ownership behavior and keeps callers that
 * do not have access to the patches directory working correctly.
 *
 * @param currentNewFiles - Files newly created in the current diff
 * @param patchQueueCtx - Optional cross-patch context for queue-wide ownership
 * @returns Set of patch-owned `.sys.mjs` file paths
 */
export function resolvePatchOwnedSysMjs(
  currentNewFiles: Set<string>,
  patchQueueCtx?: PatchQueueContext
): Set<string> {
  const owned = new Set<string>();

  for (const file of currentNewFiles) {
    if (file.endsWith('.sys.mjs')) {
      owned.add(file);
    }
  }

  if (patchQueueCtx) {
    const creators = collectNewFileCreatorsByPath(patchQueueCtx);
    for (const [file, owners] of creators) {
      if (file.endsWith('.sys.mjs') && owners.length > 0) {
        owned.add(file);
      }
    }
  }

  return owned;
}
