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
 */
export type CheckVerdictReason = 'step-failures' | 'lock-timeout';

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

/** Judges the results: any failing step fails the check. */
export function judgeCheck(results: readonly CheckStepResult[]): CheckVerdict {
  const failedResults = results.filter((result) => result.status === 'fail');
  const verdict: CheckVerdict = {
    passed: failedResults.length === 0,
    failed: failedResults.map((result) => result.name),
    skipped: results.filter((result) => result.status === 'skipped').map((result) => result.name),
    steps: results.length,
  };
  if (failedResults.length > 0) {
    verdict.reason = failedResults.every((result) => result.exitCode === LOCK_TIMEOUT_EXIT)
      ? 'lock-timeout'
      : 'step-failures';
  }
  return verdict;
}

/**
 * The verdict line: `FIREFORGE-VERDICT: PASS steps=<n> skipped=<n>` or
 * `FIREFORGE-VERDICT: FAIL reason=<reason> failed=<a,b> steps=<n> skipped=<n>`.
 */
export function formatCheckVerdictLine(verdict: CheckVerdict): string {
  const counts = `steps=${verdict.steps} skipped=${verdict.skipped.length}`;
  if (verdict.passed) return `FIREFORGE-VERDICT: PASS ${counts}`;
  return `FIREFORGE-VERDICT: FAIL reason=${verdict.reason ?? 'step-failures'} failed=${verdict.failed.join(',')} ${counts}`;
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** The per-step table: one aligned row per step, with its detail. */
export function formatCheckTable(results: readonly CheckStepResult[]): string {
  const rows = results.map((result) => [
    result.name,
    result.status.toUpperCase(),
    result.status === 'skipped' ? '-' : formatDuration(result.durationMs),
    result.detail,
  ]);
  const header = ['STEP', 'RESULT', 'TIME', 'DETAIL'];
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
