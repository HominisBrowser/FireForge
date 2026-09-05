// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import type { ComponentType, FurnaceConfig, ValidationIssue } from '../types/furnace.js';
import { pathExists, readText } from '../utils/fs.js';
import { escapeRegex, hasRawCssColors } from '../utils/regex.js';
import { getProjectPaths } from './config.js';
import { createIssue } from './furnace-validate-helpers.js';

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

/** Removes CSS block comments before running simple string-based checks. */
function stripCssBlockComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Detects relative ES module imports in a component module file. */
function hasRelativeModuleImport(mjsContent: string): boolean {
  return (
    /^\s*import\s.*from\s+["']\.\.?\//m.test(mjsContent) ||
    /^\s*import\s+["']\.\.?\//m.test(mjsContent)
  );
}

/** Detects whether a module defines a custom element at runtime. */
function hasCustomElementDefineCall(mjsContent: string): boolean {
  return /customElements\.define\s*\(/.test(mjsContent);
}

/**
 * Detects whether the module's `customElements.define(...)` call includes a
 * literal `extends:` option (third argument). That shape is the marker for
 * a customized built-in element: the class extends a specific
 * `HTMLxxxElement` rather than the autonomous `MozLitElement` path.
 *
 * Firefox's own widgets use this pattern for toolkit anchors (e.g.
 * `moz-support-link` extends `HTMLAnchorElement` with
 * `customElements.define("moz-support-link", ..., { extends: "a" })`), and
 * the validator's `not-moz-lit-element` check must allow them through or
 * `furnace override` of a valid upstream component fails its own
 * `furnace validate` pass with nothing the operator can fix.
 */
function hasCustomElementExtendsOption(mjsContent: string): boolean {
  // Match `customElements.define(..., { ..., extends: "..." })`. Tolerant of
  // whitespace, line breaks, and other object properties. The `[^)]*` stops
  // the inner greedy match at the closing define call paren so a later
  // `define` call on a different custom element in the same module does
  // not bleed its options in.
  return /customElements\.define\s*\([^)]*\bextends\s*:\s*["'`]/.test(mjsContent);
}

/**
 * Checks whether a declared component class extends a valid element base.
 *
 * Two shapes are accepted:
 *
 * 1. Autonomous custom element: `class X extends MozLitElement`, the
 *    default FireForge pattern for fork-authored components and most
 *    toolkit widgets.
 * 2. Customized built-in: `class X extends HTML<Something>Element` paired
 *    with a `customElements.define(..., ..., { extends: "<tagname>" })`
 *    call. Firefox's `moz-support-link`, `moz-button-group` tabbing
 *    widgets, and a handful of other toolkit components use this form.
 *    `furnace override` of those components writes the original source
 *    verbatim and the validator must not reject them.
 *
 * A class that extends a plain `HTMLElement` without an `extends:` option
 * is still rejected. That is the legitimate `not-moz-lit-element` case
 * the rule was originally designed to catch.
 */
function classExtendsMozLitElement(mjsContent: string): boolean {
  const hasClassDeclaration = /class\s+\w+\s+extends\s+/.test(mjsContent);
  if (!hasClassDeclaration) {
    // No class declaration, so skip this check since the component may use a
    // different pattern (e.g. function-based). Other validators will catch
    // structural issues.
    return true;
  }

  if (/class\s+\w+\s+extends\s+MozLitElement\b/.test(mjsContent)) {
    return true;
  }

  // Customized built-in: extend a specific HTMLxxxElement and the define
  // call carries an `extends:` option. Both halves are required: a class
  // that extends `HTMLAnchorElement` without the matching define option is
  // almost certainly an author mistake, and a define call with `extends:`
  // without a matching class is unreachable.
  const extendsCustomizedBuiltin = /class\s+\w+\s+extends\s+HTML[A-Z]\w*Element\b/.test(mjsContent);
  if (extendsCustomizedBuiltin && hasCustomElementExtendsOption(mjsContent)) {
    return true;
  }

  return false;
}

/** Collects CSS custom property references used via var(--token-name). */
function collectCssVariableReferences(cssContent: string): string[] {
  const referencedVariables: string[] = [];
  const variablePattern = /var\(\s*(--[\w-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = variablePattern.exec(cssContent)) !== null) {
    const variableName = match[1];
    if (variableName) {
      referencedVariables.push(variableName);
    }
  }

  return referencedVariables;
}

/**
 * Collects CSS custom property *declarations*, i.e. names appearing on the
 * left-hand side of a `--name:` declaration. Used to auto-exempt
 * component-local runtime variables from the token-prefix check: if the
 * component both declares and consumes a variable in its own CSS file, it
 * is a local runtime channel, not a design-token reference.
 *
 * The anchor `(?:^|[{;,\s])` rules out `var(--name)` occurrences (which are
 * always preceded by `(`), so references are not mistaken for declarations.
 */
function collectCssVariableDeclarations(cssContent: string): Set<string> {
  const declared = new Set<string>();
  const pattern = /(?:^|[{;,\s])(--[\w-]+)\s*:/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(cssContent)) !== null) {
    const name = match[1];
    if (name) declared.add(name);
  }
  return declared;
}

async function collectInheritedOverrideVariables(
  tagName: string,
  config: FurnaceConfig,
  root: string
): Promise<Set<string>> {
  const inheritedVariables = new Set<string>();
  const basePath = config.overrides[tagName]?.basePath;
  if (!basePath) {
    return inheritedVariables;
  }

  const { engine: engineDir } = getProjectPaths(root);
  const originalCssPath = join(engineDir, basePath, `${tagName}.css`);
  if (!(await pathExists(originalCssPath))) {
    return inheritedVariables;
  }

  const originalCssContent = stripCssBlockComments(await readText(originalCssPath));
  for (const variableName of collectCssVariableReferences(originalCssContent)) {
    inheritedVariables.add(variableName);
  }

  return inheritedVariables;
}

/** Builds token-validation context from the config allowlist and inherited override CSS. */
async function getTokenPrefixContext(
  tagName: string,
  type: ComponentType,
  config: FurnaceConfig,
  root: string | undefined
): Promise<{
  allowlist: Set<string>;
  inheritedOverrideVars: Set<string>;
  runtimeVariables: Set<string>;
}> {
  const allowlist = new Set(config.tokenAllowlist ?? []);
  const runtimeVariables = new Set(config.runtimeVariables ?? []);
  if (type !== 'override' || !root) {
    return { allowlist, inheritedOverrideVars: new Set<string>(), runtimeVariables };
  }

  return {
    allowlist,
    inheritedOverrideVars: await collectInheritedOverrideVariables(tagName, config, root),
    runtimeVariables,
  };
}
