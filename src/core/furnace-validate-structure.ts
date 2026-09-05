// SPDX-License-Identifier: EUPL-1.2
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { ComponentType, CustomComponentConfig, ValidationIssue } from '../types/furnace.js';
import { pathExists, readText } from '../utils/fs.js';

/**
 * Returns true when file content carries unresolved three-way-merge
 * conflict markers (as left behind by `furnace refresh`). Shared between
 * the structure validator and `furnace sync`'s pre-apply gate. Both must
 * agree on what "conflicted" means so a file that validate flags can never
 * slip through sync into the engine.
 */
export function containsMergeConflictMarkers(content: string): boolean {
  return /^<{7}\s/m.test(content) || /^>{7}\s/m.test(content) || /^={7}$/m.test(content);
}

/**
 * Validates the file structure of a component directory.
 * Checks for required files and naming conventions.
 *
 * @param componentDir - Component source directory
 * @param tagName - Component tag name
 * @param type - Component type (stock, override, custom)
 * @param customConfig - When `type === 'custom'`, the matching config from
 *   furnace.json. Used to derive `localized`, which gates the `.ftl`
 *   requirement. Optional so existing callers without config in scope (e.g.
 *   the structure-only test fixtures) can keep calling without changes.
 */
export async function validateStructure(
  componentDir: string,
  tagName: string,
  type: ComponentType,
  customConfig?: CustomComponentConfig
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

  // .css should exist, except for library components (base class + helpers,
  // no element of their own), which render nothing and need no stylesheet.
  if (!(await pathExists(cssPath)) && customConfig?.kind !== 'library') {
    issues.push({
      component: tagName,
      severity: 'warning',
      check: 'missing-css',
      message: `No ${tagName}.css found. Consider adding styles.`,
    });
  }

  // Localized custom components must have a {tag}.ftl file. Without one,
  // apply silently deploys nothing for the locale and the runtime
  // localization payload is empty, which is hard to spot in review.
  //
  // Components that declare `sharedFtl` participate in a pre-existing
  // feature-scoped bundle, so there is no per-component .ftl to require.
  // The shared file is owned by whoever authored the feature bundle.
  if (type === 'custom' && customConfig?.localized && !customConfig.sharedFtl) {
    const ftlPath = join(componentDir, `${tagName}.ftl`);
    if (!(await pathExists(ftlPath))) {
      issues.push({
        component: tagName,
        severity: 'error',
        check: 'missing-ftl',
        message: `Component is marked localized: true but ${tagName}.ftl is missing. Create the file, set localized: false in furnace.json, or switch to sharedFtl.`,
      });
    }
  }

  // Conflict markers left by furnace refresh (three-way merge) must be
  // resolved before the component can be applied or deployed.
  const dirEntries = await readdir(componentDir, { withFileTypes: true });
  for (const entry of dirEntries) {
    if (!entry.isFile()) continue;
    if (
      !entry.name.endsWith('.mjs') &&
      !entry.name.endsWith('.css') &&
      !entry.name.endsWith('.ftl')
    )
      continue;

    const content = await readText(join(componentDir, entry.name));
    if (containsMergeConflictMarkers(content)) {
      issues.push({
        component: tagName,
        severity: 'error',
        check: 'conflict-markers',
        message: `File "${entry.name}" contains unresolved merge conflict markers. Resolve conflicts before applying.`,
      });
    }
  }

  // File names should match tag name
  const entries = dirEntries;
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
