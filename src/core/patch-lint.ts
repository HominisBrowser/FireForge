// SPDX-License-Identifier: EUPL-1.2
import { dirname, join } from 'node:path';

import type { PatchLintIssue } from '../types/commands/index.js';
import type { FireForgeConfig, ProjectLicense } from '../types/config.js';
import { pathExists, readText } from '../utils/fs.js';
import { stripJsComments } from '../utils/regex.js';
import {
  type CommentStyle,
  containsUpstreamLicenseText,
  getLicenseHeader,
  hasAnyLicenseHeader,
  hasAnyLicenseHeaderAnyStyle,
  hasUpstreamMplBlockHeader,
} from './license-headers.js';
import { invokePatchLintCheckJs, runCheckJsTestFilesGrouped } from './patch-lint-checkjs.js';
import { lintChromeScriptJsDocForFile } from './patch-lint-chrome-jsdoc.js';
import { countCodeLines, countRawLines } from './patch-lint-code-lines.js';
import { lintPatchedCss } from './patch-lint-css.js';
import {
  detectNewFilesInDiff,
  extractAddedLineNumbersPerFile,
  extractAddedLinesPerFile,
} from './patch-lint-diff.js';
import { formatFileTooLargeMessage, resolveFileSizeThresholds } from './patch-lint-file-size.js';
import { type LintIgnoreChecks, partitionLintIgnoredIssues } from './patch-lint-ignore.js';
import { relativeImportLines } from './patch-lint-imports.js';
import { validateExportJsDoc } from './patch-lint-jsdoc.js';
import { lintMozBuildSortedLists } from './patch-lint-mozbuild.js';
import { lintObserverTopics } from './patch-lint-observer.js';
import {
  resolvableModulesForTests,
  resolvePatchOwnedChromeScripts,
  resolvePatchOwnedSysMjs,
  resolvePatchOwnedTestScripts,
} from './patch-lint-ownership.js';
import { invokePatchLintPrettier } from './patch-lint-prettier.js';
import {
  isTestFile,
  lintPatchSize,
  measurePatchSize,
  type PatchSizeMeasurement,
} from './patch-lint-size.js';

// ---------------------------------------------------------------------------
// Cross-patch lint re-exports
// ---------------------------------------------------------------------------
//
// The cross-patch lint infrastructure (queue context builder,
// duplicate-creation and forward-import rules, ignore marker) lives in
// `patch-lint-cross.ts` so the per-patch and cross-patch rule bodies each
// stay within the per-file line budget. Its surface is re-exported here so
// callers keep importing from one module.

export * from './patch-lint-cross.js';
export { buildModifiedFileAdditionsFromDiff, detectNewFilesInDiff } from './patch-lint-diff.js';

// The CSS rule bodies live in `patch-lint-css.ts` (same per-file-budget
// split as the other rule families). Re-export the imported binding so
// callers and tests keep importing `lintPatchedCss` from this module.
export { lintPatchedCss };

// Same split for the patch-size rules and their measurement.
export {
  countNonBinaryDiffLines,
  getPatchSizeThresholds,
  isTestFile,
  lintPatchSize,
  measurePatchSize,
  type PatchSizeMeasurement,
  type PatchSizeTierDecision,
  resolvePatchSizeTier,
} from './patch-lint-size.js';
export type { PatchSizeThresholds } from './patch-lint-size-thresholds.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const JS_EXTENSIONS = ['.js', '.mjs', '.jsm'];

/**
 * Canonical `[check] file: message` rendering of a patch-lint issue. It is
 * the one string shape every reporter and refusal message uses, so operators
 * can grep one format across lint output and refusal details.
 */
export function formatPatchLintIssue(
  issue: Pick<PatchLintIssue, 'check' | 'file' | 'message'>
): string {
  return `[${issue.check}] ${issue.file}: ${issue.message}`;
}

/**
 * Returns true if the filename looks like a JS/MJS/JSM file.
 * Handles `.sys.mjs` as well.
 */
function isJsFile(file: string): boolean {
  return JS_EXTENSIONS.some((ext) => file.endsWith(ext));
}

/** The subset of a patch's new files that `file-too-large` measures. */
function measuredByFileTooLarge(newFiles: Iterable<string>): Set<string> {
  return new Set([...newFiles].filter(isJsFile));
}

/**
 * The files the `file-too-large` rule measures for a patch: the JS files
 * (`.js`, `.mjs`, `.sys.mjs`, …) the patch creates. A modified file is
 * never measured, and neither is a new file of another kind (CSS, FTL,
 * markup), however long. This is the rule's own predicate, not a mirror
 * of it: the rule selects its files through the same function.
 *
 * @param patchText - Unified-diff body of one patch
 * @returns Engine-relative paths the rule would size-check
 */
export function filesMeasuredByFileTooLarge(patchText: string): Set<string> {
  return measuredByFileTooLarge(detectNewFilesInDiff(patchText));
}

/**
 * The `file-too-large` rule for one measured file, in the configured
 * `patchLint.fileSizeMetric`. Under `"code"`, a file acorn cannot tokenize
 * is measured in raw lines (the upper bound) and a `file-size-unparsed`
 * notice names it, so the fallback is visible instead of silently lenient.
 */
function lintFileSize(file: string, content: string, config: FireForgeConfig): PatchLintIssue[] {
  const issues: PatchLintIssue[] = [];
  let lineCount = countRawLines(content);
  let unit: 'lines' | 'code lines' = 'lines';
  if (config.patchLint?.fileSizeMetric === 'code') {
    const counted = countCodeLines(content);
    if (counted.parsed) {
      lineCount = counted.lines;
      unit = 'code lines';
    } else {
      issues.push({
        file,
        check: 'file-size-unparsed',
        message:
          `Could not parse the file as a module or a script, so file-too-large counted its ` +
          `${lineCount} raw lines (the upper bound) instead of code lines.`,
        severity: 'notice',
      });
    }
  }
  const isTest = isTestFile(file);
  const thresholds = resolveFileSizeThresholds(config.patchLint?.fileSizeThresholds, isTest);
  const band =
    lineCount > thresholds.error
      ? 'error'
      : lineCount > thresholds.warning
        ? 'warning'
        : lineCount > thresholds.notice
          ? 'notice'
          : undefined;
  if (band !== undefined) {
    issues.push({
      file,
      check: 'file-too-large',
      message: formatFileTooLargeMessage({
        label: isTest ? 'Test file' : 'New file',
        lineCount,
        unit,
        thresholds,
        band,
        verb: isTest ? 'splitting' : 'decomposing',
      }),
      severity: band,
      measurement: lineCount,
    });
  }
  return issues;
}

/**
 * Narrower scope than `isTestFile`: only browser-chrome test files
 * (`browser_*.js` under a `/test/` or `/tests/` directory). Excludes
 * `head.js` and `head_*.js` test helpers.
 */
function isBrowserChromeTestFile(file: string): boolean {
  if (!file.endsWith('.js')) return false;
  if (!/\/(?:test|tests)\//.test(file)) return false;
  const basename = file.split('/').pop() ?? '';
  if (basename === 'head.js' || /^head_.*\.js$/.test(basename)) return false;
  return basename.startsWith('browser_');
}

/**
 * Bare assertion-call detection for the `test-needs-assertion` floor.
 *
 * Each alternative must sit at a call boundary: preceded by something that
 * is not an identifier character, `.`, `#`, or `-`. A plain
 * `strippedContent.includes(tok)` over `Assert.`, `ok(`, `is(`, `isnot(`,
 * `isDeeply(` lets any identifier merely *ending* in one satisfy the gate:
 * `this.axis(3)` contains `is(`, `book(` contains `ok(`, and
 * `promiseIsDeeply(` contains `isDeeply(`, so an assertion-free smoke test
 * using any such call clears the floor.
 *
 * The namespaced arm must name a member and a call. Matching the namespace
 * and its dot alone re-opens the same hole from the other side:
 * `SimpleTest` is mostly *harness* API, so `SimpleTest.finish()`,
 * `SimpleTest.waitForExplicitFinish()` and `SimpleTest.requestCompleteLog()`
 * would each clear the floor on their own, which are the exact calls an
 * assertion-free smoke test contains. The enumeration below is the
 * mochitest/xpcshell assertion surface both namespaces share, and it is what
 * the user-facing message names.
 *
 * Two qualified spellings of the bare four also count: `window.ok(...)` (the
 * globals are window properties) and an optional-chained `win?.ok(...)`.
 * Blocking those flags tests whose only assertions are real as
 * assertion-free. `SpecialPowers.ok(` stays excluded: that is API surface,
 * not an assertion.
 *
 * Textual rather than AST-based, on purpose: this runs over patch bodies
 * rather than resolvable sources, and the surrounding rule is a floor, not
 * a proof.
 */
const ASSERTION_MEMBERS = [
  'ok',
  'is',
  'isnot',
  'isDeeply',
  'equal',
  'notEqual',
  'deepEqual',
  'notDeepEqual',
  'strictEqual',
  'notStrictEqual',
  'greater',
  'greaterOrEqual',
  'less',
  'lessOrEqual',
  'stringMatches',
  'stringContains',
  'throws',
  'rejects',
  // `todo`, `todo_is`, `todo_isnot`, `info`-free: todo* record an expected
  // failure, which is still a recorded assertion outcome.
  'todo',
  'todo_is',
  'todo_isnot',
].join('|');

const BROWSER_CHROME_ASSERTION = new RegExp(
  `(?<![\\w.#$-])(?:(?:Assert|SimpleTest)\\.(?:${ASSERTION_MEMBERS})\\s*\\(|(?:window\\.|[\\w$]+\\?\\.)?(?:ok|is|isnot|isDeeply)\\s*\\()`
);

/** True when `strippedContent` contains at least one assertion call. */
export function hasBrowserChromeAssertion(strippedContent: string): boolean {
  return BROWSER_CHROME_ASSERTION.test(strippedContent);
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
// License header lint
// ---------------------------------------------------------------------------

/**
 * Decides whether a new file's leading header satisfies the
 * `missing-license-header` rule. It is the single owner of the acceptance
 * policy: `lintNewFileHeaders` (the rule) and `autoFixLicenseHeaders` (the
 * interactive export fixer) must agree, or the fixer offers to stack a
 * second header onto a file the lint already accepts.
 *
 * Accepted shapes, in order:
 *  - the project's own header for the file's comment style.
 *  - under `browser/branding/`, any recognised license header in the
 *    matching style: the setup-generated branding directory is copied from
 *    Firefox's `unofficial` template and arrives with Mozilla MPL-2.0
 *    headers, legitimate for copyright purposes (the assets are Mozilla's)
 *    even when the fork's own code is 0BSD / EUPL-1.2 / GPL-2.0-or-later.
 *  - on an MPL-2.0 project, any recognised header in the matching style.
 *  - the verbatim upstream MPL-2.0 block header (`/* … *\/`, optionally
 *    behind a leading editor-directive comment) regardless of the project
 *    license, on any file whose comment syntax is the block form (JS and
 *    CSS): a file copied from the Firefox tree legitimately keeps Mozilla's
 *    header for provenance in an EUPL/GPL/0BSD project too. Only the block
 *    form is accepted, because the `// `-style MPL header is
 *    FireForge-generated rather than upstream provenance, and `hash`-style
 *    files (FTL) stay excluded
 *    because `/* … *\/` is not a comment there.
 *
 * @param file - Engine-relative path of the new file
 * @param content - File content
 * @param style - Comment style resolved for the file
 * @param license - The project license
 */
export function isAcceptableNewFileHeader(
  file: string,
  content: string,
  style: CommentStyle,
  license: ProjectLicense
): boolean {
  if (content.startsWith(getLicenseHeader(license, style))) return true;
  if (file.startsWith('browser/branding/') && hasAnyLicenseHeader(content, style)) return true;
  if (license === 'MPL-2.0' && hasAnyLicenseHeader(content, style)) return true;
  if ((style === 'js' || style === 'css') && hasUpstreamMplBlockHeader(content)) return true;
  return false;
}

/**
 * Checks new files for required license headers (acceptance policy in
 * {@link isAcceptableNewFileHeader}).
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
    if (isAcceptableNewFileHeader(file, content, style, license)) continue;

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

/** Optional ownership and diff context for {@link lintPatchedJs}. */
export interface LintPatchedJsScope {
  /** Patch-owned `.sys.mjs` paths for scoped JSDoc enforcement. */
  patchOwnedFiles?: Set<string>;
  /**
   * Patch-owned chrome subscripts (`.js` non-`.sys.mjs`) for scoped
   * chrome-script JSDoc enforcement. Built by
   * {@link resolvePatchOwnedChromeScripts}. Kept apart from
   * `patchOwnedFiles` so the `runCheckJs` consumer (which only accepts
   * `.sys.mjs`) is not silently broadened.
   */
  patchOwnedChromeScripts?: Set<string>;
  /**
   * Unified diff of the patch. When given, `relative-import` judges a
   * modified upstream file on the lines the patch adds only, so upstream's
   * own relative imports do not count against it. A file the patch creates
   * is judged whole either way.
   */
  diffContent?: string;
}

/**
 * Lints patched JS/MJS files for import conventions, file size, JSDoc, and
 * observer topic naming.
 *
 * @param repoDir - Absolute path to the engine directory
 * @param affectedFiles - File paths (relative to repoDir)
 * @param newFiles - Set of files that are newly created in this patch
 * @param config - Project configuration
 * @param scope - Optional ownership sets and patch diff; see {@link LintPatchedJsScope}
 * @returns Array of lint issues
 */
export async function lintPatchedJs(
  repoDir: string,
  affectedFiles: string[],
  newFiles: Set<string>,
  config: FireForgeConfig,
  scope: LintPatchedJsScope = {}
): Promise<PatchLintIssue[]> {
  const { patchOwnedFiles, patchOwnedChromeScripts, diffContent } = scope;
  const jsFiles = affectedFiles.filter(isJsFile);
  if (jsFiles.length === 0) return [];
  const addedLineNumbersByFile =
    diffContent !== undefined ? extractAddedLineNumbersPerFile(diffContent) : undefined;

  const issues: PatchLintIssue[] = [];
  const binaryName = config.binaryName.toLowerCase();
  const sizeMeasured = measuredByFileTooLarge(newFiles);

  for (const file of jsFiles) {
    const filePath = join(repoDir, file);
    if (!(await pathExists(filePath))) continue;

    const content = await readText(filePath);
    const isNew = newFiles.has(file);
    const isSysMjs = file.endsWith('.sys.mjs');

    // 1. Relative import check: a file the patch creates is judged whole, a
    // modified upstream file on the lines the patch adds when the diff is known.
    const strippedContent = stripJsComments(content);

    const importLines = relativeImportLines(content);
    const addedLines = isNew ? undefined : addedLineNumbersByFile?.get(file);
    const offendingImportLines =
      isNew || addedLineNumbersByFile === undefined
        ? importLines
        : importLines.filter((line) => addedLines?.includes(line) === true);
    if (offendingImportLines.length > 0) {
      issues.push({
        file,
        check: 'relative-import',
        message: `Relative imports are not allowed. Use "resource:///modules/${config.binaryName}/" for .sys.mjs or "chrome://browser/content/" for subscripts.`,
        severity: 'error',
      });
    }

    // 2. File size check (new JS files only; see filesMeasuredByFileTooLarge)
    if (sizeMeasured.has(file)) {
      issues.push(...lintFileSize(file, content, config));
    }

    // 3. JSDoc on exports (patch-owned .sys.mjs files)
    const isOwned = patchOwnedFiles ? patchOwnedFiles.has(file) : isNew;
    if (isOwned && isSysMjs) {
      const classMethodMode = config.patchLint?.jsdocClassMethods;
      const jsdocIssues = validateExportJsDoc(
        content,
        classMethodMode ? { classMethodMode } : undefined
      );
      for (const jsdocIssue of jsdocIssues) {
        issues.push({
          file,
          check: jsdocIssue.check,
          message: jsdocIssue.message,
          severity: jsdocIssue.severity ?? 'error',
        });
      }
    }

    // 3a. JSDoc on top-level declarations in patch-owned chrome subscripts.
    // Dispatched out-of-line to keep this file under the per-file line
    // budget. See `patch-lint-chrome-jsdoc.ts` for the rule body.
    const isChromeOwned =
      file.endsWith('.js') &&
      !isSysMjs &&
      (patchOwnedChromeScripts ? patchOwnedChromeScripts.has(file) : isNew);
    const chromeMode = config.patchLint?.chromeScriptJsDoc;
    issues.push(...lintChromeScriptJsDocForFile(file, content, isChromeOwned, chromeMode));

    // 3b. Assertion floor for browser-chrome tests touched by this patch
    // (covers both newly introduced files and modified upstream tests:
    // a patch that strips the last `Assert.equal` from an existing
    // browser_*.js silently passed under the old `isNew` gate).
    const assertionFloor = config.patchLint?.testAssertionFloor;
    if (assertionFloor && assertionFloor !== 'off' && isBrowserChromeTestFile(file)) {
      const hasAssertion = hasBrowserChromeAssertion(strippedContent);
      if (!hasAssertion) {
        issues.push({
          file,
          check: 'test-needs-assertion',
          message: `Test file ${file} contains no assertions (Assert.*, ok(), is(), isnot(), isDeeply()). Smoke-only tests do not count as coverage. Add at least one assertion that pins user-visible behavior, or remove the file.`,
          severity: assertionFloor,
        });
      }
    }

    // 4. Observer topic naming. Rule body lives in `patch-lint-observer.ts`:
    // argument-position-aware, multi-line-safe, and allowlists Firefox-owned
    // topics so simulated upstream notifications are not flagged.
    issues.push(...lintObserverTopics(strippedContent, file, binaryName));
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
 * Optional behaviour switches for {@link lintExportedPatch}.
 */
export interface LintExportedPatchOptions {
  /**
   * Cross-patch context for ownership resolution. Present whenever the
   * caller has a loaded patch queue. Absent for the ad-hoc single-diff
   * paths that have no queue to resolve against.
   */
  patchQueueCtx?: import('./patch-lint-cross.js').PatchQueueContext;
  /**
   * Per-patch `check` IDs to drop from the returned issues. Threaded from
   * `PatchMetadata.lintIgnore` so a patch that is advisory-noisy by nature
   * (a cohesive branding bundle, auto-generated manifest, etc.) can opt out
   * of a specific rule without reaching for the blunt `--skip-lint` hammer.
   * Not mutated.
   */
  ignoreChecks?: LintIgnoreChecks;
  /**
   * Explicit tier override, threaded from `PatchMetadata.tier`. When
   * `"branding"` forces the branding thresholds on the
   * `large-patch-lines` rule. Callers with a per-patch manifest context
   * (re-export, per-patch lint) should pass this. Aggregate-mode callers
   * without a specific patch context omit it and fall through to
   * auto-detection.
   */
  patchTier?: 'branding';
  /**
   * Skip the patch-size rules (`large-patch-files` / `large-patch-lines`).
   * The ad-hoc `fireforge lint <files>` path passes a cross-patch file
   * list that does not correspond to a single patch, so it suppresses the
   * synthetic combined-list size check here and re-evaluates the size
   * rules per owning patch instead, never synthesising a phantom
   * oversized patch from the operator's file selection.
   */
  skipPatchSize?: boolean;
  /**
   * Restrict checkJs diagnostics to these repo-relative files. Module
   * resolution still spans every owned file in `patchQueueCtx`. Export and
   * re-export pass the patch under export so cross-patch `resource:///`
   * imports resolve against the whole queue while only that patch's
   * findings surface.
   */
  checkJsReportScope?: ReadonlySet<string>;
  /**
   * Pre-computed checkJs issues for this patch. When provided, the internal
   * checkJs invocation is skipped and these are appended verbatim: the
   * per-patch lint path builds one queue-wide checkJs program and
   * attributes findings per patch instead of rebuilding per patch.
   */
  precomputedCheckJs?: readonly PatchLintIssue[];
  /**
   * Invoked with the issues dropped by the `ignoreChecks` waiver filter,
   * when any were. Suppression semantics are unchanged (the returned issue
   * list still excludes them), but the caller can report
   * the measurement a waived size finding carried (per-patch NOTICE lines
   * and the `--report` JSON) instead of losing it entirely.
   */
  onSuppressed?: (suppressed: PatchLintIssue[]) => void;
  /**
   * The patch's {@link measurePatchSize} result, when the caller already
   * measured it for its own report or cache row. Absent, the size rules
   * measure the diff themselves.
   */
  patchSizeMeasurement?: PatchSizeMeasurement;
}

/**
 * Runs all patch lint checks and returns combined issues.
 *
 * @param repoDir - Absolute path to the engine directory
 * @param affectedFiles - File paths (relative to repoDir) affected by the patch
 * @param diffContent - Raw unified diff string
 * @param config - Project configuration
 * @param options - Optional context and behaviour switches. See
 *   {@link LintExportedPatchOptions}. Every optional input lives here
 *   rather than in a positional tail: four of the five call sites had to
 *   pass `undefined` placeholders to reach the one member they wanted.
 * @returns Array of all lint issues found
 */
export async function lintExportedPatch(
  repoDir: string,
  affectedFiles: string[],
  diffContent: string,
  config: FireForgeConfig,
  options?: LintExportedPatchOptions
): Promise<PatchLintIssue[]> {
  const { patchQueueCtx, ignoreChecks, patchTier } = options ?? {};
  const newFiles = detectNewFilesInDiff(diffContent);
  const patchOwnedFiles = resolvePatchOwnedSysMjs(newFiles, patchQueueCtx);
  const patchOwnedChromeScripts = resolvePatchOwnedChromeScripts(newFiles, patchQueueCtx);

  const [cssIssues, headerIssues, jsIssues, modifiedHeaderIssues, mozBuildIssues] =
    await Promise.all([
      lintPatchedCss(repoDir, affectedFiles, diffContent, config),
      lintNewFileHeaders(repoDir, [...newFiles], config),
      lintPatchedJs(repoDir, affectedFiles, newFiles, config, {
        patchOwnedFiles,
        patchOwnedChromeScripts,
        diffContent,
      }),
      lintModifiedFileHeaders(repoDir, affectedFiles, newFiles),
      lintMozBuildSortedLists(repoDir, affectedFiles),
    ]);

  const modCommentIssues = lintModificationComments(diffContent, config);
  const sizeIssues = options?.skipPatchSize
    ? []
    : lintPatchSize(
        affectedFiles,
        options?.patchSizeMeasurement ??
          (await measurePatchSize(repoDir, diffContent, affectedFiles, config)),
        patchTier,
        config
      );

  const issues = [
    ...sizeIssues,
    ...cssIssues,
    ...headerIssues,
    ...modifiedHeaderIssues,
    ...jsIssues,
    ...modCommentIssues,
    ...mozBuildIssues,
  ];

  if (options?.precomputedCheckJs) {
    // Per-patch lint built one queue-wide program and already attributed
    // this patch's findings, so append them instead of rebuilding the program.
    issues.push(...options.precomputedCheckJs);
  } else if (config.patchLint?.checkJs) {
    issues.push(
      ...(await invokePatchLintCheckJs(
        repoDir,
        patchOwnedFiles,
        config.patchLint,
        dirname(repoDir),
        options?.checkJsReportScope
      ))
    );
    // Export-time twin of per-patch lint's test-file pass, so
    // export/re-export and `lint --per-patch` agree on the checked surface.
    if (config.patchLint.checkJsTestFiles === true) {
      const testGrouped = await runCheckJsTestFilesGrouped(
        repoDir,
        resolvePatchOwnedTestScripts(newFiles, patchQueueCtx),
        config.patchLint,
        dirname(repoDir),
        undefined,
        patchQueueCtx ? resolvableModulesForTests(patchQueueCtx) : undefined
      );
      issues.push(...testGrouped.global);
      for (const [rel, list] of testGrouped.byFile) {
        if (options?.checkJsReportScope && !options.checkJsReportScope.has(rel)) continue;
        issues.push(...list);
      }
    }
  }

  // Prettier over patch-owned .sys.mjs. Kept out of the
  // precomputedCheckJs short-circuit on purpose: it is a separate tool with
  // its own gate, and a queue-wide program has no equivalent to share.
  // Scoped to the files this patch owns, run from engine/ so its own config
  // and ignore file decide (see `patch-lint-prettier.ts`).
  const prettierGate = config.patchLint?.prettier ?? 'off';
  if (prettierGate !== 'off' && patchOwnedFiles.size > 0) {
    const scoped = [...patchOwnedFiles].filter(
      (file) => !options?.checkJsReportScope || options.checkJsReportScope.has(file)
    );
    issues.push(
      ...(await invokePatchLintPrettier(repoDir, dirname(repoDir), scoped.sort(), prettierGate))
    );
  }

  // Filter out ignored checks last so every rule still runs (keeps the
  // implementation uniform) but suppressed rules do not surface. We do not
  // reclassify severities: an ignored error simply drops, mirroring how
  // inline `fireforge-ignore: <check>` markers work in the CSS and
  // forward-import rules.
  // A ceiling entry (see `patch-lint-ignore.ts`) drops a size finding only
  // while its measurement stays at or below the ceiling.
  const { kept, suppressed } = partitionLintIgnoredIssues(issues, ignoreChecks);
  if (suppressed.length > 0) {
    options?.onSuppressed?.(suppressed);
  }
  return kept;
}
