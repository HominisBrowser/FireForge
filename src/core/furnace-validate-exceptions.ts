// SPDX-License-Identifier: EUPL-1.2
/**
 * Applies `furnace.json#validationExceptions[]` to a `furnace validate`
 * result. An exception suppresses every finding of its check on its
 * component. One that suppresses nothing is stale: the finding was fixed
 * (or renamed) and the review record outlived it, so it is reported as a
 * warning naming the entry to delete, which keeps the list honest under
 * `--max-warnings 0`.
 */
import type { FurnaceValidationException, ValidationIssue } from '../types/furnace.js';
import { createIssue } from './furnace-validate-helpers.js';

/** The check name of the warning a stale exception produces. */
export const STALE_VALIDATION_EXCEPTION_CHECK = 'stale-validation-exception';

/** A finding an exception suppressed, with the exception's reason. */
export interface ExceptedValidationIssue extends ValidationIssue {
  reason: string;
}

/** {@link applyValidationExceptions}'s result. */
export interface ValidationExceptionOutcome {
  /** Findings that still count, stale-exception warnings included. */
  issues: ValidationIssue[];
  /** Findings an exception suppressed. */
  excepted: ExceptedValidationIssue[];
  /** Exceptions that matched no finding of a component this run judged. */
  stale: FurnaceValidationException[];
}

function matches(exception: FurnaceValidationException, issue: ValidationIssue): boolean {
  return exception.component === issue.component && exception.check === issue.check;
}

/**
 * Splits findings into counted and excepted, and reports stale exceptions.
 *
 * @param issues - Every finding of the run
 * @param exceptions - `furnace.json#validationExceptions`
 * @param judged - Whether the run judged an exception's component. A run
 *   scoped to one component cannot call another component's exception
 *   stale, while the full run judges them all (including components
 *   furnace.json no longer declares)
 */
export function applyValidationExceptions(
  issues: readonly ValidationIssue[],
  exceptions: readonly FurnaceValidationException[] | undefined,
  judged: (component: string) => boolean
): ValidationExceptionOutcome {
  const outcome: ValidationExceptionOutcome = { issues: [], excepted: [], stale: [] };
  const list = exceptions ?? [];
  const used = new Set<FurnaceValidationException>();
  for (const issue of issues) {
    const exception = list.find((entry) => matches(entry, issue));
    if (exception === undefined) {
      outcome.issues.push(issue);
      continue;
    }
    used.add(exception);
    outcome.excepted.push({ ...issue, reason: exception.reason });
  }
  for (const exception of list) {
    if (used.has(exception) || !judged(exception.component)) continue;
    outcome.stale.push(exception);
    outcome.issues.push(
      createIssue(
        exception.component,
        'warning',
        STALE_VALIDATION_EXCEPTION_CHECK,
        `furnace.json validationExceptions entry for [${exception.check}] matches no finding. ` +
          'Delete the entry: the finding it records is gone.'
      )
    );
  }
  return outcome;
}

/** Counts error- and warning-severity findings. */
export function countValidationSeverities(issues: readonly ValidationIssue[]): {
  errors: number;
  warnings: number;
} {
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  return { errors, warnings: issues.length - errors };
}
