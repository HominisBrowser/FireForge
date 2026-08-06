// SPDX-License-Identifier: EUPL-1.2
/**
 * Patch ownership resolution for JS-shaped files.
 *
 * A file is "patch-owned" when it was created by the project's patch
 * queue rather than being an upstream Firefox file that happens to be
 * modified. This module computes the set of patch-owned paths so lint
 * rules can scope enforcement to project code only.
 *
 * The two resolvers are kept separate (one per extension predicate)
 * because the downstream rules differ: `.sys.mjs` files go through
 * `runCheckJs` (TypeScript checkJs) and the export-walker JSDoc rule;
 * chrome subscripts (`.js` non-`.sys.mjs`) only get the script-walker
 * JSDoc rule. Mixing them in a single set would silently broaden
 * `runCheckJs` to chrome subscripts, which it is not designed for.
 */

import type { PatchQueueContext } from './patch-lint-cross.js';
import { collectNewFileCreatorsByPath } from './patch-lint-cross.js';

/**
 * Returns the set of patch-owned files matching `predicate`. Internal
 * helper shared by the per-extension resolvers below.
 */
function resolveOwned(
  currentNewFiles: Set<string>,
  patchQueueCtx: PatchQueueContext | undefined,
  predicate: (file: string) => boolean
): Set<string> {
  const owned = new Set<string>();

  for (const file of currentNewFiles) {
    if (predicate(file)) {
      owned.add(file);
    }
  }

  if (patchQueueCtx) {
    const creators = collectNewFileCreatorsByPath(patchQueueCtx);
    for (const [file, owners] of creators) {
      if (predicate(file) && owners.length > 0) {
        owned.add(file);
      }
    }
  }

  return owned;
}

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
  return resolveOwned(currentNewFiles, patchQueueCtx, (file) => file.endsWith('.sys.mjs'));
}

/**
 * Returns the set of file paths that are patch-owned chrome subscripts
 * (`.js` files that are not `.sys.mjs` modules — typically
 * `browser/base/content/<binaryName>*.js` and similar). Same ownership
 * semantics as {@link resolvePatchOwnedSysMjs}.
 *
 * @param currentNewFiles - Files newly created in the current diff
 * @param patchQueueCtx - Optional cross-patch context for queue-wide ownership
 * @returns Set of patch-owned chrome-subscript file paths
 */
export function resolvePatchOwnedChromeScripts(
  currentNewFiles: Set<string>,
  patchQueueCtx?: PatchQueueContext
): Set<string> {
  return resolveOwned(
    currentNewFiles,
    patchQueueCtx,
    (file) => file.endsWith('.js') && !file.endsWith('.sys.mjs')
  );
}

/**
 * Test-script predicate for the `checkJsTestFiles` pass (FORGE G5):
 * plain `.js` files (not `.sys.mjs` modules) that live under a `/test/`
 * path or carry a `browser_` / `test_` / `xpcshell_` basename. Duplicates
 * `patch-lint.ts`'s `isTestFile` shape rather than importing it —
 * patch-lint.ts imports this module, so the reverse edge would create an
 * import cycle (dpdm gate). The agreement is pinned by
 * `patch-lint-ownership.test.ts`.
 */
export function isTestScriptFile(file: string): boolean {
  if (!file.endsWith('.js') || file.endsWith('.sys.mjs')) return false;
  if (file.includes('/test/')) return true;
  const basename = file.split('/').pop() ?? '';
  return /^(?:browser_|test_|xpcshell_).*\.js$/.test(basename);
}

/**
 * Returns the set of patch-owned test `.js` files (FORGE G5). Same
 * ownership semantics as {@link resolvePatchOwnedSysMjs}; consumed by the
 * `patchLint.checkJsTestFiles` pass, which checks each as its own small
 * script-scope program.
 *
 * @param currentNewFiles - Files newly created in the current diff
 * @param patchQueueCtx - Optional cross-patch context for queue-wide ownership
 * @returns Set of patch-owned test-script file paths
 */
export function resolvePatchOwnedTestScripts(
  currentNewFiles: Set<string>,
  patchQueueCtx?: PatchQueueContext
): Set<string> {
  return resolveOwned(currentNewFiles, patchQueueCtx, isTestScriptFile);
}
