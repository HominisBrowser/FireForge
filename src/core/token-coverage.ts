// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import type { TokenCoverageFileEntry, TokenCoverageReport } from '../types/commands/index.js';
import { toError } from '../utils/errors.js';
import { pathExists, readText } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';
import { countRawCssColors } from '../utils/regex.js';
import { loadFurnaceConfig } from './furnace-config.js';

/**
 * Measures design token coverage across CSS files.
 *
 * Counts var(--{prefix}*) usages, allowlisted vars, unknown vars, and raw
 * color values. Reuses the same regex patterns as patch-lint.ts.
 *
 * @param repoDir - Absolute path to the engine (repository) directory
 * @param cssFiles - File paths (relative to repoDir) to scan
 * @returns Aggregate and per-file coverage report
 */
export async function measureTokenCoverage(
  repoDir: string,
  cssFiles: string[],
  projectRoot?: string
): Promise<TokenCoverageReport> {
  // Load furnace config gracefully
  let tokenPrefix: string | undefined;
  let tokenAllowlist: Set<string> | undefined;
  try {
    const root = projectRoot ?? join(repoDir, '..');
    const config = await loadFurnaceConfig(root);
    if (config.tokenPrefix) {
      tokenPrefix = config.tokenPrefix;
      tokenAllowlist = new Set(config.tokenAllowlist ?? []);
    }
  } catch (error: unknown) {
    verbose(
      `Proceeding without furnace token metadata because furnace.json could not be loaded: ${toError(error).message}`
    );
  }

  const entries: TokenCoverageFileEntry[] = [];

  for (const file of cssFiles) {
    const filePath = join(repoDir, file);
    if (!(await pathExists(filePath))) continue;

    const rawCss = await readText(filePath);
    // Strip block comments before scanning
    const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');

    // Count raw color values
    const rawColors = countRawCssColors(css);

    // Count custom property usages by category
    let tokenUsages = 0;
    let allowlisted = 0;
    let unknownVars = 0;

    const varPattern = /var\(\s*(--[\w-]+)/g;
    let match: RegExpExecArray | null;
    while ((match = varPattern.exec(css)) !== null) {
      const prop = match[1];
      if (!prop) continue;

      if (tokenPrefix && prop.startsWith(tokenPrefix)) {
        tokenUsages++;
      } else if (tokenAllowlist?.has(prop)) {
        allowlisted++;
      } else {
        unknownVars++;
      }
    }

    entries.push({ file, tokenUsages, allowlisted, unknownVars, rawColors });
  }

  return {
    filesScanned: entries.length,
    tokenUsages: entries.reduce((s, e) => s + e.tokenUsages, 0),
    allowlistedUsages: entries.reduce((s, e) => s + e.allowlisted, 0),
    unknownVarUsages: entries.reduce((s, e) => s + e.unknownVars, 0),
    rawColorCount: entries.reduce((s, e) => s + e.rawColors, 0),
    files: entries,
  };
}
