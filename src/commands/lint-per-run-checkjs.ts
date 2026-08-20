// SPDX-License-Identifier: EUPL-1.2
/**
 * Per-run checkJs program controller, shared by `lint --per-patch` and
 * `re-export`.
 *
 * The dominant fixed cost of patch lint is one `ts.createProgram` over the
 * queue's patch-owned `.sys.mjs` files (~37 s on a 290-patch consumer
 * queue). This controller builds that program at most ONCE per command
 * invocation (lazily, promise-memoised) and lets callers slice per-patch
 * findings out of the grouped result. Three levers keep the cost paid only
 * when it buys something:
 *
 * - **Lazy build**: nothing is built until the first cache miss asks.
 * - **Root scoping** (`rootScopePatches`): with `--patches <subset>` the
 *   program's roots are only the subset's owned files; the full queue
 *   stays resolvable, so cross-patch imports type-check identically while
 * unrelated files are never parsed.
 * - **Warm-run probe**: run-level ("global") checkJs findings come only
 *   from a missing `typescript` package or an unreadable shim — never
 *   from the built program — so an all-cache-hit run satisfies "warm
 * never reports less than cold" via
 *   `probeCheckJsGlobalIssues` instead of building anything.
 */

import type { getProjectPaths, loadConfig } from '../core/config.js';
import {
  type GroupedCheckJsResult,
  invokePatchLintCheckJsGrouped,
  probeCheckJsGlobalIssues,
  runCheckJsTestFilesGrouped,
} from '../core/patch-lint-checkjs.js';
import type { PatchQueueContext } from '../core/patch-lint-cross.js';
import {
  isTestScriptFile,
  resolvePatchOwnedSysMjs,
  resolvePatchOwnedTestScripts,
} from '../core/patch-lint-ownership.js';
import type { PatchLintIssue } from '../types/commands/index.js';

/**
 * Queue-wide checkJs program built once per run and sliced per patch, so a
 * single type regression surfaces once against its owning patch instead of
 * being duplicated for every patch in the queue.
 */
export interface PerRunCheckJs {
  /** Patch filename → the checkJs-relevant files that patch creates. */
  ownedByPatch: Map<string, Set<string>>;
  /** Every checkJs-relevant file in the queue (sys + test scripts) — the
   *  resolution universe the program can see. Callers use it to detect
   *  files the hoisted program has never heard of (fresh `--scan`
   *  adoptions) and fall back to a per-patch build. */
  resolutionSet: ReadonlySet<string>;
  /** Builds (once, lazily on first cache miss) and returns the grouped run.
   *  Promise-memoised so the bounded per-patch pool builds the program exactly
   *  once even when several patches reach it concurrently. */
  getGrouped: () => Promise<GroupedCheckJsResult>;
  /** Run-level checkJs errors (e.g. TypeScript missing). When the program
   *  was never built (all-warm run) this probes the two global failure
   * sources directly instead of building it holds because the
   *  built program never contributes globals of its own. */
  getGlobal: () => Promise<PatchLintIssue[]>;
  /** The byFile slices for `files` (globals deliberately EXCLUDED — they
   *  are run-level, never cached, and emitted once per invocation via
   *  `getGlobal`). Feed to `LintExportedPatchOptions.precomputedCheckJs`. */
  sliceFor: (files: ReadonlySet<string>) => Promise<PatchLintIssue[]>;
  /** True when this file kind participates in the run's checkJs surface
   *  (`.sys.mjs`, plus test scripts when `checkJsTestFiles` is on). */
  isRelevant: (file: string) => boolean;
}

/**
 * Builds the per-run checkJs program controller when `patchLint.checkJs` is
 * enabled, or returns undefined. With `rootScopePatches` set (the
 * `--patches` subset, by patch filename), the program roots at only the
 * subset's owned files and the test-file pass runs only the subset's own
 * scripts (head.js discovery still spans the queue).
 */
export function buildPerRunCheckJs(
  projectRoot: string,
  paths: ReturnType<typeof getProjectPaths>,
  config: Awaited<ReturnType<typeof loadConfig>>,
  ctx: PatchQueueContext,
  rootScopePatches?: ReadonlySet<string>
): PerRunCheckJs | undefined {
  const patchLint = config.patchLint;
  if (!patchLint?.checkJs) return undefined;
  const testFilesEnabled = patchLint.checkJsTestFiles === true;

  const ownedByPatch = new Map<string, Set<string>>();
  for (const entry of ctx.entries) {
    const owned = new Set<string>();
    for (const f of entry.newFiles.keys()) {
      if (f.endsWith('.sys.mjs')) owned.add(f);
      else if (testFilesEnabled && isTestScriptFile(f)) owned.add(f);
    }
    if (owned.size > 0) ownedByPatch.set(entry.filename, owned);
  }

  const resolutionSet = new Set<string>();
  for (const files of ownedByPatch.values()) {
    for (const f of files) resolutionSet.add(f);
  }

  // The subset's owned files, split by program kind; undefined = full queue.
  let scopedRoots: Set<string> | undefined;
  if (rootScopePatches !== undefined) {
    scopedRoots = new Set();
    for (const [patchFilename, files] of ownedByPatch) {
      if (!rootScopePatches.has(patchFilename)) continue;
      for (const f of files) scopedRoots.add(f);
    }
  }

  // One build for the whole run: the queue-wide `.sys.mjs` program plus —
  // when `patchLint.checkJsTestFiles` is on — one small
  // script-scope program per patch-owned test file, merged by file.
  const buildAll = async (): Promise<GroupedCheckJsResult> => {
    const sys = await invokePatchLintCheckJsGrouped(
      paths.engine,
      resolvePatchOwnedSysMjs(new Set(), ctx),
      patchLint,
      projectRoot,
      scopedRoots
    );
    if (!testFilesEnabled) return sys;
    const tests = await runCheckJsTestFilesGrouped(
      paths.engine,
      resolvePatchOwnedTestScripts(new Set(), ctx),
      patchLint,
      projectRoot,
      scopedRoots
    );
    const byFile = new Map(sys.byFile);
    for (const [rel, list] of tests.byFile) {
      byFile.set(rel, [...(byFile.get(rel) ?? []), ...list]);
    }
    return { byFile, global: [...sys.global, ...tests.global] };
  };

  // Memoise the *promise*, not the resolved value: under the bounded pool
  // several patches can reach `getGrouped` before the first build resolves, and
  // `??=` on the promise (a synchronous expression) guarantees a single build.
  let groupedPromise: Promise<GroupedCheckJsResult> | undefined;
  const getGrouped = (): Promise<GroupedCheckJsResult> => (groupedPromise ??= buildAll());
  return {
    ownedByPatch,
    resolutionSet,
    getGrouped,
    getGlobal: async () =>
      groupedPromise !== undefined
        ? (await groupedPromise).global
        : probeCheckJsGlobalIssues(patchLint, projectRoot),
    sliceFor: async (files) => {
      const grouped = await getGrouped();
      const issues: PatchLintIssue[] = [];
      for (const rel of files) {
        issues.push(...(grouped.byFile.get(rel) ?? []));
      }
      return issues;
    },
    isRelevant: (file) => file.endsWith('.sys.mjs') || (testFilesEnabled && isTestScriptFile(file)),
  };
}
