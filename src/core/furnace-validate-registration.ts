// SPDX-License-Identifier: EUPL-1.2
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  CustomComponentConfig,
  FurnaceConfig,
  RegistrationStatus,
  StepError,
  ValidationIssue,
} from '../types/furnace.js';
import { toError } from '../utils/errors.js';
import { pathExists, readText } from '../utils/fs.js';
import { warn } from '../utils/logger.js';
import { escapeRegex, stripJsComments } from '../utils/regex.js';
import { getProjectPaths, loadConfig } from './config.js';
import { normalizeForChecksum } from './furnace-checksum-utils.js';
import { getFurnacePaths } from './furnace-config.js';
import { CUSTOM_ELEMENTS_JS, FTL_DIR, JAR_MN } from './furnace-constants.js';
import { expandCssFragments, listFragmentIncludes } from './furnace-css-fragments.js';
import { findStaleJarMnEntries } from './furnace-registration.js';
import { isTagAlreadyRegistered } from './furnace-registration-ast.js';
import { isTagInCorrectCustomElementsPlacement } from './furnace-registration-validate.js';
import { getTokensCssPath } from './token-manager.js';

/**
 * Validates that all Furnace-managed .mjs components are registered in the
 * DOMContentLoaded/importESModule block (Pattern B), not the loadSubScript
 * block (Pattern A).
 *
 * @param root - Project root directory
 * @param config - Furnace configuration
 * @returns Array of validation issues for mis-placed registrations
 */
export async function validateRegistrationPatterns(
  root: string,
  config: FurnaceConfig
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const { engine: engineDir } = getProjectPaths(root);
  const filePath = join(engineDir, CUSTOM_ELEMENTS_JS);

  if (!(await pathExists(filePath))) {
    return issues;
  }

  const content = await readText(filePath);

  // Get all custom component tag names that use .mjs (all custom components do)
  for (const [name, customConfig] of Object.entries(config.custom)) {
    if (!customConfig.register) continue;

    // A component that is not mentioned at all is a distinct defect from one
    // registered in the wrong block: `--fix` can repair the former (idempotent
    // insert) but deliberately refuses the latter (moving code between blocks).
    if (!isTagAlreadyRegistered(content, name)) {
      issues.push({
        component: name,
        severity: 'error',
        check: 'missing-custom-element-registration',
        message: `${name} has register: true but no registration in ${CUSTOM_ELEMENTS_JS}. Run "fireforge furnace validate ${name} --fix" to add it.`,
      });
      continue;
    }

    const stripped = stripJsComments(content);
    const tagPattern = new RegExp(`["']${escapeRegex(name)}["']`);
    if (tagPattern.test(stripped) && !isTagInCorrectCustomElementsPlacement(content, name, true)) {
      issues.push({
        component: name,
        severity: 'error',
        check: 'wrong-registration-pattern',
        message: `${name} is registered in the loadSubScript block (Pattern A) instead of the DOMContentLoaded/importESModule block (Pattern B). .mjs components must use Pattern B or they will fail at runtime.`,
      });
    }
  }

  return issues;
}

/**
 * Checks registration consistency for a single custom component.
 *
 * Compares source files, engine target files, jar.mn entries, and
 * customElements.js registration for a given component.
 *
 * @param root - Project root directory
 * @param name - Component tag name
 * @param config - Custom component configuration
 * @returns Registration status with per-check booleans and drift info
 */
export async function checkRegistrationConsistency(
  root: string,
  name: string,
  config: CustomComponentConfig,
  ftlDir?: string
): Promise<RegistrationStatus> {
  const { engine: engineDir } = getProjectPaths(root);
  const furnacePaths = getFurnacePaths(root);
  const componentDir = join(furnacePaths.customDir, name);

  const status: RegistrationStatus = {
    sourceExists: false,
    targetExists: false,
    filesInSync: true,
    jarMnCss: false,
    jarMnMjs: false,
    customElementsPresent: false,
    customElementsCorrectBlock: false,
    driftedFiles: [],
    missingTargetFiles: [],
  };

  // Check source directory
  status.sourceExists = await pathExists(componentDir);
  if (!status.sourceExists) return status;

  // Check target directory
  const targetDir = join(engineDir, config.targetPath);
  status.targetExists = await pathExists(targetDir);

  // Compare files (sourceExists is guaranteed true — we early-returned above)
  if (status.targetExists) {
    const entries = await readdir(componentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.mjs') && !entry.name.endsWith('.css')) continue;

      const srcPath = join(componentDir, entry.name);
      const destPath = join(targetDir, entry.name);

      if (!(await pathExists(destPath))) {
        status.missingTargetFiles.push(entry.name);
        status.filesInSync = false;
        continue;
      }

      // Deploy writes CSS-with-include-directives in fragment-expanded form,
      // so the drift oracle must compare the *expanded* source — otherwise a
      // freshly deployed component would read as permanently drifted, and a
      // fragment edit would never read as drifted at all.
      let srcContent = await readText(srcPath);
      if (entry.name.endsWith('.css') && listFragmentIncludes(srcContent).length > 0) {
        try {
          srcContent = (await expandCssFragments(srcContent, furnacePaths.sharedDir)).expanded;
        } catch {
          // Missing fragment: validate reports it as `missing-fragment`;
          // for drift purposes fall back to the raw source so the compare
          // still happens deterministically.
        }
      }
      const destContent = await readText(destPath);
      // Same normalization the checksums written by apply use. These three
      // comparisons hashed raw bytes, so on a CRLF checkout `furnace status`
      // and `furnace validate` reported drift for files apply had just
      // decided were identical.
      const srcHash = createHash('sha256').update(normalizeForChecksum(srcContent)).digest('hex');
      const destHash = createHash('sha256').update(normalizeForChecksum(destContent)).digest('hex');

      if (srcHash !== destHash) {
        status.driftedFiles.push(entry.name);
        status.filesInSync = false;
      }
    }
  } else {
    status.filesInSync = false;
  }

  // Localized components deploy a .ftl file outside `targetDir` (into the
  // shared Fluent tree). The .mjs/.css loop above cannot see it, so drift
  // there would otherwise be invisible to apply's fast-path and to `status`.
  if (config.localized) {
    const ftlName = `${name}.ftl`;
    const ftlSrc = join(componentDir, ftlName);
    if (await pathExists(ftlSrc)) {
      const ftlDest = join(engineDir, ftlDir ?? FTL_DIR, ftlName);
      if (!(await pathExists(ftlDest))) {
        status.missingTargetFiles.push(ftlName);
        status.filesInSync = false;
      } else {
        const srcContent = await readText(ftlSrc);
        const destContent = await readText(ftlDest);
        const srcHash = createHash('sha256').update(normalizeForChecksum(srcContent)).digest('hex');
        const destHash = createHash('sha256')
          .update(normalizeForChecksum(destContent))
          .digest('hex');
        if (srcHash !== destHash) {
          status.driftedFiles.push(ftlName);
          status.filesInSync = false;
        }
      }
    }
  }

  // Check jar.mn entries
  const jarMnPath = join(engineDir, JAR_MN);
  if (await pathExists(jarMnPath)) {
    const jarContent = await readText(jarMnPath);
    status.jarMnCss = jarContent.includes(`content/global/elements/${name}.css`);
    status.jarMnMjs = jarContent.includes(`content/global/elements/${name}.mjs`);
  }

  // Check customElements.js registration
  const cePath = join(engineDir, CUSTOM_ELEMENTS_JS);
  if (await pathExists(cePath)) {
    const ceContent = await readText(cePath);
    // Structure-aware check shared with the ADD path — a bare substring
    // test counted any mention of the tag (a leftover comment, an
    // unrelated string) as "registered", masking genuinely missing
    // registrations from both validate and the re-apply drift oracle.
    status.customElementsPresent = isTagAlreadyRegistered(ceContent, name);

    if (status.customElementsPresent) {
      status.customElementsCorrectBlock = isTagInCorrectCustomElementsPlacement(
        ceContent,
        name,
        true
      );
    }
  }

  return status;
}

/**
 * Validates that each custom component with `register: true` has its .mjs and
 * .css entries in jar.mn.
 *
 * @param root - Project root directory
 * @param config - Furnace configuration
 * @returns Array of validation issues for missing jar.mn entries
 */
export async function validateJarMnEntries(
  root: string,
  config: FurnaceConfig
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const { engine: engineDir } = getProjectPaths(root);
  const jarMnPath = join(engineDir, JAR_MN);

  if (!(await pathExists(jarMnPath))) {
    return issues;
  }

  const jarContent = await readText(jarMnPath);
  const furnacePaths = getFurnacePaths(root);

  for (const [name, customConfig] of Object.entries(config.custom)) {
    if (!customConfig.register) continue;

    if (!jarContent.includes(`content/global/elements/${name}.mjs`)) {
      issues.push({
        component: name,
        severity: 'error',
        check: 'missing-jar-mn-mjs',
        message: `${name}.mjs is not registered in jar.mn. Run "fireforge furnace deploy" to register.`,
      });
    }

    // Only complain about a missing CSS entry when the source actually
    // ships a CSS file. Components that intentionally have no CSS would
    // otherwise generate a permanent false-positive that trains developers
    // to ignore validator output.
    const cssSourcePath = join(furnacePaths.customDir, name, `${name}.css`);
    if (
      (await pathExists(cssSourcePath)) &&
      !jarContent.includes(`content/global/elements/${name}.css`)
    ) {
      issues.push({
        component: name,
        severity: 'warning',
        check: 'missing-jar-mn-css',
        message: `${name}.css is not registered in jar.mn.`,
      });
    }
  }

  // Stale registrations: lines pointing at component files that no longer
  // exist in the workspace, left behind by a rename or delete. These break
  // `mach build` at packaging ("File ... not found"), so they are errors and
  // `--fix` prunes them.
  const staleEntries = await findStaleJarMnEntries(
    engineDir,
    furnacePaths.customDir,
    Object.keys(config.custom)
  );
  for (const stale of staleEntries) {
    issues.push({
      component: stale.tagName,
      severity: 'error',
      check: 'stale-jar-registration',
      message:
        `jar.mn registers ${stale.fileName} for ${stale.tagName}, but the source file no longer exists ` +
        `(stale line: "${stale.line}"). Packaging will fail until the line is removed — run ` +
        '"fireforge furnace validate --fix" or "fireforge doctor --repair-furnace" to prune it.',
    });
  }

  return issues;
}

/**
 * Default chrome host document scanned by `validateTokenLink` when
 * `tokenHostDocuments` is not configured in furnace.json.
 */
const DEFAULT_TOKEN_HOST_DOCUMENTS = ['browser/base/content/browser.xhtml'];

/**
 * Directory scanned for additional chrome host documents that mount the
 * component under audit. Kept narrow (top-level `browser/base/content/`)
 * so the auto-detection stays cheap and only triggers on the well-known
 * location forks use for replacement chrome documents.
 */
const AUTO_DETECT_HOST_DIR = 'browser/base/content';

/**
 * Scans `browser/base/content/*.xhtml` for chrome documents that reference
 * `tagName`. Returned paths are engine-relative and deduplicated against
 * `already`, so callers can merge them with the caller-configured set
 * without producing double entries in warning output.
 *
 * This catches a fork that mounts a custom element from its own top-level
 * chrome document (e.g. `mybrowser.xhtml`) without setting
 * `tokenHostDocuments`: scanning only the stock `browser.xhtml` would miss
 * the tokens CSS link in the ACTUAL host document and false-fire the
 * warning.
 *
 * @param engineDir Absolute engine root.
 * @param tagName Custom element tag the CSS belongs to.
 * @param already Paths already in the scan set (POSIX, engine-relative).
 */
/**
 * Per-run caches for work that is invariant across components.
 *
 * `validateAllComponents` walks every component, and re-parsing
 * `fireforge.json` plus re-scanning every `.xhtml` under the chrome-document
 * directory per component is one config parse and one full directory read
 * PER COMPONENT, for work that depends only on the project and the engine.
 *
 * Keyed by root/engine dir and cleared by
 * {@link resetRegistrationValidationCaches} at the start of each run, so a
 * long-lived process (the test suite, `watch`) never serves a stale read.
 */
const tokensCssFileNameCache = new Map<string, string>();
const chromeDocumentCache = new Map<string, Map<string, string>>();

/**
 * Whether a batch validation is in flight.
 *
 * The caches are consulted ONLY while this is set. Outside a batch — a direct
 * `validateComponent` call from `furnace status`, from apply's consistency
 * check, or from a test — every read goes to disk, so a caller that mutates
 * the engine between calls can never be served a stale document.
 */
let batchInFlight = false;

/**
 * Runs `body` with the per-run caches enabled, then clears them.
 *
 * @param body - The batch to run
 * @returns Whatever `body` resolves to
 */
export async function withRegistrationValidationCache<T>(body: () => Promise<T>): Promise<T> {
  const outer = batchInFlight;
  batchInFlight = true;
  try {
    return await body();
  } finally {
    batchInFlight = outer;
    if (!outer) {
      tokensCssFileNameCache.clear();
      chromeDocumentCache.clear();
    }
  }
}

/**
 * Reads every chrome document under the auto-detect directory once per run.
 *
 * @param engineDir - Absolute path to the engine checkout
 * @returns Map of engine-relative document path to its content
 */
async function loadChromeDocuments(engineDir: string): Promise<Map<string, string>> {
  const cached = batchInFlight ? chromeDocumentCache.get(engineDir) : undefined;
  if (cached) return cached;

  const documents = new Map<string, string>();
  const contentDir = join(engineDir, AUTO_DETECT_HOST_DIR);
  if (await pathExists(contentDir)) {
    let entries: string[];
    try {
      entries = await readdir(contentDir);
    } catch {
      // No readable chrome-document directory means no documents reference
      // the tag, which is the same verdict as an empty directory.
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.endsWith('.xhtml')) continue;
      const rel = `${AUTO_DETECT_HOST_DIR}/${entry}`;
      try {
        documents.set(rel, await readText(join(contentDir, entry)));
      } catch {
        // Unreadable document: treated as not referencing the tag.
      }
    }
  }
  if (batchInFlight) chromeDocumentCache.set(engineDir, documents);
  return documents;
}

async function autoDetectTokenHostDocuments(
  engineDir: string,
  tagName: string,
  already: Iterable<string>
): Promise<string[]> {
  // Reads the directory ONCE per run rather than once per component: only the
  // tag being searched for differs between components.
  const documents = await loadChromeDocuments(engineDir);
  const alreadySet = new Set(already);
  const detected: string[] = [];
  for (const [relPath, content] of documents) {
    if (alreadySet.has(relPath)) continue;
    if (content.includes(tagName)) {
      detected.push(relPath);
    }
  }
  return detected;
}

/**
 * Validates that components using design tokens have the tokens CSS
 * linked in at least one chrome host document. Without the link, tokens
 * silently resolve to nothing at runtime.
 *
 * Scan set is the union of (a) the configured `tokenHostDocuments` (or
 * the upstream default when unset) and (b) any `browser/base/content/*.xhtml`
 * document that references `tagName` — the auto-detection path catches
 * forks that mount components from a replacement chrome document without
 * having configured `tokenHostDocuments`. The warning fires only when
 * NONE of the documents in the final scan set link the tokens CSS.
 */
export async function validateTokenLink(
  componentDir: string,
  tagName: string,
  root: string,
  tokenPrefix?: string,
  tokenHostDocuments?: string[]
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const cssPath = join(componentDir, `${tagName}.css`);

  if (!(await pathExists(cssPath))) return issues;
  if (!tokenPrefix) return issues;

  const cssContent = await readText(cssPath);

  // Check if the component CSS references any tokens with the configured prefix
  if (!cssContent.includes(tokenPrefix)) return issues;

  const { engine: engineDir } = getProjectPaths(root);
  const configuredHosts =
    tokenHostDocuments && tokenHostDocuments.length > 0
      ? tokenHostDocuments
      : DEFAULT_TOKEN_HOST_DOCUMENTS;

  let tokensCssFile: string;
  try {
    // Cached per run: the filename depends on `binaryName` alone, so parsing
    // fireforge.json once per token-using component was pure repetition.
    const cachedName = batchInFlight ? tokensCssFileNameCache.get(root) : undefined;
    if (cachedName !== undefined) {
      tokensCssFile = cachedName;
    } else {
      const forgeConfig = await loadConfig(root);
      const segments = getTokensCssPath(forgeConfig.binaryName).split('/');
      tokensCssFile = segments[segments.length - 1] ?? '';
      if (batchInFlight) tokensCssFileNameCache.set(root, tokensCssFile);
    }
  } catch (error: unknown) {
    const reason = toError(error).message;
    warn(`Could not resolve token CSS link target for ${tagName} during validation: ${reason}`);
    return issues;
  }

  const autoDetected = await autoDetectTokenHostDocuments(engineDir, tagName, configuredHosts);
  const hostDocuments = [...configuredHosts, ...autoDetected];

  const checkedDocuments: string[] = [];
  let anyLinks = false;
  for (const relDocPath of hostDocuments) {
    const absPath = join(engineDir, relDocPath);
    if (!(await pathExists(absPath))) continue;
    checkedDocuments.push(relDocPath);
    const xhtmlContent = await readText(absPath);
    if (xhtmlContent.includes(tokensCssFile)) {
      anyLinks = true;
      break;
    }
  }

  if (checkedDocuments.length === 0) return issues;

  if (!anyLinks) {
    const docsList = checkedDocuments.join(', ');
    issues.push({
      component: tagName,
      severity: 'warning',
      check: 'missing-token-link',
      message: `Component uses ${tokenPrefix}* tokens but none of the scanned chrome host documents (${docsList}) link ${tokensCssFile}. Tokens will silently resolve to nothing. Configure additional hosts via furnace.json "tokenHostDocuments" if needed.`,
    });
  }

  return issues;
}

/**
 * Post-apply registration consistency check for custom components.
 *
 * Detects customElements.js / jar.mn inconsistencies caused by a partial
 * apply. Errors are surfaced as step-level warnings on the affected
 * component rather than blocking the entire apply.
 */
export async function runPostApplyConsistencyChecks(
  root: string,
  config: { custom: Record<string, CustomComponentConfig> },
  result: { applied: Array<{ name: string; stepErrors?: StepError[] }> },
  ftlDir: string
): Promise<void> {
  for (const [name, customConfig] of Object.entries(config.custom)) {
    if (!customConfig.register) continue;
    if (!result.applied.some((a) => a.name === name)) continue;
    try {
      const status = await checkRegistrationConsistency(root, name, customConfig, ftlDir);
      const issues: string[] = [];
      if (!status.customElementsPresent) {
        issues.push('missing customElements.js registration');
      }
      if (!status.jarMnMjs && status.sourceExists) {
        issues.push('missing jar.mn .mjs entry');
      }
      if (issues.length > 0) {
        const entry = result.applied.find((a) => a.name === name);
        if (entry) {
          const stepErrors = entry.stepErrors ?? [];
          stepErrors.push({
            step: 'post-apply consistency',
            error: `Registration inconsistency: ${issues.join(', ')}`,
          });
          entry.stepErrors = stepErrors;
        }
      }
    } catch {
      // Consistency check is best-effort; failures here should not block apply
    }
  }
}
