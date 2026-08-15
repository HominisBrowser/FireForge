// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import type { ComponentType, FurnaceConfig, ValidationIssue } from '../types/furnace.js';
import { pathExists, readText } from '../utils/fs.js';
import { escapeRegex, hasRawCssColors } from '../utils/regex.js';
import {
  classExtendsMozLitElement,
  collectCssVariableDeclarations,
  collectCssVariableReferences,
  createIssue,
  getTokenPrefixContext,
  hasCustomElementDefineCall,
  hasRelativeModuleImport,
  stripCssBlockComments,
} from './furnace-validate-helpers.js';

async function validateMjsCompatibility(
  mjsPath: string,
  tagName: string,
  isLibrary: boolean
): Promise<ValidationIssue[]> {
  if (!(await pathExists(mjsPath))) return [];
  const mjsContent = await readText(mjsPath);
  const issues: ValidationIssue[] = [];

  if (hasRelativeModuleImport(mjsContent)) {
    issues.push(
      createIssue(
        tagName,
        'error',
        'relative-import',
        'Imports must use chrome:// URIs, not relative paths.'
      )
    );
  }

  // A library component (kind: "library") deliberately defines no element:
  // it exports a base class + helpers for other components to extend, so
  // the define/extends requirements do not apply.
  if (isLibrary) {
    return issues;
  }

  if (!hasCustomElementDefineCall(mjsContent)) {
    issues.push(
      createIssue(
        tagName,
        'error',
        'no-custom-element-define',
        'Missing customElements.define() call. Component will not be registered.'
      )
    );
  }

  if (!classExtendsMozLitElement(mjsContent)) {
    issues.push(
      createIssue(
        tagName,
        'error',
        'not-moz-lit-element',
        'Component class must extend MozLitElement.'
      )
    );
  }

  return issues;
}

async function validateCssCompatibility(
  cssPath: string,
  tagName: string,
  type: ComponentType,
  config?: FurnaceConfig,
  root?: string
): Promise<ValidationIssue[]> {
  if (!(await pathExists(cssPath))) return [];
  const rawCss = await readText(cssPath);
  const cssContent = stripCssBlockComments(rawCss);
  const issues: ValidationIssue[] = [];

  if (hasRawCssColors(cssContent)) {
    issues.push(
      createIssue(
        tagName,
        'error',
        'raw-color-value',
        'Raw color value found. Use CSS custom properties (var(--...)) for design token consistency.'
      )
    );
  }

  if (config?.tokenPrefix) {
    const { allowlist, inheritedOverrideVars, runtimeVariables } = await getTokenPrefixContext(
      tagName,
      type,
      config,
      root
    );

    // Auto-exempt component-local runtime channels: a CSS custom property
    // both declared and consumed in the same file is a runtime state
    // channel (e.g. `--cam-x`), not a design-token reference. See
    // `runtimeVariables` in furnace.json for cross-component cases.
    const localDeclarations = collectCssVariableDeclarations(cssContent);

    for (const prop of collectCssVariableReferences(cssContent)) {
      if (prop.startsWith(config.tokenPrefix)) continue;
      if (allowlist.has(prop)) continue;
      if (inheritedOverrideVars.has(prop)) continue;
      if (runtimeVariables.has(prop)) continue;
      if (localDeclarations.has(prop)) continue;

      issues.push(
        createIssue(
          tagName,
          'error',
          'token-prefix-violation',
          `CSS references var(${prop}) which does not match the required token prefix "${config.tokenPrefix}". Use a design token, add to tokenAllowlist, or (for runtime state channels) list the variable in runtimeVariables.`
        )
      );
    }
  }

  // Flag excessive !important usage
  const importantCount = (cssContent.match(/!important/g) ?? []).length;
  if (importantCount > 3) {
    issues.push(
      createIssue(
        tagName,
        'warning',
        'excessive-important',
        `Found ${importantCount} uses of !important. Minimize !important to avoid specificity issues; prefer structural CSS changes.`
      )
    );
  }

  // Check for animations without prefers-reduced-motion
  if (
    /(?:animation|transition)\s*:/m.test(cssContent) &&
    !/@media\s*\(\s*prefers-reduced-motion/m.test(rawCss)
  ) {
    issues.push(
      createIssue(
        tagName,
        'warning',
        'missing-reduced-motion',
        'CSS uses animation or transition without a prefers-reduced-motion media query. Add one for accessibility.'
      )
    );
  }

  // Check for prefers-color-scheme without design token usage
  if (/@media\s*\(\s*prefers-color-scheme/m.test(rawCss)) {
    issues.push(
      createIssue(
        tagName,
        'warning',
        'prefers-color-scheme',
        'CSS contains a prefers-color-scheme media query. Prefer using design tokens (CSS custom properties) for theming consistency.'
      )
    );
  }

  return issues;
}

/**
 * Checks whether a tag name appears in an HTML template context (as an element
 * tag in a template literal) or as a CSS tag selector. Substring matches in
 * string literals, comments, or variable names are excluded.
 */
function isReferencedAsElement(source: string, tagName: string): boolean {
  // Match as an HTML element: <tagName or </tagName
  const htmlPattern = new RegExp(`</?${escapeRegex(tagName)}[\\s/>]`);
  if (htmlPattern.test(source)) return true;

  // Match as a CSS tag selector: standalone word at start of line or after combinators
  const cssPattern = new RegExp(`(?:^|[\\s,>+~])${escapeRegex(tagName)}(?:[\\s,{:>+~.[#]|$)`, 'm');
  if (cssPattern.test(source)) return true;

  // Also accept querySelector/querySelectorAll('tagName') as intentional usage
  const querySelectorPattern = new RegExp(
    `querySelector(?:All)?\\(\\s*["'\`]${escapeRegex(tagName)}(?:[\\s"'\`.,>+~:[#])`
  );
  if (querySelectorPattern.test(source)) return true;

  return false;
}

/**
 * Validates that composed tags declared in furnace.json are actually referenced
 * in the component's source (.mjs and .css) in an HTML template or CSS context.
 * A compose entry that is not referenced as an element tag is likely a metadata
 * error.
 */
async function validateComposeReferences(
  componentDir: string,
  tagName: string,
  composes: string[]
): Promise<ValidationIssue[]> {
  if (composes.length === 0) return [];

  const issues: ValidationIssue[] = [];
  const mjsPath = join(componentDir, `${tagName}.mjs`);
  const cssPath = join(componentDir, `${tagName}.css`);

  let mjsContent = '';
  let cssContent = '';

  if (await pathExists(mjsPath)) {
    mjsContent = await readText(mjsPath);
  }
  if (await pathExists(cssPath)) {
    cssContent = await readText(cssPath);
  }

  const combinedSource = mjsContent + cssContent;

  for (const composed of composes) {
    if (!isReferencedAsElement(combinedSource, composed)) {
      issues.push(
        createIssue(
          tagName,
          'warning',
          'compose-not-referenced',
          `Declares composition of "${composed}" but no HTML template or CSS selector reference found in source files. Remove the entry from composes or add a reference.`
        )
      );
    }
  }

  return issues;
}

/**
 * Validates compatibility patterns in a component's .mjs and .css files.
 * Checks imports, class hierarchy, registration, design tokens, and compose references.
 */
export async function validateCompatibility(
  componentDir: string,
  tagName: string,
  type: ComponentType,
  config?: FurnaceConfig,
  root?: string
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const mjsPath = join(componentDir, `${tagName}.mjs`);
  const cssPath = join(componentDir, `${tagName}.css`);

  const isLibrary = type === 'custom' && config?.custom[tagName]?.kind === 'library';
  const mjsIssues = await validateMjsCompatibility(mjsPath, tagName, isLibrary);
  issues.push(...mjsIssues);

  const cssIssues = await validateCssCompatibility(cssPath, tagName, type, config, root);
  issues.push(...cssIssues);

  // Compose reference validation (custom components only)
  if (type === 'custom' && config) {
    const customConfig = config.custom[tagName];
    if (customConfig?.composes && customConfig.composes.length > 0) {
      issues.push(
        ...(await validateComposeReferences(componentDir, tagName, customConfig.composes))
      );

      // Warn when a composed component is not registered in furnace.json
      const allKnown = new Set([
        ...config.stock,
        ...Object.keys(config.overrides),
        ...Object.keys(config.custom),
      ]);
      for (const composed of customConfig.composes) {
        if (!allKnown.has(composed)) {
          issues.push(
            createIssue(
              tagName,
              'warning',
              'compose-not-registered',
              `Composes "${composed}" which is not registered in furnace.json. ` +
                'The dependency may be missing at runtime. Add it as stock, override, or custom.'
            )
          );
        }
      }
    }
  }

  return issues;
}
