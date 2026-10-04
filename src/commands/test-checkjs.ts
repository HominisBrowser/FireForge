// SPDX-License-Identifier: EUPL-1.2
import { runCheckJsTestFilesGrouped } from '../core/patch-lint-checkjs.js';
import { isTestScriptFile } from '../core/patch-lint-ownership.js';
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
  for (const file of selected) owned.add(file);
  const result = await runCheckJsTestFilesGrouped(
    paths.engine,
    owned,
    config.patchLint,
    paths.root,
    selected
  );
  const issues = [...result.global, ...[...result.byFile.values()].flat()];
  for (const issue of issues) notice(`Pre-build checkJs: ${issue.file}: ${issue.message}`);
  if (issues.some((issue) => issue.severity === 'error')) {
    throw new GeneralError(
      'Named test files failed the configured patch checkJs pass before build. Fix the type errors above before running the proof.'
    );
  }
}
