// SPDX-License-Identifier: EUPL-1.2
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { wantsMachineOutput } from '../cli-usage-error.js';
import { pristineRepositoryFor } from '../core/authored/git.js';
import { loadConfig } from '../core/config.js';
import { coordinatorNamespace } from '../core/jobs/guard.js';
import { gibText } from '../core/jobs/host-disk.js';
import { progressLine } from '../core/jobs/job-progress.js';
import { type JobState, type JobView, terminal } from '../core/jobs/schema.js';
import { readTemplate } from '../core/jobs/slot-template.js';
import { waitProgress } from '../core/jobs/wait-progress.js';
import { CommandError, FireForgeError, InvalidArgumentError } from '../errors/base.js';
import { ExitCode } from '../errors/codes.js';
import { jobRefusal } from '../errors/job.js';
import type { CommandContext } from '../types/cli.js';
import { setStdoutSealed } from '../utils/logger.js';
import { MACHINE_OUTPUT_SCHEMA_VERSION } from '../utils/machine-output.js';

/**
 * Wraps a job or slot action so a refusal from the core reads as itself. The
 * core throws plain errors whose text is written for the operator; a programming
 * error keeps its class, and so its stack.
 */
export function jobAction<T extends unknown[]>(
  ctx: CommandContext,
  handler: (...args: T) => Promise<void>
): (...args: T) => Promise<void> {
  return ctx.withErrorHandling(async (...args: T) => {
    try {
      await handler(...args);
    } catch (error) {
      if (
        error instanceof CommandError ||
        error instanceof FireForgeError ||
        error instanceof TypeError ||
        error instanceof ReferenceError ||
        error instanceof RangeError ||
        !(error instanceof Error)
      )
        throw error;
      throw jobRefusal(
        (error as { refusedAs?: string }).refusedAs,
        error.message,
        error.cause ?? undefined
      );
    }
  });
}

/** Keep machine replies complete and newline-delimited. */
export function output(value: string): void {
  process.stdout.write(`${value}\n`);
}

/** The keys a command's `--json` document carries beside `schemaVersion`. */
export interface ResultFields {
  [key: string]: unknown;
}

/**
 * One result: a line of text for a person, or under `--json` the single JSON
 * document on stdout, carrying `schemaVersion` beside `data`'s keys.
 */
export function printResult(data: ResultFields, text: string): void {
  if (!wantsMachineOutput()) {
    output(text);
    return;
  }
  setStdoutSealed(true);
  output(JSON.stringify({ schemaVersion: MACHINE_OUTPUT_SCHEMA_VERSION, ...data }));
}

/** A result with no sentence of its own: `key: value` lines for a person, the document under `--json`. */
export function printData(data: ResultFields): void {
  printResult(
    data,
    Object.entries(data)
      .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
      .join('\n')
  );
}

/** Progress for a person; under `--json` it goes to stderr so stdout stays one document. */
export function progress(line: string): void {
  if (wantsMachineOutput()) process.stderr.write(`${line}\n`);
  else output(line);
}

/**
 * Step-by-step progress for a client that waits on a job, as plain lines on
 * stderr (no redraws, so a log reads the same as a terminal). Undefined under
 * `--json`, where stderr carries no progress.
 */
export function waitReporter(
  say: (line: string) => void = (line) => {
    process.stderr.write(`${line}\n`);
  }
): ((job: JobView) => void) | undefined {
  return wantsMachineOutput() ? undefined : waitProgress(say);
}

/** A whole-number flag at or above `min`; anything else is a usage error (exit 8). */
export function parseWhole(flag: string, value: string | undefined, min = 1): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min)
    throw new InvalidArgumentError(
      `${flag} must be a ${min === 0 ? 'non-negative' : 'positive'} whole number`,
      flag
    );
  return parsed;
}

/** The coordinator namespace a command works in: `--namespace`, else `FIREFORGE_COORDINATOR`, else the host default. */
export function namespaceOf(options: { namespace?: string }): string {
  return resolve(options.namespace ?? coordinatorNamespace());
}

/** Stops a queue project before any capture, naming the way into source mode. */
export async function assertSourceMode(projectRoot: string): Promise<void> {
  if ((await loadConfig(projectRoot)).sources === undefined)
    throw new InvalidArgumentError(
      'Coordinated jobs need a source-mode project; this one still uses a patch queue. Migrate it first: fireforge authored migrate --out <directory> --verify'
    );
}

/** The exit code a job's state means to a script. */
function exitCodeFor(state: JobState): ExitCode {
  if (state === 'failed') return ExitCode.JOB_FAILED;
  if (state === 'cancelled' || state === 'interrupted') return ExitCode.JOB_STOPPED;
  return ExitCode.SUCCESS;
}

/** The keys of a step's host state that a verdict line spells differently. */
const HOST_STATE_LABELS: Readonly<Record<string, string>> = { foregroundLost: 'foreground-lost' };

/** What changed on the host under a red or interrupted job's last step, as `key@seconds` in the order seen. */
function hostStateField(job: JobView): string[] {
  if ((job.state !== 'failed' && job.state !== 'interrupted') || job.hostState === undefined)
    return [];
  const entries = Object.entries(job.hostState)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .sort((left, right) => left[1] - right[1]);
  return entries.length === 0
    ? []
    : [
        `host-state=${entries.map(([key, at]) => `${HOST_STATE_LABELS[key] ?? key}@${String(at)}`).join(',')}`,
      ];
}

/** The least free disk a red, interrupted or cancelled job's last step saw while it was low, as `host-disk-low=<GiB>@<seconds>`. */
function hostDiskField(job: JobView): string[] {
  if (job.state === 'passed' || job.hostDisk === undefined) return [];
  return [`host-disk-low=${gibText(job.hostDisk.freeBytes)}@${String(job.hostDisk.atSeconds)}`];
}

/** One line a person or a log tail can read. The job ID comes first, for scripts. */
export function jobVerdict(job: JobView): string {
  const total = job.request.steps.length;
  const step = job.phase === undefined ? 0 : Math.min(job.phase.index + 1, total);
  return [
    job.id,
    job.state,
    ...(job.slot === undefined ? [] : [`slot=${job.slot}`]),
    ...(terminal(job.state) ? [] : [`step=${step}/${total}`]),
    ...(job.progress === undefined ? [] : [`progress="${progressLine(job.progress)}"`]),
    `owner=${job.owner}`,
    ...(job.cancelledBy === undefined
      ? []
      : [`cancelled-by="${job.cancelledBy.owner} from ${job.cancelledBy.cwd}"`]),
    ...(job.state === 'failed' && job.hostLoadPeak !== undefined
      ? [
          `host-load-peak=${job.hostLoadPeak.load.toFixed(2)}`,
          `host-load-peak-at=${String(job.hostLoadPeak.atSeconds)}`,
        ]
      : []),
    ...hostStateField(job),
    ...hostDiskField(job),
    ...(job.reason === undefined ? [] : [`reason=${job.reason.split('\n')[0] ?? ''}`]),
    ...(job.state === 'failed' ? [`logs="fireforge job logs ${job.id}"`] : []),
    ...(job.outputs ?? []).map((entry) => `output=${entry.path}`),
    ...(job.detached === undefined || job.detached.length === 0
      ? []
      : [`detached=${job.detached.map((entry) => entry.pid).join(',')}`]),
    ...(job.blockedBy === undefined ? [] : [`blocked=${job.blockedBy}`]),
  ].join(' ');
}

/** The step a failed job went red on: the last red one when it went on past reds. */
export function redStep(job: JobView): number | undefined {
  if (job.state !== 'failed') return undefined;
  const reds = (job.stepVerdicts ?? []).filter((verdict) => verdict.state === 'red');
  return reds.at(-1)?.step ?? job.phase?.index;
}

/** Prints a job, as the record under `--json` and a verdict line otherwise. */
export function printJob(job: JobView): void {
  if (wantsMachineOutput()) printResult({ ...job }, '');
  else output(jobVerdict(job));
}

/** Ends a command on a job whose state a script must not read as success. */
export function exitWithState(job: JobView, timedOut = false): void {
  if (timedOut && !terminal(job.state)) throw new CommandError(ExitCode.JOB_WAIT_TIMEOUT);
  const code = exitCodeFor(job.state);
  if (code !== ExitCode.SUCCESS) throw new CommandError(code);
}

/**
 * Where a checkout finds pristine objects without being told. The pin's template
 * holds exactly what capture reads and never moves, so it comes before the
 * checkout's own `engine/`. `FIREFORGE_PRISTINE_REPOSITORY` still wins, and a
 * linked worktree falls back to its main checkout's engine.
 */
export async function pristineDonor(namespace: string, projectRoot: string): Promise<string> {
  if (process.env['FIREFORGE_PRISTINE_REPOSITORY'] !== undefined)
    return pristineRepositoryFor(projectRoot);
  const { sources } = JSON.parse(await readFile(join(projectRoot, 'fireforge.json'), 'utf8')) as {
    sources?: { pristineCommit?: string };
  };
  const template =
    sources?.pristineCommit === undefined
      ? undefined
      : await readTemplate(namespace, sources.pristineCommit);
  return template?.repository ?? pristineRepositoryFor(projectRoot);
}
