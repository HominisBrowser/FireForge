// SPDX-License-Identifier: EUPL-1.2
/**
 * CSS patch-lint rules: introduced raw color values and non-tokenized
 * custom-property references.
 *
 * Split out of `patch-lint.ts` so the per-patch and CSS rule bodies each
 * stay within the project's per-file line budget — the same separation
 * already applied to the JSDoc, observer, import, ownership, checkJs, and
 * cross-patch rule families. `patch-lint.ts` re-exports `lintPatchedCss`
 * so existing callers keep importing from the single module.
 */

import { join } from 'node:path';

import type { PatchLintIssue } from '../types/commands/index.js';
import type { FireForgeConfig } from '../types/config.js';
import { toError } from '../utils/errors.js';
import { pathExists, readText } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';
import { hasRawCssColors } from '../utils/regex.js';
import { loadFurnaceConfig } from './furnace-config.js';
import { extractAddedLinesPerFile } from './patch-lint-diff.js';

/** Furnace token-lint inputs, or undefined when furnace.json is unavailable. */
interface CssTokenContext {
  tokenPrefix: string;
  tokenAllowlist: Set<string>;
  runtimeVariables: Set<string>;
}

/**
 * Loads the furnace token-prefix lint inputs gracefully — returns
 * undefined (skipping the token-prefix check) when furnace.json cannot
 * be loaded or no tokenPrefix is configured.
 */
async function loadCssTokenContext(repoDir: string): Promise<CssTokenContext | undefined> {
  try {
    const root = join(repoDir, '..');
    const furnaceConfig = await loadFurnaceConfig(root);
    if (furnaceConfig.tokenPrefix) {
      return {
        tokenPrefix: furnaceConfig.tokenPrefix,
        tokenAllowlist: new Set(furnaceConfig.tokenAllowlist ?? []),
        runtimeVariables: new Set(furnaceConfig.runtimeVariables ?? []),
      };
    }
  } catch (error: unknown) {
    verbose(
      `Skipping furnace token-prefix lint hints because furnace.json could not be loaded: ${toError(error).message}`
    );
  }
  return undefined;
}

/**
 * Raw-color check for one patched CSS file, scoped to introduced lines
 * when diff context is available. Pushes onto `issues`.
 */
function checkRawColorValues(
  file: string,
  rawCss: string,
  addedLinesByFile: Map<string, string[]> | undefined,
  config: FireForgeConfig | undefined,
  issues: PatchLintIssue[]
): void {
  // Check only introduced raw color values when diff context is available.
  // Skip files on the raw-color allowlist (exact path or basename match) and
  // auto-exempt files under `browser/branding/` — those are the fork's
  // visual identity assets (app-about dialogs, installer pages, branded
  // CSS copied from Firefox's `unofficial` template) and belong to the
  // design-decision layer the design-token system does not govern.
  // Without this auto-exemption, every first-time setup's copied CSS
  // failed `raw-color-value` with no actionable fix other than manually
  // listing each path in `rawColorAllowlist`.
  const allowlist = config?.patchLint?.rawColorAllowlist;
  const isAllowlisted = allowlist?.some((entry) => file === entry || file.endsWith('/' + entry));
  const isBranding = file.startsWith('browser/branding/');

  if (!isAllowlisted && !isBranding) {
    // Strip lines with inline fireforge-ignore: raw-color-value suppression.
    // Check against rawCss (before comment stripping) so the CSS comment marker is still present.
    const sourceForSuppression = addedLinesByFile
      ? (addedLinesByFile.get(file) ?? []).join('\n')
      : rawCss;
    const suppressedContent = sourceForSuppression
      .split('\n')
      .filter((line) => !line.includes('fireforge-ignore: raw-color-value'))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '');

    if (hasRawCssColors(suppressedContent)) {
      issues.push({
        file,
        check: 'raw-color-value',
        message:
          'Raw color value found. Use CSS custom properties (var(--...)) for design token consistency.',
        severity: 'error',
      });
    }
  }
}

/**
 * Token-prefix check for one patched CSS file: flags `var(--x)` references
 * that match neither the configured prefix, the allowlist, the runtime
 * variables, nor a same-file declaration. Pushes onto `issues`.
 */
function checkTokenPrefixViolations(
  file: string,
  cssContent: string,
  addedLinesByFile: Map<string, string[]> | undefined,
  tokenContext: CssTokenContext | undefined,
  issues: PatchLintIssue[]
): void {
  // Check for non-tokenized custom properties. A variable that is both
  // declared and consumed inside the same file is auto-exempted as a
  // runtime state channel (see furnace.json → runtimeVariables).
  //
  // When diff context is available, scope the `var(...)` scan to
  // added/modified lines only. `cssContent` (full-file) is still the
  // source of `localDeclarations` so vars declared anywhere in the file
  // are recognised as same-file refs regardless of where the consuming
  // `var(...)` appears. Before this scoping change, a small edit to a
  // Furnace override of a stock component (e.g. moz-card) produced a
  // `token-prefix-violation` for every stock `var(--moz-card-*)` the
  // upstream file already carried, because the scanner saw the full
  // applied file and flagged each inherited reference as if the fork
  // had introduced it.
  if (tokenContext) {
    const declarationPattern = /(?:^|[{;,\s])(--[\w-]+)\s*:/g;
    const localDeclarations = new Set<string>();
    let declMatch: RegExpExecArray | null;
    while ((declMatch = declarationPattern.exec(cssContent)) !== null) {
      const name = declMatch[1];
      if (name) localDeclarations.add(name);
    }

    const prefixScanSource = addedLinesByFile
      ? (addedLinesByFile.get(file) ?? []).join('\n').replace(/\/\*[\s\S]*?\*\//g, '')
      : cssContent;

    if (prefixScanSource.length > 0) {
      const varPattern = /var\(\s*(--[\w-]+)/g;
      const flaggedProps = new Set<string>();
      let match: RegExpExecArray | null;
      while ((match = varPattern.exec(prefixScanSource)) !== null) {
        const prop = match[1];
        if (!prop) continue;
        if (prop.startsWith(tokenContext.tokenPrefix)) continue;
        if (tokenContext.tokenAllowlist.has(prop)) continue;
        if (tokenContext.runtimeVariables.has(prop)) continue;
        if (localDeclarations.has(prop)) continue;
        // De-duplicate per (file, prop) pair so the same introduced var
        // used five times in the added hunk doesn't produce five
        // identical issue entries.
        if (flaggedProps.has(prop)) continue;
        flaggedProps.add(prop);

        issues.push({
          file,
          check: 'token-prefix-violation',
          message: `CSS references var(${prop}) which does not match the required token prefix "${tokenContext.tokenPrefix}". Use a design token, add to tokenAllowlist, or (for runtime state channels) list the variable in runtimeVariables.`,
          severity: 'error',
        });
      }
    }
  }
}

/**
 * Lints patched CSS files for introduced raw color values and non-tokenized
 * custom properties.
 *
 * @param repoDir - Absolute path to the engine (repository) directory
 * @param affectedFiles - File paths (relative to repoDir) affected by the patch
 * @param diffContent - Optional unified diff used to scope raw color checks to introduced lines
 * @param config - Project configuration
 * @returns Array of lint issues found
 */
export async function lintPatchedCss(
  repoDir: string,
  affectedFiles: string[],
  diffContent?: string,
  config?: FireForgeConfig
): Promise<PatchLintIssue[]> {
  const cssFiles = affectedFiles.filter((f) => f.endsWith('.css'));
  if (cssFiles.length === 0) return [];

  const tokenContext = await loadCssTokenContext(repoDir);

  const issues: PatchLintIssue[] = [];
  const addedLinesByFile = diffContent ? extractAddedLinesPerFile(diffContent) : undefined;

  for (const file of cssFiles) {
    const filePath = join(repoDir, file);
    if (!(await pathExists(filePath))) continue;

    const rawCss = await readText(filePath);
    // Strip block comments before scanning
    const cssContent = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');

    checkRawColorValues(file, rawCss, addedLinesByFile, config, issues);
    checkTokenPrefixViolations(file, cssContent, addedLinesByFile, tokenContext, issues);
  }

  return issues;
}
