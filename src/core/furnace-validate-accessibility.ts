// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import type { ValidationIssue } from '../types/furnace.js';
import { pathExists, readText } from '../utils/fs.js';
import {
  containsHardcodedTemplateText,
  createIssue,
  hasAriaRole,
  hasDelegatesFocusEnabled,
  hasGenericInteractiveElement,
  hasPositiveTabindex,
  hasTemplateClickHandler,
  hasTemplateKeyboardHandler,
  hasUnlabelledFormInput,
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

  if (!hasAriaRole(content) && hasGenericInteractiveElement(content)) {
    issues.push(
      createIssue(
        tagName,
        'warning',
        'no-aria-role',
        'Generic interactive markup has no native semantics. Prefer native elements, or add role= when native markup cannot provide the semantics.'
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

  if (hasPositiveTabindex(content)) {
    issues.push(
      createIssue(
        tagName,
        'warning',
        'positive-tabindex',
        'Positive tabindex disrupts natural tab order. Use tabindex="0" for focusable elements or tabindex="-1" for programmatic focus only.'
      )
    );
  }

  if (hasUnlabelledFormInput(content)) {
    issues.push(
      createIssue(
        tagName,
        'warning',
        'unlabelled-form-input',
        'Form input without an accessible label. Add aria-label, aria-labelledby, or an associated <label> element.'
      )
    );
  }

  return issues;
}
