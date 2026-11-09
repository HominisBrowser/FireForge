// SPDX-License-Identifier: EUPL-1.2
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { authoredGateContext, checkAuthoredTypes } from '../core/authored-gates.js';
import {
  findUnownedSupportHeads,
  formatUnownedSupportHeadNotice,
} from '../core/checkjs-support-heads.js';
import { listTrackedInHead } from '../core/git-file-ops.js';
import { buildPatchQueueContext } from '../core/patch-lint.js';
import { runCheckJsTestFilesGrouped } from '../core/patch-lint-checkjs.js';
import { isTestScriptFile, resolvableModulesForTests } from '../core/patch-lint-ownership.js';
import { loadPatchesManifest } from '../core/patch-manifest.js';
import { analyzeTestPathScopes } from '../core/test-path-scope.js';
import { GeneralError } from '../errors/base.js';
import type { FireForgeConfig, ProjectPaths } from '../types/config.js';
import { notice } from '../utils/logger.js';

/** Runs the configured patch test checkJs pass before paying for a proving build. */
export async function checkRequestedTestTypes(
  paths: ProjectPaths,
  config: FireForgeConfig,
  requested: string[]
): Promise<void> {
  if (config.sources !== undefined) {
    const issues = await checkAuthoredTypes(await authoredGateContext(paths.root));
    for (const issue of issues) notice(`Pre-build source checkJs: ${issue.file}: ${issue.message}`);
    if (issues.some((issue) => issue.severity === 'error'))
      throw new GeneralError('Captured authored source failed strict typechecking before build.');
    return;
  }
  if (
    config.patchLint?.checkJs !== true ||
    config.patchLint.checkJsTestFiles !== true ||
    requested.length === 0
  )
    return;
  const manifest = await loadPatchesManifest(paths.patches);
  const owned = new Set(
    manifest?.patches.flatMap((patch) => patch.filesAffected.filter(isTestScriptFile)) ?? []
  );
  const scopes = await analyzeTestPathScopes(paths.engine, requested);
  const selected = new Set(scopes.flatMap((scope) => scope.dispatchPaths.filter(isTestScriptFile)));
  let upstream = new Set<string>();
  try {
    upstream = await listTrackedInHead(paths.engine, [...selected]);
  } catch {
    // An unknown baseline cannot establish an upstream exemption; retain strict checking.
  }
  for (const file of upstream) {
    const content = await readFile(join(paths.engine, file), 'utf8');
    if (/@ts-check\b/.test(content)) continue;
    selected.delete(file);
    notice(
      `Pre-build checkJs: ${file} is an untyped upstream test; the patch-created-test pass does not redefine its typing contract. Configured project typechecks still apply.`
    );
  }
  if (selected.size === 0) return;
  for (const file of selected) owned.add(file);
  // A support head a named test brings into scope joins the pass even
  // before any patch owns it, or every name it declares reads as undefined.
  for (const head of await findUnownedSupportHeads(paths.engine, selected, owned)) {
    owned.add(head.file);
    notice(`Pre-build checkJs: ${formatUnownedSupportHeadNotice(head)}`);
  }
  const result = await runCheckJsTestFilesGrouped(
    paths.engine,
    owned,
    config.patchLint,
    paths.root,
    selected,
    resolvableModulesForTests(await buildPatchQueueContext(paths.patches))
  );
  const issues = [...result.global, ...[...result.byFile.values()].flat()];
  for (const issue of issues) notice(`Pre-build checkJs: ${issue.file}: ${issue.message}`);
  if (issues.some((issue) => issue.severity === 'error')) {
    throw new GeneralError(
      'Named test files failed the configured patch checkJs pass before build. Fix the type errors above before running the proof.'
    );
  }
}
