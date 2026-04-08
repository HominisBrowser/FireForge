// SPDX-License-Identifier: EUPL-1.2
import { getProjectPaths, loadConfig } from '../core/config.js';
import { getStatusWithCodes, isGitRepository } from '../core/git.js';
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

  const files = await getStatusWithCodes(paths.engine);
  const cssFiles = files
    .filter((f) => f.file.endsWith('.css') && f.file !== tokensCssPath)
    .map((f) => f.file);

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
