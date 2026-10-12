// SPDX-License-Identifier: EUPL-1.2
/**
 * `furnace validate` result rendering: the human per-component lines and
 * the `--json` document (schemaVersion 1, docs/machine-output.md), plus
 * the verdict both share, so the exit code and the `passed` key can never
 * disagree.
 */
import {
  countValidationSeverities,
  type ValidationExceptionOutcome,
} from '../../core/furnace-validate-exceptions.js';
import { InvalidArgumentError } from '../../errors/base.js';
import type { ValidationIssue } from '../../types/furnace.js';
import { setStdoutSealed, success } from '../../utils/logger.js';
import { displayValidationIssues } from './validation-output.js';

/** One finished `furnace validate` run. */
export interface FurnaceValidateReport {
  /** Components the run judged, in validation order. */
  components: string[];
  /** Findings after `validationExceptions` were applied. */
  outcome: ValidationExceptionOutcome;
  /** `--max-warnings`, when given. */
  maxWarnings?: number | undefined;
}

/** The verdict: counts, and whether errors or the warning budget fail it. */
export interface FurnaceValidateVerdict {
  errors: number;
  warnings: number;
  /** True when `--max-warnings` was given and the warnings exceed it. */
  warningBudgetExceeded: boolean;
  passed: boolean;
}

/** Computes the verdict both renderings report. */
export function judgeValidateReport(report: FurnaceValidateReport): FurnaceValidateVerdict {
  const { errors, warnings } = countValidationSeverities(report.outcome.issues);
  const warningBudgetExceeded = report.maxWarnings !== undefined && warnings > report.maxWarnings;
  return {
    errors,
    warnings,
    warningBudgetExceeded,
    passed: errors === 0 && !warningBudgetExceeded,
  };
}

/** Groups findings by component, keeping the report's component order first. */
function groupByComponent(
  components: readonly string[],
  issues: readonly ValidationIssue[]
): Map<string, ValidationIssue[]> {
  const grouped = new Map<string, ValidationIssue[]>(components.map((name) => [name, []]));
  for (const issue of issues) {
    const list = grouped.get(issue.component) ?? [];
    list.push(issue);
    grouped.set(issue.component, list);
  }
  return grouped;
}

/**
 * Prints one line per clean component and every finding of the rest.
 * Findings on names outside `components` (a stale exception for a removed
 * component, an orphaned scaffold) print after them.
 */
export function renderValidateHuman(
  components: readonly string[],
  issues: readonly ValidationIssue[]
): void {
  for (const [name, componentIssues] of groupByComponent(components, issues)) {
    if (componentIssues.length === 0) {
      success(`${name} — all checks passed`);
    } else {
      displayValidationIssues(componentIssues);
    }
  }
}

/**
 * Writes the `--json` document and seals stdout. Every finding is listed
 * once in `issues` (stale-exception warnings included); `excepted` and
 * `staleExceptions` restate the exception bookkeeping for a consumer that
 * audits the list itself.
 */
export function renderValidateJson(report: FurnaceValidateReport): void {
  const verdict = judgeValidateReport(report);
  const grouped = groupByComponent(report.components, report.outcome.issues);
  const payload = {
    schemaVersion: 1,
    passed: verdict.passed,
    summary: {
      components: report.components.length,
      errors: verdict.errors,
      warnings: verdict.warnings,
      excepted: report.outcome.excepted.length,
      staleExceptions: report.outcome.stale.length,
    },
    ...(report.maxWarnings !== undefined ? { maxWarnings: report.maxWarnings } : {}),
    components: report.components.map((name) => ({
      name,
      ...countValidationSeverities(grouped.get(name) ?? []),
    })),
    issues: report.outcome.issues,
    excepted: report.outcome.excepted,
    staleExceptions: report.outcome.stale,
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  setStdoutSealed(true);
}

/**
 * Parses `--max-warnings <n>`: a non-negative integer, or undefined when
 * the flag was not given.
 */
export function parseMaxWarnings(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new InvalidArgumentError(
      '--max-warnings must be a non-negative integer.',
      '--max-warnings'
    );
  }
  return value;
}
