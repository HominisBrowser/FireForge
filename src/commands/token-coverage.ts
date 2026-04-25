// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { getProjectPaths, loadConfig } from '../core/config.js';
import { furnaceConfigExists, loadFurnaceConfig } from '../core/furnace-config.js';
import { isGitRepository } from '../core/git.js';
import { expandUntrackedDirectoryEntries, getWorkingTreeStatus } from '../core/git-status.js';
import { measureTokenCoverage } from '../core/token-coverage.js';
import { getTokensCssPath } from '../core/token-manager.js';
import { GeneralError } from '../errors/base.js';
import { pathExists } from '../utils/fs.js';
import { info, intro, outro, success, warn } from '../utils/logger.js';

/**
 * Measures design token coverage across modified CSS files.
 * @param projectRoot - Root directory of the project
 */
export async function tokenCoverageCommand(projectRoot: string): Promise<void> {
  intro('Token Coverage');

  const paths = getProjectPaths(projectRoot);

  if (!(await pathExists(paths.engine))) {
    throw new GeneralError('Firefox source not found. Run "fireforge download" first.');
  }

  if (!(await isGitRepository(paths.engine))) {
    throw new GeneralError(
      'Engine directory is not a git repository. Run "fireforge download" to initialize.'
    );
  }

  const config = await loadConfig(projectRoot);
  const tokensCssPath = getTokensCssPath(config.binaryName);

  // Expand collapsed `?? dir/` untracked entries so untracked CSS files
  // inside a new patch-added directory are included in coverage. Before
  // this, an imported fork that added a new CSS tree saw "No modified
  // CSS files" because `git status --porcelain` collapsed the directory
  // and the file-extension filter could not see the .css inside.
  const rawStatus = await getWorkingTreeStatus(paths.engine);
  const expandedStatus = await expandUntrackedDirectoryEntries(paths.engine, rawStatus);
  const statusCssFiles = expandedStatus
    .filter((f) => f.file.endsWith('.css') && f.file !== tokensCssPath)
    .map((f) => f.file);

  // Also scan CSS files deployed by Furnace custom components. Deployed
  // files can be committed (and therefore absent from `git status`) while
  // still being the primary surface where token adoption matters. Before
  // 0.16.0, coverage only looked at modified files, which silently
  // undercounted projects where Furnace writes many component-CSS files
  // into the engine and they are already tracked.
  const furnaceCssFiles = await collectFurnaceCustomCssFiles(
    projectRoot,
    paths.engine,
    tokensCssPath
  );

  // De-dupe so a file that is both a custom deploy target AND modified is
  // scanned exactly once.
  const cssFiles = [...new Set([...statusCssFiles, ...furnaceCssFiles])];

  if (cssFiles.length === 0) {
    info('No modified CSS files');
    outro('Nothing to measure');
    return;
  }

  const report = await measureTokenCoverage(paths.engine, cssFiles);

  // Per-file breakdown
  for (const entry of report.files) {
    const parts = [
      `tokens: ${entry.tokenUsages}`,
      `allowlisted: ${entry.allowlisted}`,
      `unknown: ${entry.unknownVars}`,
      `raw colors: ${entry.rawColors}`,
    ];
    info(`${entry.file}  ${parts.join(' | ')}`);
  }

  // Coverage calculation
  const denominator = report.tokenUsages + report.unknownVarUsages + report.rawColorCount;
  const coverage = denominator > 0 ? Math.round((report.tokenUsages / denominator) * 100) : 100;

  info('');

  const summary = `Token coverage: ${coverage}% (${report.tokenUsages} tokens / ${denominator} total) — ${report.rawColorCount} raw colors, ${report.unknownVarUsages} unknown vars`;

  if (coverage === 100 && report.rawColorCount === 0) {
    success(summary);
  } else {
    warn(summary);
  }

  outro(`${report.filesScanned} CSS file${report.filesScanned === 1 ? '' : 's'} scanned`);
}

/**
 * Returns engine-relative `.css` paths deployed by every Furnace custom
 * component registered in `furnace.json`. Only files that actually exist
 * on disk are included — a component whose deploy target is missing (e.g.
 * `furnace apply` has not run yet) is skipped silently so a fresh
 * `furnace init` followed immediately by `token coverage` does not error.
 *
 * Returns an empty array when the project has no furnace.json, no custom
 * components, or when loading the config fails (a warn is emitted in the
 * last case so the user can diagnose a broken furnace.json without losing
 * coverage results on the non-furnace CSS files).
 */
async function collectFurnaceCustomCssFiles(
  projectRoot: string,
  engineDir: string,
  tokensCssPath: string
): Promise<string[]> {
  if (!(await furnaceConfigExists(projectRoot))) {
    return [];
  }

  let furnaceConfig;
  try {
    furnaceConfig = await loadFurnaceConfig(projectRoot);
  } catch (error: unknown) {
    warn(
      `Could not load furnace.json for token coverage — scanning modified files only (${(error as Error).message})`
    );
    return [];
  }

  const results: string[] = [];
  for (const [componentName, customConfig] of Object.entries(furnaceConfig.custom)) {
    // Upstream Firefox widget layout: every component lives at
    // `toolkit/content/widgets/<tagName>/` and ships at least
    // `<tagName>.css`. `targetPath` already resolves to that directory
    // (the create command writes `toolkit/content/widgets/<name>` into
    // furnace.json) so we can probe the default layout directly without
    // walking the whole tree.
    const candidate = `${customConfig.targetPath}/${componentName}.css`;
    if (candidate === tokensCssPath) continue;
    const absolutePath = join(engineDir, candidate);
    if (await pathExists(absolutePath)) {
      results.push(candidate);
    }
  }
  return results;
}
