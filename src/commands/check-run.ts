// SPDX-License-Identifier: EUPL-1.2
/**
 * Runs the `fireforge check` plan: up to `jobs` steps at once, each as a
 * child process in its own process group (so a timeout or a Ctrl+C takes
 * the step's whole tree), honouring each step's `after` ordering.
 */
import { loadavg } from 'node:os';

import type { CheckStepPlan } from '../core/check/steps.js';
import type {
  CheckOutputObserver,
  CheckStepRecorder,
  CheckStepResult,
} from '../core/check/types.js';
import { ExecTimeoutError } from '../errors/base.js';
import { toError } from '../utils/errors.js';
import { execStream } from '../utils/process.js';

/** Samples the host's 1-minute load average; undefined where there is none. */
type LoadSampler = () => number | undefined;

/** `os.loadavg()[0]`, or undefined on Windows, where Node reports zeros. */
function sampleLoad1(): number | undefined {
  return process.platform === 'win32' ? undefined : loadavg()[0];
}

/** Both load samples, or nothing when either is unavailable. */
function loadFields(
  start: number | undefined,
  end: number | undefined
): Pick<CheckStepResult, 'load1Start' | 'load1End'> {
  return start === undefined || end === undefined ? {} : { load1Start: start, load1End: end };
}

/** Combined output kept per step: enough for a tail, bounded for a chatty audit. */
const COMBINED_OUTPUT_CAP = 256 * 1024;
/**
 * Stdout kept for a step that summarizes one JSON document. A document past it is
 * dropped whole, since a cut one cannot parse, and the summary falls back to the
 * combined tail's last line.
 */
const STDOUT_DOCUMENT_CAP = 4 * 1024 * 1024;
/** Lines of output a failed step carries in its result. */
const OUTPUT_TAIL_LINES = 40;

function tailLines(text: string): string {
  const lines = text.trimEnd().split(/\r?\n/);
  return lines.slice(-OUTPUT_TAIL_LINES).join('\n');
}

/** Runs one planned step to completion. Never throws. */
async function executeStep(
  plan: CheckStepPlan,
  now: () => number,
  load: LoadSampler,
  observation?: CheckOutputObserver
): Promise<CheckStepResult> {
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
  let keepStdout = plan.stdoutDocument === true;
  let combined = '';
  const append = (chunk: string): void => {
    combined += chunk;
    if (combined.length > COMBINED_OUTPUT_CAP) combined = combined.slice(-COMBINED_OUTPUT_CAP);
  };
  const started = now();
  const load1Start = load();
  try {
    const exitCode = await execStream(plan.command, plan.args, {
      cwd: plan.cwd,
      processGroup: true,
      ...(plan.timeoutMs !== undefined ? { timeout: plan.timeoutMs } : {}),
      ...(plan.env !== undefined ? { env: plan.env } : {}),
      onStdout: (chunk) => {
        if (keepStdout) {
          stdout += chunk;
          if (stdout.length > STDOUT_DOCUMENT_CAP) {
            stdout = '';
            keepStdout = false;
          }
        }
        observation?.append('stdout', chunk);
        append(chunk);
      },
      onStderr: (chunk) => {
        observation?.append('stderr', chunk);
        append(chunk);
      },
    });
    const status = exitCode === 0 ? 'pass' : 'fail';
    return {
      ...base,
      status,
      exitCode,
      durationMs: now() - started,
      ...loadFields(load1Start, load()),
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
      ...loadFields(load1Start, load()),
      detail: timedOut
        ? `timed out after ${Math.round((plan.timeoutMs ?? 0) / 1000)}s`
        : `could not start: ${toError(error).message}`,
      ...(timedOut ? { timedOut: true as const } : {}),
      outputTail: tailLines(combined),
    };
  }
}

/** A capture failure is a failed step, never an empty successful result or a lost running child. */
async function runStep(
  plan: CheckStepPlan,
  now: () => number,
  load: LoadSampler,
  recorder?: CheckStepRecorder
): Promise<CheckStepResult> {
  if (!recorder || plan.skipReason !== undefined) return executeStep(plan, now, load);
  try {
    return await recorder(plan, (output) => executeStep(plan, now, load, output));
  } catch (error) {
    return {
      name: plan.name,
      kind: plan.kind,
      command: plan.display,
      status: 'fail',
      exitCode: null,
      durationMs: 0,
      detail: `could not record complete execution: ${toError(error).message}`,
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
 * @param load - 1-minute load average sampler, injectable for tests
 */
export async function runCheckSteps(
  plans: readonly CheckStepPlan[],
  jobs: number,
  now: () => number = Date.now,
  load: LoadSampler = sampleLoad1,
  recorder?: CheckStepRecorder
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
        runStep(plan, now, load, recorder).then((result) => {
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
