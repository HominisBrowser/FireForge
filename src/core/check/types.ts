// SPDX-License-Identifier: EUPL-1.2
/** What a `check` run reports: each step's result and the verdict over all of them. */
import type { CheckStepPlan } from './steps.js';

/** What a step's table row and JSON entry report. */
export interface CheckStepResult {
  startedAt?: string;
  finishedAt?: string;
  artifact?: string;
  artifactDigest?: string;
  name: string;
  kind: 'builtin' | 'extra';
  /** The command line, as the table prints it. */
  command: string;
  status: 'pass' | 'fail' | 'skipped';
  /**
   * For a skipped step: `config` when `check.skip` names it, `unavailable`
   * when the project has nothing for it to run.
   */
  skipKind?: 'config' | 'unavailable';
  /** The child's exit code. Null when it never ran or was killed at its budget. */
  exitCode: number | null;
  durationMs: number;
  /** One-line summary for the table. */
  detail: string;
  /** Set when the step was killed at its `timeout`. */
  timedOut?: true;
  /** The tail of the step's combined output, for a failed step. */
  outputTail?: string;
  /**
   * The host's 1-minute load average when the step started and when it
   * ended. Absent for a skipped step and on Windows, which has no load
   * average.
   */
  load1Start?: number;
  load1End?: number;
}

/** An owned recorder wraps actual child execution and captures both output streams. */
export interface CheckOutputObserver {
  append(stream: 'stdout' | 'stderr', chunk: string): void;
}
export type CheckStepRecorder = (
  plan: CheckStepPlan,
  run: (output: CheckOutputObserver) => Promise<CheckStepResult>
) => Promise<CheckStepResult>;

/**
 * Why a check failed. `step-failures`: at least one step went red.
 * `lock-timeout`: every failing step exited 15, so nothing was judged red,
 * the steps just never got their locks. Re-queue rather than fix.
 * `skipped-steps`: nothing went red, but `check.failOnSkipped` is set and a
 * step had nothing to run.
 */
export type CheckVerdictReason = 'step-failures' | 'lock-timeout' | 'skipped-steps' | 'empty-plan';

/** The verdict over all steps. */
export interface CheckVerdict {
  passed: boolean;
  reason?: CheckVerdictReason;
  failed: string[];
  skipped: string[];
  steps: number;
  /** `--only`/`--skip` left steps out, so this is not the full gate. */
  narrowed?: boolean;
}
