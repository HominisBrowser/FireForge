// SPDX-License-Identifier: EUPL-1.2
/**
 * CSS patch-lint rules: introduced raw color values and non-tokenized
 * custom-property references.
 *
 * Split out of `patch-lint.ts` so each rule family stays within the
 * per-file line budget. `patch-lint.ts` re-exports `lintPatchedCss` so
 * existing callers keep importing from the single module.
 */

import { join } from 'node:path';

import type { PatchLintIssue } from '../types/commands/index.js';
import type { FireForgeConfig } from '../types/config.js';
import { toError } from '../utils/errors.js';
import { pathExists, readText } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';
import { hasRawCssColors } from '../utils/regex.js';
import { loadFurnaceConfig } from './furnace-config.js';
import { extractAddedLineNumbersPerFile, extractAddedLinesPerFile } from './patch-lint-diff.js';

/** Furnace token-lint inputs, or undefined when furnace.json is unavailable. */
interface CssTokenContext {
  tokenPrefix: string;
  tokenAllowlist: Set<string>;
  runtimeVariables: Set<string>;
}

/**
 * Loads the furnace token-prefix lint inputs gracefully. Returns
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
 * Masks CSS block comments with spaces, preserving newlines so line
 * numbers stay stable. An unclosed trailing `/*` is masked to EOF,
 * matching how a CSS parser treats it.
 */
function maskCssComments(source: string): string {
  const masked = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const openerIndex = masked.indexOf('/*');
  if (openerIndex === -1) return masked;
  return (
    masked.slice(0, openerIndex) +
    masked
      .slice(openerIndex)
      .split('\n')
      .map((line) => ' '.repeat(line.length))
      .join('\n')
  );
}

const RAW_COLOR_IGNORE_MARKER = 'fireforge-ignore: raw-color-value';

/**
 * Builds the scan source for the diff branch with full-file comment
 * awareness: comments are masked across the whole post-patch file so a
 * comment spanning the context/added boundary suppresses its hex, then
 * only the patch's added line numbers are scanned. Returns undefined
 * when any added line number falls outside the on-disk file (patch not
 * applied / drifted). The caller then falls back to the legacy
 * joined-added-lines scan rather than misattributing lines.
 */
function buildAddedLinesScanSource(
  rawCss: string,
  addedNumbers: readonly number[]
): string | undefined {
  const rawLines = rawCss.split('\n');
  if (!addedNumbers.every((n) => n >= 1 && n <= rawLines.length)) return undefined;
  const maskedLines = maskCssComments(rawCss).split('\n');
  return addedNumbers
    .filter((n) => !(rawLines[n - 1] ?? '').includes(RAW_COLOR_IGNORE_MARKER))
    .map((n) => maskedLines[n - 1] ?? '')
    .join('\n');
}

/**
 * Raw-color check for one patched CSS file, scoped to introduced lines
 * when diff context is available. Pushes onto `issues`.
 */
interface RawColorCheckInput {
  /** Repo-relative path of the CSS file under check. */
  file: string;
  /** Full (uncommented-stripped) CSS source of that file. */
  rawCss: string;
  /** Added lines per file from the diff, when diff context is available. */
  addedLinesByFile: Map<string, string[]> | undefined;
  /** Added line numbers per file from the diff, aligned with `addedLinesByFile`. */
  addedLineNumbersByFile: Map<string, number[]> | undefined;
  /** Resolved config, for `patchLint.rawColorAllowlist`. */
  config: FireForgeConfig | undefined;
  /** Issue sink, appended to in place. */
  issues: PatchLintIssue[];
}

function checkRawColorValues(input: RawColorCheckInput): void {
  const { file, rawCss, addedLinesByFile, addedLineNumbersByFile, config, issues } = input;
  // Check only introduced raw color values when diff context is available.
  // Skip files on the raw-color allowlist (exact path or basename match) and
  // auto-exempt files under `browser/branding/`: those are the fork's
  // visual identity assets (app-about dialogs, installer pages, branded CSS
  // copied from Firefox's `unofficial` template) and belong to the
  // design-decision layer the design-token system does not govern. Without
  // the auto-exemption, every first-time setup's copied CSS fails
  // `raw-color-value` with no actionable fix short of listing each path in
  // `rawColorAllowlist`.
  const allowlist = config?.patchLint?.rawColorAllowlist;
  const isAllowlisted = allowlist?.some((entry) => file === entry || file.endsWith('/' + entry));
  const isBranding = file.startsWith('browser/branding/');
  if (isAllowlisted || isBranding) return;

  let suppressedContent: string | undefined;
  const addedNumbers = addedLineNumbersByFile?.get(file);
  if (addedNumbers !== undefined) {
    suppressedContent = buildAddedLinesScanSource(rawCss, addedNumbers);
  }
  if (suppressedContent === undefined) {
    // Legacy scan: full file (no diff), or the joined added lines when
    // the diff and on-disk file disagree. Waiver lines are filtered
    // against the pre-strip text so the CSS comment marker is present.
    const sourceForSuppression = addedLinesByFile
      ? (addedLinesByFile.get(file) ?? []).join('\n')
      : rawCss;
    suppressedContent = sourceForSuppression
      .split('\n')
      .filter((line) => !line.includes(RAW_COLOR_IGNORE_MARKER))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '');
  }

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
  // declared and consumed inside the same file is auto-exempted as a runtime
  // state channel (see furnace.json → runtimeVariables).
  //
  // When diff context is available, scope the `var(...)` scan to
  // added/modified lines only. `cssContent` (full-file) is still the source
  // of `localDeclarations` so vars declared anywhere in the file are
  // recognised as same-file refs regardless of where the consuming `var(...)`
  // appears. Without the scoping, a small edit to a Furnace override of a
  // stock component (e.g. moz-card) produces a `token-prefix-violation` for
  // every stock `var(--moz-card-*)` the upstream file already carried.
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
  const addedLineNumbersByFile = diffContent
    ? extractAddedLineNumbersPerFile(diffContent)
    : undefined;

  for (const file of cssFiles) {
    const filePath = join(repoDir, file);
    if (!(await pathExists(filePath))) continue;

    const rawCss = await readText(filePath);
    // Strip block comments before scanning
    const cssContent = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');

    checkRawColorValues({
      file,
      rawCss,
      addedLinesByFile,
      addedLineNumbersByFile,
      config,
      issues,
    });
    checkTokenPrefixViolations(file, cssContent, addedLinesByFile, tokenContext, issues);
  }

  return issues;
}
