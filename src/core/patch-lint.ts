// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import type { PatchLintIssue } from '../types/commands/index.js';
import type { FireForgeConfig } from '../types/config.js';
import { toError } from '../utils/errors.js';
import { pathExists, readText } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';
import { hasRawCssColors, stripJsComments } from '../utils/regex.js';
import { loadFurnaceConfig } from './furnace-config.js';
import {
  type CommentStyle,
  containsUpstreamLicenseText,
  getLicenseHeader,
  hasAnyLicenseHeader,
  hasAnyLicenseHeaderAnyStyle,
} from './license-headers.js';
import { runCheckJs } from './patch-lint-checkjs.js';
import { detectNewFilesInDiff, extractAddedLinesPerFile } from './patch-lint-diff.js';
import { AGGREGATE_PATCH_FILE } from './patch-lint-diff-tag.js';
import { validateExportJsDoc } from './patch-lint-jsdoc.js';
import { resolvePatchOwnedSysMjs } from './patch-lint-ownership.js';

// ---------------------------------------------------------------------------
// Cross-patch lint re-exports
// ---------------------------------------------------------------------------
//
// The cross-patch lint infrastructure (queue context builder, duplicate-
// creation and forward-import rules, ignore marker) lives in
// `patch-lint-cross.ts` so the per-patch and cross-patch rule bodies can
// each stay within the project's per-file line budget. Re-export the
// public surface so callers continue to import from a single module.

export { runCheckJs } from './patch-lint-checkjs.js';
export {
  buildPatchQueueContext,
  collectNewFileCreatorsByPath,
  type ExtractedSpecifier,
  extractImportSpecifiers,
  extractImportSpecifiersWithLines,
  findForwardImportIgnoreLines,
  FORWARD_IMPORT_IGNORE_MARKER,
  isForwardImportableFile,
  lintPatchQueue,
  lintPatchQueueDuplicateCreations,
  lintPatchQueueForwardImports,
  type PatchQueueContext,
  type PatchQueueEntry,
} from './patch-lint-cross.js';
export { buildModifiedFileAdditionsFromDiff, detectNewFilesInDiff } from './patch-lint-diff.js';
export { type JsDocCheck, type JsDocIssue, validateExportJsDoc } from './patch-lint-jsdoc.js';
export { resolvePatchOwnedSysMjs } from './patch-lint-ownership.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const JS_EXTENSIONS = ['.js', '.mjs', '.jsm'];

const FILE_SIZE_THRESHOLDS = {
  general: { notice: 500, warning: 750, error: 900 },
  test: { notice: 1200, warning: 1400, error: 1600 },
} as const;

/**
 * Counts the total lines in a unified diff and the number of non-binary
 * text lines, so binary hunks do not inflate patch size checks.
 *
 * @param diffContent - Raw unified diff string
 * @returns Object with `total` line count and `textLines` (total minus binary hunk lines)
 */
export function countNonBinaryDiffLines(diffContent: string): {
  total: number;
  textLines: number;
} {
  const lines = diffContent.split('\n');
  const total = lines.length;
  let binaryLines = 0;
  let inBinaryHunk = false;

  for (const line of lines) {
    if (line === 'GIT binary patch' || line.startsWith('GIT binary patch')) {
      inBinaryHunk = true;
    } else if (line.startsWith('diff --git ')) {
      inBinaryHunk = false;
    }
    if (inBinaryHunk) {
      binaryLines++;
    }
  }

  return { total, textLines: total - binaryLines };
}

const PATCH_LINE_THRESHOLDS = {
  general: { notice: 800, warning: 1500, error: 3000 },
  test: { notice: 1500, warning: 3000, error: 6000 },
  /**
   * Branding patches have a legitimate reason to be large: they include
   * every locale's `brand.ftl`, copied upstream CSS/PNG assets, and the
   * fork-specific `configure.sh` / `brand.properties` under a single
   * `browser/branding/<name>/` subtree. Calibrated against:
   *
   * - The 2026-04-21 eval baseline: a fresh-fork branding export landed
   *   at 15904 lines (localized brand.ftl across many locales + SVG path
   *   data + copied upstream CSS).
   * - The 2026-04-25 operator data point: a freshly setup branding patch
   *   (post-binary-exclusion, after Phase 1+2 patch splits) landed at
   *   15650 lines — within 2% of the eval baseline.
   *
   * Both data points need to surface as a soft `notice` rather than a
   * `warning`, since they represent the *minimum* branding diff. The
   * pre-2026-04-25 calibration {3000/8000/20000} put 15904 firmly in the
   * `warning` band, contradicting the docstring's "loud but not
   * actionable" intent. The current calibration moves the warning band
   * above the eval baseline (with ~13% headroom) and the error band to
   * roughly 2× the baseline — reaching `error` strongly suggests
   * non-branding work is bundled in.
   *
   * Permissive thresholds are safe because the *gate* into this tier is
   * narrow (auto-detect requires every file under `browser/branding/`
   * plus a tight registration allowlist, or an explicit
   * `PatchMetadata.tier: "branding"` opt-in). A non-branding patch
   * cannot accidentally land here.
   */
  branding: { notice: 8000, warning: 18000, error: 30000 },
} as const;

/**
 * File-count thresholds for the `large-patch-files` rule, mirroring the
 * tier shape of {@link PATCH_LINE_THRESHOLDS}. A single warning-only
 * threshold per tier is intentional — file count expresses scope, not
 * blast radius, and there is no error band that would block export.
 *
 * The branding tier sits well above the typical floor because branding
 * patches inherently span many files: PNG/ICO icon assets in 7+ sizes,
 * MSIX manifests, channel-specific configs, locale `.ftl` files,
 * Windows/macOS launcher resources. The 2026-04-25 operator data point
 * reported a 56-file fresh-fork branding bundle as the minimum shape;
 * 60 leaves headroom for additional channels/locales while still firing
 * on a genuinely bloated patch.
 *
 * Test tier matches general because a test-only patch rarely touches
 * many files (a single regression test usually adds 1–3 fixtures); the
 * elevation in {@link PATCH_LINE_THRESHOLDS.test} addresses big
 * table-driven test bodies, not file fan-out.
 */
const PATCH_FILES_THRESHOLDS = {
  general: 5,
  test: 5,
  branding: 60,
} as const;

/**
 * Fixed allowlist of non-branding sibling paths that real-world Firefox
 * branding patches legitimately need to touch to register the new
 * branding flavor with the top-level configure. The 2026-04-21
 * external eval showed that a branding patch which also touches
 * `browser/moz.configure` (the canonical registration point) fell
 * through to the general lint tier because the original predicate
 * required every file to live under `browser/branding/`. This
 * allowlist stays intentionally narrow — additions require a real
 * operator data point, not a speculative expansion. Add new entries
 * only when a genuine branding patch cannot be expressed without a
 * specific registration sibling.
 *
 * Pinned against ESR 140.x conventions at time of writing.
 */
const BRANDING_REGISTRATION_FILES: ReadonlySet<string> = new Set([
  'browser/moz.configure',
  'browser/confvars.sh',
]);

/**
 * Returns true when a patch qualifies for the branding threshold tier:
 * every file lives either under `browser/branding/` or in the narrow
 * registration allowlist, AND the patch contains at least one file
 * under `browser/branding/` (guard against a config-only patch
 * accidentally qualifying as branding).
 *
 * Used by `lintPatchSize` to pick the branding threshold tier. The
 * explicit `tier: "branding"` field on `PatchMetadata` bypasses this
 * heuristic and forces the branding tier directly.
 */
function isBrandingOnlyPatch(files: ReadonlyArray<string>): boolean {
  if (files.length === 0) return false;
  let hasBrandingFile = false;
  for (const file of files) {
    if (file.startsWith('browser/branding/')) {
      hasBrandingFile = true;
      continue;
    }
    if (BRANDING_REGISTRATION_FILES.has(file)) continue;
    return false;
  }
  return hasBrandingFile;
}

/**
 * Returns true if the filename looks like a JS/MJS/JSM file.
 * Handles `.sys.mjs` as well.
 */
function isJsFile(file: string): boolean {
  return JS_EXTENSIONS.some((ext) => file.endsWith(ext));
}

/**
 * Returns true if the file path looks like a test file.
 * Matches paths containing `/test/` or filenames starting with
 * `browser_`, `test_`, or `xpcshell_` (all `.js`).
 */
export function isTestFile(file: string): boolean {
  if (file.includes('/test/')) return true;
  const basename = file.split('/').pop() ?? '';
  return /^(?:browser_|test_|xpcshell_).*\.js$/.test(basename);
}

/**
 * Detects comment style from file extension for license header checks.
 */
export function commentStyleForFile(file: string): CommentStyle | null {
  if (file.endsWith('.css')) return 'css';
  if (file.endsWith('.ftl')) return 'hash';
  if (isJsFile(file)) return 'js';
  return null;
}

// ---------------------------------------------------------------------------
// CSS lint
// ---------------------------------------------------------------------------

/**
 * Lints patched CSS files for introduced raw color values and non-tokenized
 * custom properties.
 *
 * @param repoDir - Absolute path to the engine (repository) directory
 * @param affectedFiles - File paths (relative to repoDir) affected by the patch
 * @param diffContent - Optional unified diff used to scope raw color checks to introduced lines
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

  // Load furnace config gracefully — skip token-prefix check if unavailable
  let tokenPrefix: string | undefined;
  let tokenAllowlist: Set<string> | undefined;
  let runtimeVariables: Set<string> | undefined;
  try {
    const root = join(repoDir, '..');
    const furnaceConfig = await loadFurnaceConfig(root);
    if (furnaceConfig.tokenPrefix) {
      tokenPrefix = furnaceConfig.tokenPrefix;
      tokenAllowlist = new Set(furnaceConfig.tokenAllowlist ?? []);
      runtimeVariables = new Set(furnaceConfig.runtimeVariables ?? []);
    }
  } catch (error: unknown) {
    verbose(
      `Skipping furnace token-prefix lint hints because furnace.json could not be loaded: ${toError(error).message}`
    );
  }

  const issues: PatchLintIssue[] = [];
  const addedLinesByFile = diffContent ? extractAddedLinesPerFile(diffContent) : undefined;

  for (const file of cssFiles) {
    const filePath = join(repoDir, file);
    if (!(await pathExists(filePath))) continue;

    const rawCss = await readText(filePath);
    // Strip block comments before scanning
    const cssContent = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');

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
    if (tokenPrefix) {
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
          if (prop.startsWith(tokenPrefix)) continue;
          if (tokenAllowlist?.has(prop)) continue;
          if (runtimeVariables?.has(prop)) continue;
          if (localDeclarations.has(prop)) continue;
          // De-duplicate per (file, prop) pair so the same introduced var
          // used five times in the added hunk doesn't produce five
          // identical issue entries.
          if (flaggedProps.has(prop)) continue;
          flaggedProps.add(prop);

          issues.push({
            file,
            check: 'token-prefix-violation',
            message: `CSS references var(${prop}) which does not match the required token prefix "${tokenPrefix}". Use a design token, add to tokenAllowlist, or (for runtime state channels) list the variable in runtimeVariables.`,
            severity: 'error',
          });
        }
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// License header lint
// ---------------------------------------------------------------------------

/**
 * Checks new files for required license headers.
 *
 * @param repoDir - Absolute path to the engine directory
 * @param newFiles - New file paths (relative to repoDir)
 * @param config - Project configuration
 * @returns Array of lint issues
 */
export async function lintNewFileHeaders(
  repoDir: string,
  newFiles: string[],
  config: FireForgeConfig
): Promise<PatchLintIssue[]> {
  const license = config.license ?? 'MPL-2.0';
  const issues: PatchLintIssue[] = [];

  for (const file of newFiles) {
    const style = commentStyleForFile(file);
    if (!style) continue;

    const filePath = join(repoDir, file);
    if (!(await pathExists(filePath))) continue;

    const content = await readText(filePath);
    const expectedHeader = getLicenseHeader(license, style);

    // Auto-exempt `browser/branding/` when the file carries ANY recognised
    // license header in the matching comment style. The setup-generated
    // branding directory is copied from Firefox's `unofficial` template,
    // which arrives with Mozilla MPL-2.0 headers — those are legitimate
    // for copyright purposes (the assets are Mozilla's) even when the
    // fork's own code is 0BSD / EUPL-1.2 / GPL-2.0-or-later. The narrower
    // license-match rule would force operators to either rewrite the
    // copied headers (misrepresenting authorship) or suppress the lint
    // with `--skip-lint` (hiding real issues elsewhere).
    if (content.startsWith(expectedHeader)) continue;
    if (file.startsWith('browser/branding/') && hasAnyLicenseHeader(content, style)) continue;

    issues.push({
      file,
      check: 'missing-license-header',
      message: `New file is missing the required ${license} license header.`,
      severity: 'error',
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// JS lint
// ---------------------------------------------------------------------------

/**
 * Lints patched JS/MJS files for import conventions, file size, JSDoc, and
 * observer topic naming.
 *
 * @param repoDir - Absolute path to the engine directory
 * @param affectedFiles - File paths (relative to repoDir)
 * @param newFiles - Set of files that are newly created in this patch
 * @param config - Project configuration
 * @param patchOwnedFiles - Optional set of patch-owned `.sys.mjs` paths for scoped JSDoc enforcement
 * @returns Array of lint issues
 */
export async function lintPatchedJs(
  repoDir: string,
  affectedFiles: string[],
  newFiles: Set<string>,
  config: FireForgeConfig,
  patchOwnedFiles?: Set<string>
): Promise<PatchLintIssue[]> {
  const jsFiles = affectedFiles.filter(isJsFile);
  if (jsFiles.length === 0) return [];

  const issues: PatchLintIssue[] = [];
  const binaryName = config.binaryName.toLowerCase();

  for (const file of jsFiles) {
    const filePath = join(repoDir, file);
    if (!(await pathExists(filePath))) continue;

    const content = await readText(filePath);
    const isNew = newFiles.has(file);
    const isSysMjs = file.endsWith('.sys.mjs');

    // 1. Relative import check
    const strippedContent = stripJsComments(content);
    const relativeImportPattern =
      /(?:ChromeUtils\.import(?:ESModule)?|Cu\.import)\s*\(\s*["'](?:\.\.?\/)/gm;
    const esRelativePattern = /\bimport\s+.*?\s+from\s+["'](?:\.\.?\/)/gm;

    if (relativeImportPattern.test(strippedContent) || esRelativePattern.test(strippedContent)) {
      issues.push({
        file,
        check: 'relative-import',
        message: `Relative imports are not allowed. Use "resource:///modules/${config.binaryName}/" for .sys.mjs or "chrome://browser/content/" for subscripts.`,
        severity: 'error',
      });
    }

    // 2. File size check (new files only)
    if (isNew) {
      const lineCount = content.split('\n').length;
      const isTest = isTestFile(file);
      const thresholds = isTest ? FILE_SIZE_THRESHOLDS.test : FILE_SIZE_THRESHOLDS.general;
      const label = isTest ? 'Test file' : 'New file';
      const verb = isTest ? 'splitting' : 'decomposing';

      if (lineCount >= thresholds.error) {
        issues.push({
          file,
          check: 'file-too-large',
          message: `${label} has ${lineCount} lines (hard limit: ${thresholds.error}). Consider ${verb}.`,
          severity: 'error',
        });
      } else if (lineCount >= thresholds.warning) {
        issues.push({
          file,
          check: 'file-too-large',
          message: `${label} has ${lineCount} lines (soft limit: ${thresholds.warning}, hard limit: ${thresholds.error}). Consider ${verb}.`,
          severity: 'warning',
        });
      } else if (lineCount >= thresholds.notice) {
        issues.push({
          file,
          check: 'file-too-large',
          message: `${label} has ${lineCount} lines (soft limit: ${thresholds.warning}, hard limit: ${thresholds.error}). Consider ${verb}.`,
          severity: 'notice',
        });
      }
    }

    // 3. JSDoc on exports (patch-owned .sys.mjs files)
    const isOwned = patchOwnedFiles ? patchOwnedFiles.has(file) : isNew;
    if (isOwned && isSysMjs) {
      const jsdocIssues = validateExportJsDoc(content);
      for (const jsdocIssue of jsdocIssues) {
        issues.push({
          file,
          check: jsdocIssue.check,
          message: jsdocIssue.message,
          severity: 'error',
        });
      }
    }

    // 4. Observer topic naming
    const topicPattern =
      /(?:addObserver|removeObserver|notifyObservers)\s*\([^)\n]*["']([^"']+)["']/g;
    let topicMatch: RegExpExecArray | null;
    while ((topicMatch = topicPattern.exec(strippedContent)) !== null) {
      const topic = topicMatch[1];
      if (!topic) continue;
      // Only flag topics that contain the binaryName but don't follow convention
      if (topic.toLowerCase().includes(binaryName) && !/^[\w]+-[a-z]+-[a-z]+/.test(topic)) {
        issues.push({
          file,
          check: 'observer-topic-naming',
          message: `Observer topic "${topic}" should follow "${binaryName}-<noun>-<verb>" naming convention.`,
          severity: 'warning',
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Modification comment lint
// ---------------------------------------------------------------------------

/**
 * Checks that modifications to existing (non-new) JS/MJS files include at
 * least one `// BINARYNAME:` comment in the added lines.
 *
 * @param diffContent - Raw unified diff string
 * @param config - Project configuration
 * @returns Array of lint issues
 */
export function lintModificationComments(
  diffContent: string,
  config: FireForgeConfig
): PatchLintIssue[] {
  const newFiles = detectNewFilesInDiff(diffContent);
  const addedLines = extractAddedLinesPerFile(diffContent);
  const issues: PatchLintIssue[] = [];
  const marker = `// ${config.binaryName.toUpperCase()}:`;

  for (const [file, lines] of addedLines) {
    // Only check JS/MJS files that are modifications (not new files)
    if (!isJsFile(file) || newFiles.has(file)) continue;

    const hasMarker = lines.some((line) => line.toUpperCase().includes(marker.toUpperCase()));

    if (!hasMarker && lines.length > 0) {
      issues.push({
        file,
        check: 'missing-modification-comment',
        message: `Modified upstream file lacks a "${marker}" comment marking your changes.`,
        severity: 'warning',
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Patch size lint (moved from export-shared.ts warnLargePatch)
// ---------------------------------------------------------------------------

/**
 * Describes which tier `resolvePatchSizeTier` selected and why.
 * Consumers that want to surface the tier choice to the operator
 * (e.g. a one-line `info()` when branding thresholds kick in) read
 * this alongside the issues array from `lintPatchSize`.
 */
export type PatchSizeTierDecision =
  | { tier: 'general' }
  | { tier: 'test' }
  | { tier: 'branding'; source: 'auto' | 'explicit' };

/**
 * Decides which `large-patch-lines` threshold tier applies to a patch.
 * Exported so `runPatchLint` and the per-patch `lint` command can
 * surface the tier choice to the operator *without* depending on
 * `lintPatchSize`'s internal return shape — the rule itself stays a
 * pure issues-array API, and the decision is computed separately for
 * the sole purpose of reporting.
 *
 * Precedence: test > branding (explicit) > branding (auto) > general.
 * The test tier beats branding because a table-driven regression test
 * is legitimately large independent of whether the patch also claims
 * branding shape, and the test-tier thresholds are already more
 * permissive than branding — so "tests beat branding" is the
 * defensive-for-tests choice.
 */
export function resolvePatchSizeTier(
  filesAffected: ReadonlyArray<string>,
  patchTier?: 'branding'
): PatchSizeTierDecision {
  const allTests = filesAffected.length > 0 && filesAffected.every(isTestFile);
  if (allTests) return { tier: 'test' };
  if (patchTier === 'branding') return { tier: 'branding', source: 'explicit' };
  if (isBrandingOnlyPatch(filesAffected)) return { tier: 'branding', source: 'auto' };
  return { tier: 'general' };
}

/**
 * Checks patch size and emits advisory warnings.
 *
 * @param filesAffected - Files touched by the patch
 * @param lineCount - Non-binary line count of the unified diff
 * @param patchTier - Optional explicit tier override declared on
 *   `PatchMetadata.tier`. When `"branding"`, forces the branding
 *   thresholds regardless of `filesAffected`. Tests still win over
 *   branding (precedence `test > branding > general`) because the
 *   test-tier thresholds are already more permissive and an all-tests
 *   patch that is also branding-shaped is vanishingly rare.
 */
export function lintPatchSize(
  filesAffected: string[],
  lineCount: number,
  patchTier?: 'branding'
): PatchLintIssue[] {
  const issues: PatchLintIssue[] = [];

  // Tier selection: test > branding > general. Tests keep their elevated
  // thresholds because a big regression test is legitimate (table-driven
  // harnesses run into the thousands of lines). Branding patches get
  // their own tier so a first-export of setup-generated branding doesn't
  // fire the general hard limit — see `PATCH_LINE_THRESHOLDS.branding`
  // and `PATCH_FILES_THRESHOLDS.branding` above for the eval data
  // motivating this tier. An explicit `patchTier` opt-in forces branding
  // even when `isBrandingOnlyPatch` cannot reach the patch's actual
  // shape (a branding patch that also touches a non-allowlisted sibling
  // like a vendor-specific icon resource). Both checks read off the
  // same decision so the file-count and line-count rules cannot
  // disagree about which tier applies.
  const decision = resolvePatchSizeTier(filesAffected, patchTier);
  const fileThreshold =
    decision.tier === 'test'
      ? PATCH_FILES_THRESHOLDS.test
      : decision.tier === 'branding'
        ? PATCH_FILES_THRESHOLDS.branding
        : PATCH_FILES_THRESHOLDS.general;
  const lineThresholds =
    decision.tier === 'test'
      ? PATCH_LINE_THRESHOLDS.test
      : decision.tier === 'branding'
        ? PATCH_LINE_THRESHOLDS.branding
        : PATCH_LINE_THRESHOLDS.general;

  if (filesAffected.length > fileThreshold) {
    issues.push({
      file: AGGREGATE_PATCH_FILE,
      check: 'large-patch-files',
      message: `Patch affects ${filesAffected.length} files (recommended: ≤${fileThreshold}). Consider splitting into smaller, focused patches.`,
      severity: 'warning',
    });
  }

  if (lineCount >= lineThresholds.error) {
    issues.push({
      file: AGGREGATE_PATCH_FILE,
      check: 'large-patch-lines',
      message: `Patch is ${lineCount} lines (hard limit: ${lineThresholds.error}). Consider splitting into smaller, focused patches.`,
      severity: 'error',
    });
  } else if (lineCount >= lineThresholds.warning) {
    issues.push({
      file: AGGREGATE_PATCH_FILE,
      check: 'large-patch-lines',
      message: `Patch is ${lineCount} lines (soft limit: ${lineThresholds.warning}, hard limit: ${lineThresholds.error}). Consider splitting into smaller, focused patches.`,
      severity: 'warning',
    });
  } else if (lineCount >= lineThresholds.notice) {
    issues.push({
      file: AGGREGATE_PATCH_FILE,
      check: 'large-patch-lines',
      message: `Patch is ${lineCount} lines (soft limit: ${lineThresholds.warning}, hard limit: ${lineThresholds.error}). Consider splitting into smaller, focused patches.`,
      severity: 'notice',
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Modified file header lint
// ---------------------------------------------------------------------------

/**
 * Checks that modified (non-new) files with a supported extension still
 * start with a recognized license header.
 *
 * @param repoDir - Engine root directory
 * @param affectedFiles - All files affected by the patch
 * @param newFiles - Set of newly created files (excluded from this check)
 * @returns Warning-level lint issues for files missing any recognized header
 */
export async function lintModifiedFileHeaders(
  repoDir: string,
  affectedFiles: string[],
  newFiles: Set<string>
): Promise<PatchLintIssue[]> {
  const issues: PatchLintIssue[] = [];

  for (const file of affectedFiles) {
    if (newFiles.has(file)) continue;
    const style = commentStyleForFile(file);
    if (!style) continue;

    const filePath = join(repoDir, file);
    if (!(await pathExists(filePath))) continue;

    const content = await readText(filePath);
    if (
      !hasAnyLicenseHeader(content, style) &&
      !hasAnyLicenseHeaderAnyStyle(content) &&
      !containsUpstreamLicenseText(content)
    ) {
      issues.push({
        file,
        check: 'modified-file-missing-header',
        message: 'Modified upstream file appears to be missing a recognized license header.',
        severity: 'warning',
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Runs all patch lint checks and returns combined issues.
 *
 * @param repoDir - Absolute path to the engine directory
 * @param affectedFiles - File paths (relative to repoDir) affected by the patch
 * @param diffContent - Raw unified diff string
 * @param config - Project configuration
 * @param patchQueueCtx - Optional cross-patch context for ownership resolution
 * @param ignoreChecks - Optional set of per-patch `check` IDs to drop from the
 *   returned issues. Threaded from `PatchMetadata.lintIgnore` so a patch that
 *   is advisory-noisy by nature (a cohesive branding bundle, auto-generated
 *   manifest, etc.) can opt out of a specific rule without reaching for the
 *   blunt `--skip-lint` hammer. Not mutated by this function.
 * @param patchTier - Optional explicit tier override, threaded from
 *   `PatchMetadata.tier`. When `"branding"` forces the branding
 *   thresholds on the `large-patch-lines` rule. Callers with a
 *   per-patch manifest context (re-export, per-patch lint) should
 *   pass this; aggregate-mode callers without a specific patch
 *   context skip it and fall through to auto-detection.
 * @returns Array of all lint issues found
 */
export async function lintExportedPatch(
  repoDir: string,
  affectedFiles: string[],
  diffContent: string,
  config: FireForgeConfig,
  patchQueueCtx?: import('./patch-lint-cross.js').PatchQueueContext,
  ignoreChecks?: ReadonlySet<string>,
  patchTier?: 'branding'
): Promise<PatchLintIssue[]> {
  const newFiles = detectNewFilesInDiff(diffContent);
  const { textLines: lineCount } = countNonBinaryDiffLines(diffContent);
  const patchOwnedFiles = resolvePatchOwnedSysMjs(newFiles, patchQueueCtx);

  const [cssIssues, headerIssues, jsIssues, modifiedHeaderIssues] = await Promise.all([
    lintPatchedCss(repoDir, affectedFiles, diffContent, config),
    lintNewFileHeaders(repoDir, [...newFiles], config),
    lintPatchedJs(repoDir, affectedFiles, newFiles, config, patchOwnedFiles),
    lintModifiedFileHeaders(repoDir, affectedFiles, newFiles),
  ]);

  const modCommentIssues = lintModificationComments(diffContent, config);
  const sizeIssues = lintPatchSize(affectedFiles, lineCount, patchTier);

  const issues = [
    ...sizeIssues,
    ...cssIssues,
    ...headerIssues,
    ...modifiedHeaderIssues,
    ...jsIssues,
    ...modCommentIssues,
  ];

  // Optional checkJs pass — only when explicitly enabled in config
  if (config.patchLint?.checkJs) {
    const checkJsIssues = await runCheckJs(repoDir, patchOwnedFiles);
    issues.push(...checkJsIssues);
  }

  // Filter out ignored checks last so every rule still runs (keeps the
  // implementation uniform) but suppressed rules do not surface. We do not
  // reclassify severities — an ignored error simply drops, mirroring how
  // inline `fireforge-ignore: <check>` markers work in the CSS and
  // forward-import rules.
  if (ignoreChecks && ignoreChecks.size > 0) {
    return issues.filter((issue) => !ignoreChecks.has(issue.check));
  }
  return issues;
}
