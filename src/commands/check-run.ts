// SPDX-License-Identifier: EUPL-1.2
/**
 * Runs the `fireforge check` plan: up to `jobs` steps at once, each as a
 * child process in its own process group (so a timeout or a Ctrl+C takes
 * the step's whole tree), honouring each step's `after` ordering.
 */
import { ExecTimeoutError } from '../errors/base.js';
import { toError } from '../utils/errors.js';
import { execStream } from '../utils/process.js';
import type { CheckStepPlan } from './check-steps.js';

/** What a step's table row and JSON entry report. */
export interface CheckStepResult {
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
}

/** Combined output kept per step: enough for a tail, bounded for a chatty audit. */
const COMBINED_OUTPUT_CAP = 256 * 1024;
/** Lines of output a failed step carries in its result. */
const OUTPUT_TAIL_LINES = 40;

function tailLines(text: string): string {
  const lines = text.trimEnd().split(/\r?\n/);
  return lines.slice(-OUTPUT_TAIL_LINES).join('\n');
}

/** Runs one planned step to completion. Never throws. */
async function runStep(plan: CheckStepPlan, now: () => number): Promise<CheckStepResult> {
  const base = { name: plan.name, kind: plan.kind, command: plan.display };
  if (plan.skipReason !== undefined) {
    return {
      ...base,
      status: 'skipped',
      skipKind: plan.skipKind ?? 'unavailable',
      exitCode: null,
      durationMs: 0,
      detail: plan.skipReason,
    };
  }
  let stdout = '';
  let combined = '';
  const append = (chunk: string): void => {
    combined += chunk;
    if (combined.length > COMBINED_OUTPUT_CAP) combined = combined.slice(-COMBINED_OUTPUT_CAP);
  };
  const started = now();
  try {
    const exitCode = await execStream(plan.command, plan.args, {
      cwd: plan.cwd,
      processGroup: true,
      ...(plan.timeoutMs !== undefined ? { timeout: plan.timeoutMs } : {}),
      ...(plan.env !== undefined ? { env: plan.env } : {}),
      onStdout: (chunk) => {
        stdout += chunk;
        append(chunk);
      },
      onStderr: append,
    });
    const status = exitCode === 0 ? 'pass' : 'fail';
    return {
      ...base,
      status,
      exitCode,
      durationMs: now() - started,
      detail: plan.summarize({ stdout, combined, exitCode }),
      ...(status === 'fail' ? { outputTail: tailLines(combined) } : {}),
    };
  } catch (error: unknown) {
    const timedOut = error instanceof ExecTimeoutError;
    return {
      ...base,
      status: 'fail',
      exitCode: null,
      durationMs: now() - started,
      detail: timedOut
        ? `timed out after ${Math.round((plan.timeoutMs ?? 0) / 1000)}s`
        : `could not start: ${toError(error).message}`,
      ...(timedOut ? { timedOut: true as const } : {}),
      outputTail: tailLines(combined),
    };
  }
}

/**
 * Runs every step and returns the results in plan order. A step starts
 * once a slot is free and every step it runs `after` has finished
 * (whatever its outcome: the constraint is ordering, not success).
 *
 * @param plans - The plan from `buildCheckPlan`, already filtered
 * @param jobs - How many steps may run at once (at least 1)
 * @param now - Clock, injectable for tests
 */
export async function runCheckSteps(
  plans: readonly CheckStepPlan[],
  jobs: number,
  now: () => number = Date.now
): Promise<CheckStepResult[]> {
  const names = new Set(plans.map((plan) => plan.name));
  const results = new Map<string, CheckStepResult>();
  const pending = [...plans];
  const running = new Map<string, Promise<void>>();

  const isReady = (plan: CheckStepPlan): boolean =>
    plan.after.every((dependency) => !names.has(dependency) || results.has(dependency));

  while (pending.length > 0 || running.size > 0) {
    for (let index = 0; index < pending.length && running.size < Math.max(1, jobs);) {
      const plan = pending[index];
      if (plan === undefined || !isReady(plan)) {
        index++;
        continue;
      }
      pending.splice(index, 1);
      running.set(
        plan.name,
        runStep(plan, now).then((result) => {
          results.set(plan.name, result);
          running.delete(plan.name);
        })
      );
    }
    if (running.size === 0) break;
    await Promise.race(running.values());
  }

  return plans.flatMap((plan) => {
    const result = results.get(plan.name);
    return result === undefined ? [] : [result];
  });
}
