// SPDX-License-Identifier: EUPL-1.2
/**
 * The one genuinely shared helper across the furnace validators. Every other
 * helper lives with the single validator that uses it.
 */
import type { ValidationIssue } from '../types/furnace.js';

/** Creates a normalized validation issue object. */
export function createIssue(
  component: string,
  severity: ValidationIssue['severity'],
  check: ValidationIssue['check'],
  message: string
): ValidationIssue {
  return { component, severity, check, message };
}
