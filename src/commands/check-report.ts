// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge check` output: the per-step table, the single
 * `FIREFORGE-VERDICT:` line, and the `--json` document. The verdict is
 * computed once here and shared by all three, so the exit code, the line
 * and the JSON can never disagree.
 */
import { setStdoutSealed } from '../utils/logger.js';
import type { CheckStepResult } from './check-run.js';

/**
 * Why a check failed. `step-failures`: at least one step went red.
 * `lock-timeout`: every failing step exited 15, so nothing was judged red,
 * the steps just never got their locks. Re-queue rather than fix.
 * `skipped-steps`: nothing went red, but `check.failOnSkipped` is set and a
 * step had nothing to run.
 */
export type CheckVerdictReason = 'step-failures' | 'lock-timeout' | 'skipped-steps';

/** How the verdict treats skipped steps. */
export interface CheckJudgeOptions {
  /** `check.failOnSkipped`: a step skipped for want of anything to run fails the check. */
  failOnSkipped?: boolean | undefined;
}

/** The verdict over all steps. */
export interface CheckVerdict {
  passed: boolean;
  reason?: CheckVerdictReason;
  failed: string[];
  skipped: string[];
  steps: number;
}

/** Exit code a step reports when its lock wait expired. */
const LOCK_TIMEOUT_EXIT = 15;

/**
 * Judges the results: any failing step fails the check. Under
 * `failOnSkipped`, so does a step skipped because the project has nothing
 * for it to run; it is then listed in `failed` too.
 */
export function judgeCheck(
  results: readonly CheckStepResult[],
  options: CheckJudgeOptions = {}
): CheckVerdict {
  const failedResults = results.filter((result) => result.status === 'fail');
  const gaps =
    options.failOnSkipped === true
      ? results.filter((result) => result.status === 'skipped' && result.skipKind !== 'config')
      : [];
  const verdict: CheckVerdict = {
    passed: failedResults.length === 0 && gaps.length === 0,
    failed: [...failedResults, ...gaps].map((result) => result.name),
    skipped: results.filter((result) => result.status === 'skipped').map((result) => result.name),
    steps: results.length,
  };
  if (failedResults.length > 0) {
    verdict.reason = failedResults.every((result) => result.exitCode === LOCK_TIMEOUT_EXIT)
      ? 'lock-timeout'
      : 'step-failures';
  } else if (gaps.length > 0) {
    verdict.reason = 'skipped-steps';
  }
  return verdict;
}

/**
 * The verdict line: `FIREFORGE-VERDICT: PASS steps=<n> skipped=<n>` or
 * `FIREFORGE-VERDICT: FAIL reason=<reason> failed=<a,b> steps=<n> skipped=<n>`,
 * with an additive `skipped-steps=<a,b>` naming the skipped steps when
 * there are any.
 */
export function formatCheckVerdictLine(verdict: CheckVerdict): string {
  const skippedNames =
    verdict.skipped.length > 0 ? ` skipped-steps=${verdict.skipped.join(',')}` : '';
  const counts = `steps=${verdict.steps} skipped=${verdict.skipped.length}${skippedNames}`;
  if (verdict.passed) return `FIREFORGE-VERDICT: PASS ${counts}`;
  return `FIREFORGE-VERDICT: FAIL reason=${verdict.reason ?? 'step-failures'} failed=${verdict.failed.join(',')} ${counts}`;
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** The step's 1-minute load average at start and end (`12.3→18.0`), or `-`. */
function formatLoad(result: CheckStepResult): string {
  if (result.load1Start === undefined || result.load1End === undefined) return '-';
  return `${result.load1Start.toFixed(1)}→${result.load1End.toFixed(1)}`;
}

/** The per-step table: one aligned row per step, with its detail. */
export function formatCheckTable(results: readonly CheckStepResult[]): string {
  const rows = results.map((result) => [
    result.name,
    result.status.toUpperCase(),
    result.status === 'skipped' ? '-' : formatDuration(result.durationMs),
    formatLoad(result),
    result.detail,
  ]);
  const header = ['STEP', 'RESULT', 'TIME', 'LOAD', 'DETAIL'];
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]?.length ?? 0))
  );
  return [header, ...rows]
    .map((row) =>
      row
        .map((cell, column) =>
          column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0)
        )
        .join('  ')
        .trimEnd()
    )
    .join('\n');
}

/** Writes the verdict line as the run's last stdout write, and seals stdout. */
export function writeCheckVerdictLine(verdict: CheckVerdict): void {
  process.stdout.write(`${formatCheckVerdictLine(verdict)}\n`);
  setStdoutSealed(true);
}

/** Writes the `--json` document (schemaVersion 1) and seals stdout. */
export function writeCheckJson(results: readonly CheckStepResult[], verdict: CheckVerdict): void {
  const payload = {
    schemaVersion: 1,
    verdict: verdict.passed ? 'pass' : 'fail',
    ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
    summary: {
      steps: verdict.steps,
      passed: results.filter((result) => result.status === 'pass').length,
      failed: verdict.failed.length,
      skipped: verdict.skipped.length,
    },
    steps: results,
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  setStdoutSealed(true);
}
