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
import { stripJsComments } from '../utils/regex.js';
import { getProjectPaths, loadConfig } from './config.js';
import { getFurnacePaths } from './furnace-config.js';
import { CUSTOM_ELEMENTS_JS, FTL_DIR, JAR_MN } from './furnace-constants.js';
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

  // Find the DOMContentLoaded block boundary (handles multi-line addEventListener)
  const dclMatch = /document\.addEventListener\(\s*["']DOMContentLoaded["']/.exec(content);

  if (!dclMatch) {
    return issues;
  }

  const domContentLoadedIdx = dclMatch.index;

  // Get all custom component tag names that use .mjs (all custom components do)
  for (const [name, customConfig] of Object.entries(config.custom)) {
    if (!customConfig.register) continue;

    // Check if this tag is referenced before the DOMContentLoaded block
    const contentBeforeDCL = stripJsComments(content.slice(0, domContentLoadedIdx));
    const tagPattern = new RegExp(`"${name}"`);

    if (tagPattern.test(contentBeforeDCL)) {
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

      const srcContent = await readText(srcPath);
      const destContent = await readText(destPath);
      const srcHash = createHash('sha256').update(srcContent).digest('hex');
      const destHash = createHash('sha256').update(destContent).digest('hex');

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
        const srcHash = createHash('sha256').update(srcContent).digest('hex');
        const destHash = createHash('sha256').update(destContent).digest('hex');
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
    status.customElementsPresent =
      ceContent.includes(`"${name}"`) || ceContent.includes(`'${name}'`);

    if (status.customElementsPresent) {
      // Check it's in the correct block (after DOMContentLoaded)
      const dclMatch = /document\.addEventListener\(\s*["']DOMContentLoaded["']/.exec(ceContent);
      if (dclMatch) {
        const afterDcl = ceContent.slice(dclMatch.index);
        status.customElementsCorrectBlock =
          afterDcl.includes(`"${name}"`) || afterDcl.includes(`'${name}'`);
      }
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

  return issues;
}

/**
 * Validates that components using design tokens have the tokens CSS
 * linked in browser.xhtml. Without the link, tokens silently resolve to nothing.
 */
export async function validateTokenLink(
  componentDir: string,
  tagName: string,
  root: string,
  tokenPrefix?: string
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const cssPath = join(componentDir, `${tagName}.css`);

  if (!(await pathExists(cssPath))) return issues;
  if (!tokenPrefix) return issues;

  const cssContent = await readText(cssPath);

  // Check if the component CSS references any tokens with the configured prefix
  if (!cssContent.includes(tokenPrefix)) return issues;

  // Check if browser.xhtml links the token CSS file
  const { engine: engineDir } = getProjectPaths(root);
  const browserXhtmlPath = join(engineDir, 'browser/base/content/browser.xhtml');

  if (!(await pathExists(browserXhtmlPath))) return issues;

  let tokensCssFile: string;
  try {
    const forgeConfig = await loadConfig(root);
    const segments = getTokensCssPath(forgeConfig.binaryName).split('/');
    tokensCssFile = segments[segments.length - 1] ?? '';
  } catch (error: unknown) {
    const reason = toError(error).message;
    warn(`Could not resolve token CSS link target for ${tagName} during validation: ${reason}`);
    return issues;
  }

  const xhtmlContent = await readText(browserXhtmlPath);
  if (!xhtmlContent.includes(tokensCssFile)) {
    issues.push({
      component: tagName,
      severity: 'warning',
      check: 'missing-token-link',
      message: `Component uses ${tokenPrefix}* tokens but browser.xhtml does not link ${tokensCssFile}. Tokens will silently resolve to nothing.`,
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
