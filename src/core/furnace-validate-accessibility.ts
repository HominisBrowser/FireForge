// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import type { ValidationIssue } from '../types/furnace.js';
import { pathExists, readText } from '../utils/fs.js';
import {
  containsHardcodedTemplateText,
  createIssue,
  hasAriaRole,
  hasDelegatesFocusEnabled,
  hasTemplateClickHandler,
  hasTemplateKeyboardHandler,
} from './furnace-validate-helpers.js';

/**
 * Validates accessibility patterns in a component's .mjs file.
 * Checks for ARIA roles, keyboard handlers, l10n, and focus delegation.
 */
export async function validateAccessibility(
  componentDir: string,
  tagName: string
): Promise<ValidationIssue[]> {
  const mjsPath = join(componentDir, `${tagName}.mjs`);
  if (!(await pathExists(mjsPath))) return [];

  const content = await readText(mjsPath);
  const issues: ValidationIssue[] = [];

  if (!hasAriaRole(content)) {
    issues.push(
      createIssue(
        tagName,
        'warning',
        'no-aria-role',
        'No ARIA role attribute found. Consider adding role= for screen reader support.'
      )
    );
  }

  const hasClick = hasTemplateClickHandler(content);
  const hasKeyboardHandler = hasTemplateKeyboardHandler(content);
  if (hasClick && !hasKeyboardHandler) {
    issues.push(
      createIssue(
        tagName,
        'warning',
        'no-keyboard-handler',
        'Interactive element has @click but no keyboard event handler (@keydown/@keypress/@keyup).'
      )
    );
  }

  if (containsHardcodedTemplateText(content)) {
    issues.push(
      createIssue(
        tagName,
        'warning',
        'hardcoded-text',
        'Possible hardcoded string found. Use data-l10n-id for localization.'
      )
    );
  }

  const isInteractive = hasClick || hasKeyboardHandler;
  if (isInteractive && !hasDelegatesFocusEnabled(content)) {
    issues.push(
      createIssue(
        tagName,
        'warning',
        'no-delegates-focus',
        'Interactive component without delegatesFocus in shadowRootOptions. Focus may not delegate to inner elements.'
      )
    );
  }

  return issues;
}
