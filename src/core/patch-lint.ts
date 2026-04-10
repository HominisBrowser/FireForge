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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const JS_EXTENSIONS = ['.js', '.mjs', '.jsm'];

/**
 * Returns true if the filename looks like a JS/MJS/JSM file.
 * Handles `.sys.mjs` as well.
 */
function isJsFile(file: string): boolean {
  return JS_EXTENSIONS.some((ext) => file.endsWith(ext));
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

/**
 * Extracts new-file paths from a unified diff by scanning for `new file mode` markers.
 */
export function detectNewFilesInDiff(diffContent: string): Set<string> {
  const newFiles = new Set<string>();
  const lines = diffContent.split('\n');
  let currentFile: string | null = null;

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      const match = /^diff --git a\/.+ b\/(.+)$/.exec(line);
      currentFile = match?.[1] ?? null;
      continue;
    }

    if (line.startsWith('new file mode') && currentFile) {
      newFiles.add(currentFile);
    }
  }

  return newFiles;
}

/**
 * Extracts added lines per file from a unified diff.
 * Returns a map of file path → array of added line contents (without the leading `+`).
 */
function extractAddedLinesPerFile(diffContent: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const lines = diffContent.split('\n');
  let currentFile: string | null = null;
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      const match = /^diff --git a\/.+ b\/(.+)$/.exec(line);
      currentFile = match?.[1] ?? null;
      inHunk = false;
      continue;
    }

    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }

    if (inHunk && currentFile && line.startsWith('+') && !line.startsWith('+++')) {
      let arr = result.get(currentFile);
      if (!arr) {
        arr = [];
        result.set(currentFile, arr);
      }
      arr.push(line.slice(1));
    }
  }

  return result;
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
  diffContent?: string
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
    const rawColorContent = addedLinesByFile
      ? (addedLinesByFile.get(file) ?? []).join('\n').replace(/\/\*[\s\S]*?\*\//g, '')
      : cssContent;

    // Check only introduced raw color values when diff context is available.
    if (hasRawCssColors(rawColorContent)) {
      issues.push({
        file,
        check: 'raw-color-value',
        message:
          'Raw color value found. Use CSS custom properties (var(--...)) for design token consistency.',
        severity: 'error',
      });
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
 * @returns Array of lint issues
 */
export async function lintPatchedJs(
  repoDir: string,
  affectedFiles: string[],
  newFiles: Set<string>,
  config: FireForgeConfig
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
      if (lineCount > 650) {
        issues.push({
          file,
          check: 'file-too-large',
          message: `New file has ${lineCount} lines (recommended max: 650). Consider decomposing.`,
          severity: 'warning',
        });
      }
    }

    // 3. JSDoc on exports (new .sys.mjs files only)
    if (isNew && isSysMjs) {
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (/^export\s+(function|class|const|let|var)\s/.test(line)) {
          // Walk backwards to find JSDoc
          let hasJsDoc = false;
          for (let j = i - 1; j >= 0; j--) {
            const prev = (lines[j] ?? '').trim();
            if (prev === '') continue;
            if (prev.endsWith('*/')) {
              hasJsDoc = true;
            }
            break;
          }
          if (!hasJsDoc) {
            issues.push({
              file,
              check: 'missing-jsdoc',
              message: `Export at line ${i + 1} is missing a JSDoc comment with @param/@returns.`,
              severity: 'warning',
            });
          }
        }
      }
    }

    // 4. Observer topic naming
    const topicPattern =
      /(?:addObserver|removeObserver|notifyObservers)\s*\([^)]*["']([^"']+)["']/g;
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

  if (lineCount > 300) {
    issues.push({
      file: '(patch)',
      check: 'large-patch-lines',
      message: `Patch is ${lineCount} lines (recommended: ≤300). Consider splitting into smaller, focused patches.`,
      severity: 'warning',
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
 * @returns Array of all lint issues found
 */
export async function lintExportedPatch(
  repoDir: string,
  affectedFiles: string[],
  diffContent: string,
  config: FireForgeConfig
): Promise<PatchLintIssue[]> {
  const newFiles = detectNewFilesInDiff(diffContent);
  const lineCount = diffContent.split('\n').length;

  const [cssIssues, headerIssues, jsIssues, modifiedHeaderIssues] = await Promise.all([
    lintPatchedCss(repoDir, affectedFiles, diffContent),
    lintNewFileHeaders(repoDir, [...newFiles], config),
    lintPatchedJs(repoDir, affectedFiles, newFiles, config),
    lintModifiedFileHeaders(repoDir, affectedFiles, newFiles),
  ]);

  const modCommentIssues = lintModificationComments(diffContent, config);
  const sizeIssues = lintPatchSize(affectedFiles, lineCount);

  return [
    ...sizeIssues,
    ...cssIssues,
    ...headerIssues,
    ...modifiedHeaderIssues,
    ...jsIssues,
    ...modCommentIssues,
  ];
}
