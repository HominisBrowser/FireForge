// SPDX-License-Identifier: EUPL-1.2
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { ComponentType, ValidationIssue } from '../types/furnace.js';
import { pathExists } from '../utils/fs.js';

/**
 * Validates the file structure of a component directory.
 * Checks for required files and naming conventions.
 */
export async function validateStructure(
  componentDir: string,
  tagName: string,
  type: ComponentType
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const mjsPath = join(componentDir, `${tagName}.mjs`);
  const cssPath = join(componentDir, `${tagName}.css`);

  // .mjs must exist for custom components
  if (type === 'custom' && !(await pathExists(mjsPath))) {
    issues.push({
      component: tagName,
      severity: 'error',
      check: 'missing-mjs',
      message: `Required file ${tagName}.mjs not found.`,
    });
  }

  // .css should exist
  if (!(await pathExists(cssPath))) {
    issues.push({
      component: tagName,
      severity: 'warning',
      check: 'missing-css',
      message: `No ${tagName}.css found. Consider adding styles.`,
    });
  }

  // File names should match tag name
  const entries = await readdir(componentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.mjs') && !entry.name.endsWith('.css')) continue;

    const fileName = entry.name;
    if (/\.(test|spec|stories)\./.test(fileName)) continue;

    const expectedPrefix = tagName;
    const nameWithoutExt = entry.name.replace(/\.(mjs|css)$/, '');
    if (nameWithoutExt !== expectedPrefix && !nameWithoutExt.startsWith(expectedPrefix + '-')) {
      issues.push({
        component: tagName,
        severity: 'error',
        check: 'filename-mismatch',
        message: `File "${entry.name}" does not match expected naming convention "${tagName}.*".`,
      });
    }
  }

  // override.json must exist for overrides
  if (type === 'override') {
    const overrideJsonPath = join(componentDir, 'override.json');
    if (!(await pathExists(overrideJsonPath))) {
      issues.push({
        component: tagName,
        severity: 'error',
        check: 'missing-override-json',
        message: 'Required file override.json not found for override component.',
      });
    }
  }

  return issues;
}
