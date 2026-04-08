// SPDX-License-Identifier: EUPL-1.2
import type { ValidationIssue } from '../../types/furnace.js';
import { error, warn } from '../../utils/logger.js';

/**
 * Displays validation issues and returns aggregated error and warning counts.
 * @param issues - Validation issues to render
 * @returns Tuple of [errorCount, warningCount]
 */
export function displayValidationIssues(issues: ValidationIssue[]): [number, number] {
  let errors = 0;
  let warnings = 0;

  for (const issue of issues) {
    if (issue.severity === 'error') {
      error(`${issue.component}: [${issue.check}] ${issue.message}`);
      errors++;
    } else {
      warn(`${issue.component}: [${issue.check}] ${issue.message}`);
      warnings++;
    }
  }

  return [errors, warnings];
}
