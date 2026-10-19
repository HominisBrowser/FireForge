// SPDX-License-Identifier: EUPL-1.2
/**
 * Applies `furnace.json#validationExceptions[]` to a `furnace validate`
 * result. An exception suppresses every finding of its check on its
 * component, or with `tag`, a finding whose element tags it (and its
 * sibling tag entries) cover. One that suppresses nothing is stale: the
 * finding was fixed (or renamed) and the review record outlived it, so it
 * is reported as a warning naming the entry to delete, which keeps the
 * list honest under `--max-warnings 0`.
 *
 * An exception never suppresses an error: an error blocks apply, and a
 * review record cannot make a broken component deployable. The error stays
 * counted and the matching entry is reported as
 * `validation-exception-on-error`.
 */
import type { FurnaceValidationException, ValidationIssue } from '../types/furnace.js';
import { createIssue } from './furnace-validate-helpers.js';

/** The check name of the warning a stale exception produces. */
export const STALE_VALIDATION_EXCEPTION_CHECK = 'stale-validation-exception';

/** The check name of the error an exception matching an error produces. */
export const EXCEPTION_ON_ERROR_CHECK = 'validation-exception-on-error';

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
 * The exceptions that suppress a warning: an untagged one alone, or tagged
 * ones that together cover every tag the finding names.
 */
function coveringExceptions(
  issue: ValidationIssue,
  candidates: readonly FurnaceValidationException[]
): FurnaceValidationException[] {
  const untagged = candidates.find((entry) => entry.tag === undefined);
  if (untagged !== undefined) return [untagged];
  const tags = issue.tags ?? [];
  if (tags.length === 0) return [];
  const covering = tags.map((tag) => candidates.find((entry) => entry.tag === tag));
  return covering.every((entry) => entry !== undefined) ? [...new Set(covering)] : [];
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
  const onError = new Set<FurnaceValidationException>();
  for (const issue of issues) {
    const candidates = list.filter((entry) => matches(entry, issue));
    if (issue.severity === 'error') {
      for (const entry of candidates) {
        used.add(entry);
        onError.add(entry);
      }
      outcome.issues.push(issue);
      continue;
    }
    const covering = coveringExceptions(issue, candidates);
    if (covering.length === 0) {
      // A tagged exception that covers some of the tags is not stale: its
      // element still carries the finding, beside one it does not cover.
      for (const entry of candidates) {
        if (entry.tag !== undefined && issue.tags?.includes(entry.tag) === true) used.add(entry);
      }
      outcome.issues.push(issue);
      continue;
    }
    for (const entry of covering) used.add(entry);
    outcome.excepted.push({ ...issue, reason: covering.map((entry) => entry.reason).join('; ') });
  }
  for (const exception of onError) {
    outcome.issues.push(
      createIssue(
        exception.component,
        'error',
        EXCEPTION_ON_ERROR_CHECK,
        `furnace.json validationExceptions entry for [${exception.check}] matches an error, ` +
          'which an exception cannot suppress. Fix the error, then delete the entry.'
      )
    );
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
