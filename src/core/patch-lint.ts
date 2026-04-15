// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import type { PatchLintIssue } from '../types/commands/index.js';
import type { FireForgeConfig } from '../types/config.js';
import { toError } from '../utils/errors.js';
import { pathExists, readText } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';
import { hasRawCssColors, stripJsComments } from '../utils/regex.js';
import { loadFurnaceConfig } from './furnace-config.js';
import { type CommentStyle, getLicenseHeader, hasAnyLicenseHeader } from './license-headers.js';
import { runCheckJs } from './patch-lint-checkjs.js';
import { detectNewFilesInDiff, extractAddedLinesPerFile } from './patch-lint-diff.js';
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

const PATCH_LINE_THRESHOLDS = {
  general: { notice: 800, warning: 1500, error: 3000 },
  test: { notice: 1500, warning: 3000, error: 6000 },
} as const;

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
  try {
    const root = join(repoDir, '..');
    const config = await loadFurnaceConfig(root);
    if (config.tokenPrefix) {
      tokenPrefix = config.tokenPrefix;
      tokenAllowlist = new Set(config.tokenAllowlist ?? []);
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
    // Skip files on the raw-color allowlist (exact path or basename match).
    const allowlist = config?.patchLint?.rawColorAllowlist;
    const isAllowlisted = allowlist?.some((entry) => file === entry || file.endsWith('/' + entry));

    if (!isAllowlisted) {
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

    // Check for non-tokenized custom properties
    if (tokenPrefix) {
      const varPattern = /var\(\s*(--[\w-]+)/g;
      let match: RegExpExecArray | null;
      while ((match = varPattern.exec(cssContent)) !== null) {
        const prop = match[1];
        if (prop && !prop.startsWith(tokenPrefix) && !tokenAllowlist?.has(prop)) {
          issues.push({
            file,
            check: 'token-prefix-violation',
            message: `CSS references var(${prop}) which does not match the required token prefix "${tokenPrefix}". Use a design token or add to tokenAllowlist.`,
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

    if (!content.startsWith(expectedHeader)) {
      issues.push({
        file,
        check: 'missing-license-header',
        message: `New file is missing the required ${license} license header.`,
        severity: 'error',
      });
    }
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
 * Checks patch size and emits advisory warnings.
 */
export function lintPatchSize(filesAffected: string[], lineCount: number): PatchLintIssue[] {
  const issues: PatchLintIssue[] = [];

  if (filesAffected.length > 5) {
    issues.push({
      file: '(patch)',
      check: 'large-patch-files',
      message: `Patch affects ${filesAffected.length} files (recommended: ≤5). Consider splitting into smaller, focused patches.`,
      severity: 'warning',
    });
  }

  const allTests = filesAffected.length > 0 && filesAffected.every(isTestFile);
  const thresholds = allTests ? PATCH_LINE_THRESHOLDS.test : PATCH_LINE_THRESHOLDS.general;

  if (lineCount >= thresholds.error) {
    issues.push({
      file: '(patch)',
      check: 'large-patch-lines',
      message: `Patch is ${lineCount} lines (hard limit: ${thresholds.error}). Consider splitting into smaller, focused patches.`,
      severity: 'error',
    });
  } else if (lineCount >= thresholds.warning) {
    issues.push({
      file: '(patch)',
      check: 'large-patch-lines',
      message: `Patch is ${lineCount} lines (soft limit: ${thresholds.warning}, hard limit: ${thresholds.error}). Consider splitting into smaller, focused patches.`,
      severity: 'warning',
    });
  } else if (lineCount >= thresholds.notice) {
    issues.push({
      file: '(patch)',
      check: 'large-patch-lines',
      message: `Patch is ${lineCount} lines (soft limit: ${thresholds.warning}, hard limit: ${thresholds.error}). Consider splitting into smaller, focused patches.`,
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
    if (!hasAnyLicenseHeader(content, style)) {
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
 * @returns Array of all lint issues found
 */
export async function lintExportedPatch(
  repoDir: string,
  affectedFiles: string[],
  diffContent: string,
  config: FireForgeConfig,
  patchQueueCtx?: import('./patch-lint-cross.js').PatchQueueContext
): Promise<PatchLintIssue[]> {
  const newFiles = detectNewFilesInDiff(diffContent);
  const lineCount = diffContent.split('\n').length;
  const patchOwnedFiles = resolvePatchOwnedSysMjs(newFiles, patchQueueCtx);

  const [cssIssues, headerIssues, jsIssues, modifiedHeaderIssues] = await Promise.all([
    lintPatchedCss(repoDir, affectedFiles, diffContent, config),
    lintNewFileHeaders(repoDir, [...newFiles], config),
    lintPatchedJs(repoDir, affectedFiles, newFiles, config, patchOwnedFiles),
    lintModifiedFileHeaders(repoDir, affectedFiles, newFiles),
  ]);

  const modCommentIssues = lintModificationComments(diffContent, config);
  const sizeIssues = lintPatchSize(affectedFiles, lineCount);

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

  return issues;
}
