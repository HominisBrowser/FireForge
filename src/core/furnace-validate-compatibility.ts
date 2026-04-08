// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import type { ComponentType, FurnaceConfig, ValidationIssue } from '../types/furnace.js';
import { pathExists, readText } from '../utils/fs.js';
import { hasRawCssColors } from '../utils/regex.js';
import {
  classExtendsMozLitElement,
  collectCssVariableReferences,
  createIssue,
  getTokenPrefixContext,
  hasCustomElementDefineCall,
  hasRelativeModuleImport,
  stripCssBlockComments,
} from './furnace-validate-helpers.js';

async function validateMjsCompatibility(
  mjsPath: string,
  tagName: string
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
    const { allowlist, inheritedOverrideVars } = await getTokenPrefixContext(
      tagName,
      type,
      config,
      root
    );

    for (const prop of collectCssVariableReferences(cssContent)) {
      if (
        !prop.startsWith(config.tokenPrefix) &&
        !allowlist.has(prop) &&
        !inheritedOverrideVars.has(prop)
      ) {
        issues.push(
          createIssue(
            tagName,
            'error',
            'token-prefix-violation',
            `CSS references var(${prop}) which does not match the required token prefix "${config.tokenPrefix}". Use a design token or add to tokenAllowlist.`
          )
        );
      }
    }
  }

  return issues;
}

/**
 * Validates compatibility patterns in a component's .mjs and .css files.
 * Checks imports, class hierarchy, registration, and design tokens.
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

  const mjsIssues = await validateMjsCompatibility(mjsPath, tagName);
  issues.push(...mjsIssues);

  const cssIssues = await validateCssCompatibility(cssPath, tagName, type, config, root);
  issues.push(...cssIssues);

  return issues;
}
