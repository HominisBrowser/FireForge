// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { getProjectPaths, loadConfig } from '../core/config.js';
import { assertEngineGitReady } from '../core/engine-precondition.js';
import { furnaceConfigExists, loadFurnaceConfig } from '../core/furnace-config.js';
import { expandUntrackedDirectoryEntries, getWorkingTreeStatus } from '../core/git-status.js';
import { measureTokenCoverage } from '../core/token-coverage.js';
import { getTokensCssPath } from '../core/token-manager.js';
import { toError } from '../utils/errors.js';
import { pathExists, readText } from '../utils/fs.js';
import { info, intro, outro, success, warn } from '../utils/logger.js';

interface TokenSourceValidation {
  file: string;
  tokenDeclarations: number;
  unknownDeclarations: string[];
}

/**
 * Measures design token coverage across modified CSS files.
 * @param projectRoot - Root directory of the project
 */
export async function tokenCoverageCommand(projectRoot: string): Promise<void> {
  intro('Token Coverage');

  const paths = getProjectPaths(projectRoot);

  await assertEngineGitReady(paths.engine);

  const config = await loadConfig(projectRoot);
  const tokensCssPath = getTokensCssPath(config.binaryName);

  // Expand collapsed `?? dir/` untracked entries so untracked CSS files
  // inside a new patch-added directory are included in coverage. Before
  // this, an imported fork that added a new CSS tree saw "No modified
  // CSS files" because `git status --porcelain` collapsed the directory
  // and the file-extension filter could not see the .css inside.
  const rawStatus = await getWorkingTreeStatus(paths.engine);
  const expandedStatus = await expandUntrackedDirectoryEntries(paths.engine, rawStatus);
  const statusTokenCssFiles = expandedStatus
    .filter((f) => f.file === tokensCssPath)
    .map((f) => f.file);
  const statusCssFiles = expandedStatus
    .filter((f) => f.file.endsWith('.css') && f.file !== tokensCssPath)
    .map((f) => f.file);

  // Also scan CSS files deployed by Furnace custom components. Deployed
  // files can be committed (and therefore absent from `git status`) while
  // still being the primary surface where token adoption matters. Looking
  // only at modified files silently undercounts projects where Furnace
  // writes many component-CSS files into the engine.
  const furnaceCssFiles = await collectFurnaceCustomCssFiles(
    projectRoot,
    paths.engine,
    tokensCssPath
  );

  // De-dupe so a file that is both a custom deploy target and modified is
  // scanned exactly once.
  const cssFiles = [...new Set([...statusCssFiles, ...furnaceCssFiles])];
  const tokenSourceFiles = [...new Set(statusTokenCssFiles)];

  if (cssFiles.length === 0 && tokenSourceFiles.length === 0) {
    info('No modified CSS files');
    outro('Nothing to measure');
    return;
  }

  const tokenPrefix = await resolveTokenPrefix(projectRoot, config.binaryName);
  const tokenSourceResults = await validateTokenSourceFiles(
    paths.engine,
    tokenSourceFiles,
    tokenPrefix
  );

  for (const result of tokenSourceResults) {
    const detail = `${result.tokenDeclarations} token declaration${result.tokenDeclarations === 1 ? '' : 's'}`;
    if (result.unknownDeclarations.length === 0) {
      success(`${result.file}  token source valid (${detail})`);
    } else {
      warn(
        `${result.file}  token source has ${result.unknownDeclarations.length} declaration${result.unknownDeclarations.length === 1 ? '' : 's'} outside prefix ${tokenPrefix}: ${result.unknownDeclarations.join(', ')}`
      );
    }
  }

  if (cssFiles.length === 0) {
    outro(
      `${tokenSourceResults.length} token source file${tokenSourceResults.length === 1 ? '' : 's'} validated`
    );
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

async function resolveTokenPrefix(projectRoot: string, binaryName: string): Promise<string> {
  try {
    const furnaceConfig = await loadFurnaceConfig(projectRoot);
    if (furnaceConfig.tokenPrefix) {
      return furnaceConfig.tokenPrefix;
    }
  } catch {
    // Fall through to the convention used by furnace init. A broken
    // furnace.json is already surfaced by collectFurnaceCustomCssFiles.
  }
  return `--${binaryName}-`;
}

async function validateTokenSourceFiles(
  engineDir: string,
  tokenSourceFiles: string[],
  tokenPrefix: string
): Promise<TokenSourceValidation[]> {
  const results: TokenSourceValidation[] = [];
  for (const file of tokenSourceFiles) {
    const filePath = join(engineDir, file);
    if (!(await pathExists(filePath))) continue;

    const css = (await readText(filePath)).replace(/\/\*[\s\S]*?\*\//g, '');
    const declarations = new Set<string>();
    const declarationPattern = /(^|[;{\s])(--[\w-]+)\s*:/g;
    let match: RegExpExecArray | null;
    while ((match = declarationPattern.exec(css)) !== null) {
      const declaration = match[2];
      if (declaration) declarations.add(declaration);
    }

    const tokenDeclarations = [...declarations].filter((name) => name.startsWith(tokenPrefix));
    const unknownDeclarations = [...declarations]
      .filter((name) => !name.startsWith(tokenPrefix))
      .sort();

    results.push({
      file,
      tokenDeclarations: tokenDeclarations.length,
      unknownDeclarations,
    });
  }
  return results;
}

/**
 * Returns engine-relative `.css` paths deployed by every Furnace custom
 * component registered in `furnace.json`. Only files that actually exist
 * on disk are included. A component whose deploy target is missing (e.g.
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
      `Could not load furnace.json for token coverage — scanning modified files only (${toError(error).message})`
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
