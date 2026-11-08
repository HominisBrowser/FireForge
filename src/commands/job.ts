// SPDX-License-Identifier: EUPL-1.2
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { Command } from 'commander';

import { wantsMachineOutput } from '../cli-usage-error.js';
import type { AuthoredSnapshot } from '../core/authored/types.js';
import {
  cancelJob,
  clearHost,
  listJobs,
  readJob,
  readJobLogs,
  resolveJobId,
  submitJob,
  waitForJob,
} from '../core/jobs/client.js';
import type { LogChunk } from '../core/jobs/job-view.js';
import { type JobView, normalizeRequest } from '../core/jobs/schema.js';
import { parseEnvironmentAssignments } from '../core/jobs/step-environment.js';
import { readJson } from '../core/jobs/store.js';
import { InvalidArgumentError } from '../errors/base.js';
import { InvalidLogRangeError } from '../errors/job.js';
import type { CommandContext } from '../types/cli.js';
import { runJob } from './job-run.js';
import {
  assertSourceMode,
  exitWithState,
  jobAction,
  jobVerdict,
  namespaceOf,
  parseWhole,
  printJob,
  printResult,
} from './job-support.js';

interface NamespaceOption {
  namespace?: string;
}

function registerSubmit(job: Command, ctx: CommandContext): void {
  job
    .command('submit <request>')
    .description('Queue a request against a frozen snapshot and print the job')
    .requiredOption('--snapshot <file>', 'Frozen authored snapshot JSON')
    .option('--owner <label>', 'Free-text label shown in job list; it grants nothing')
    .option('--namespace <path>', 'Host coordinator namespace')
    .action(
      jobAction(
        ctx,
        async (path: string, options: NamespaceOption & { snapshot: string; owner?: string }) => {
          const snapshot = await readJson<AuthoredSnapshot>(resolve(options.snapshot));
          const raw: unknown = JSON.parse(await readFile(resolve(path), 'utf8'));
          printJob(
            await submitJob(
              namespaceOf(options),
              normalizeRequest(raw, snapshot.id),
              snapshot,
              ...(options.owner === undefined ? [] : [options.owner])
            )
          );
        }
      )
    );
}

interface RunFlags extends NamespaceOption {
  check?: boolean;
  build?: string;
  test?: string[];
  slot: string;
  path?: string[];
  owner?: string;
  timeout?: string;
  headed?: boolean;
  shard: boolean;
  standalone?: boolean;
  env?: string[];
  uploadDir?: boolean;
  machArg?: string[];
  keepAwake?: boolean;
  holdFront?: boolean;
  throttle?: string;
  release?: boolean;
}

/** What `job run` flags cannot mean together. */
function assertRunFlags(options: RunFlags): void {
  if (options.build !== undefined && !['ui', 'full', 'none'].includes(options.build))
    throw new InvalidArgumentError('--build must be ui, full or none', '--build');
  if (options.throttle !== undefined && !['background', 'utility'].includes(options.throttle))
    throw new InvalidArgumentError('--throttle must be background or utility', '--throttle');
  if (
    options.release === true &&
    (options.test !== undefined || options.build !== undefined || options.check === true)
  )
    throw new InvalidArgumentError(
      '--release is a whole build of its own: name no --test, --build or --check',
      '--release'
    );
  if (
    options.test === undefined &&
    (options.headed === true ||
      options.holdFront === true ||
      options.throttle !== undefined ||
      !options.shard ||
      options.standalone === true ||
      options.env !== undefined ||
      options.uploadDir === true ||
      options.machArg !== undefined)
  )
    throw new InvalidArgumentError(
      '--headed, --hold-front, --throttle, --no-shard, --standalone, --env, --upload-dir and --mach-arg describe how tests run: name them with --test',
      '--test'
    );
  if (options.standalone === true && !options.shard)
    throw new InvalidArgumentError(
      '--standalone restarts between tests and --no-shard keeps one browser: name one',
      '--standalone'
    );
}

function registerRun(job: Command, ctx: CommandContext): void {
  job
    .command('run')
    .description('Capture this checkout, run it in a slot, wait, and print one verdict line')
    .option('--check', 'Run the project check; the default when nothing else is named')
    .option('--build <kind>', 'Build first: ui, full or none; a --test defaults to ui')
    .option('--test <path...>', 'Browser test files to run, headless unless --headed')
    .option('--headed', 'Run the tests with a visible window, which holds the display')
    .option('--no-shard', 'Run the tests in one browser, so state accumulates')
    .option('--standalone', 'Restart between tests, as a standalone lane dispatches')
    .option('--env <name=value...>', 'Environment for the tests; names the executor owns refuse')
    .option('--upload-dir', 'Give the tests a private MOZ_UPLOAD_DIR, named in the verdict')
    .option('--mach-arg <arg...>', 'Mach arguments for the tests: only --setpref=<name>=<value>')
    .option('--keep-awake', 'Hold a display and idle assertion while each step runs, on darwin')
    .option('--no-keep-awake', 'Hold none, even for --headed')
    .option('--hold-front', 'Keep the --headed browser frontmost; red if it could not be')
    .option('--throttle <clamp>', 'Run the tests under taskpolicy: background or utility')
    .option('--release', 'Build and package the release recipe, in its own object directory')
    .option('--slot <name>', 'A slot by name; auto lets the scheduler pick the cheapest', 'auto')
    .option('--path <path...>', 'Further paths to capture beside the source and project inputs')
    .option('--owner <label>', 'Free-text label shown in job list; it grants nothing')
    .option('--timeout <seconds>', 'Stop waiting after this long; the job itself keeps running')
    .option('--namespace <path>', 'Host coordinator namespace')
    .action(
      jobAction(ctx, async (options: RunFlags) => {
        assertRunFlags(options);
        const timeout = parseWhole('--timeout', options.timeout);
        await assertSourceMode(ctx.getProjectRoot());
        const finished = await runJob({
          namespace: namespaceOf(options),
          projectRoot: ctx.getProjectRoot(),
          check: options.check === true,
          release: options.release === true,
          ...(options.build === undefined
            ? {}
            : { build: options.build as 'ui' | 'full' | 'none' }),
          tests: options.test ?? [],
          shape: {
            ...(options.headed === true ? { headed: true } : {}),
            ...(options.shard ? {} : { dispatch: 'one-browser' as const }),
            ...(options.standalone === true ? { dispatch: 'standalone' as const } : {}),
            ...(options.env === undefined ? {} : { env: parseEnvironmentAssignments(options.env) }),
            ...(options.uploadDir === true ? { uploadDir: true } : {}),
            ...(options.machArg === undefined ? {} : { machArgs: options.machArg }),
            ...(options.holdFront === true ? { holdFront: true } : {}),
            ...(options.throttle === undefined
              ? {}
              : { throttle: options.throttle as 'background' | 'utility' }),
          },
          ...(options.keepAwake === undefined ? {} : { keepAwake: options.keepAwake }),
          slot: options.slot,
          paths: options.path ?? [],
          ...(options.owner === undefined ? {} : { owner: options.owner }),
          ...(timeout === undefined ? {} : { timeoutMs: timeout * 1_000 }),
        });
        printJob(finished);
        exitWithState(finished, true);
      })
    );
}

const LOG_LIMIT = 262_144;

interface LogOptions extends NamespaceOption {
  step?: string;
  offset: string;
  limit: string;
}

/** The step a failed job went red on: the last red one when it went on past reds. */
function redStep(job: JobView): number | undefined {
  if (job.state !== 'failed') return undefined;
  const reds = (job.stepVerdicts ?? []).filter((verdict) => verdict.state === 'red');
  return reds.at(-1)?.step ?? job.phase?.index;
}

/**
 * A failed job's red step, or its tail when it is longer than one chunk, and a
 * note saying what this is and how to read the rest. A red step that wrote
 * nothing, such as a refused one, leaves the whole log's start.
 */
async function redStepLog(
  namespace: string,
  job: JobView,
  red: number,
  limit: number
): Promise<{ chunk: LogChunk; note: string }> {
  const label = `step ${String(red)} (${job.request.steps[red]?.command ?? 'step'}), the red step`;
  const others = (job.stepVerdicts ?? [])
    .filter((verdict) => verdict.state === 'red' && verdict.step !== red)
    .map((verdict) => `step ${String(verdict.step)}`);
  const also = others.length === 0 ? '' : ` (also red: ${others.join(', ')})`;
  const short = job.id.slice(0, 8);
  try {
    const chunk = await readJobLogs(namespace, job.id, 0, limit, {
      step: red,
      tail: true,
      steps: job.request.steps,
    });
    const shown =
      chunk.offset === undefined || chunk.offset === 0
        ? `all ${String(chunk.totalBytes)} bytes`
        : `its last ${String(chunk.totalBytes - chunk.offset)} of ${String(chunk.totalBytes)} bytes`;
    const listed =
      chunk.steps === undefined ? '' : ` (steps with output: ${chunk.steps.join(', ')})`;
    return {
      chunk,
      note: `${label}${also}: ${shown}. Another step: fireforge job logs ${short} --step <n>${listed}; the whole log: --offset 0`,
    };
  } catch (error) {
    if (!(error instanceof InvalidLogRangeError)) throw error;
    return {
      chunk: await readJobLogs(namespace, job.id, 0, limit),
      note: `${label}${also}, wrote nothing to the log, so this is the whole log from its start. Read on with --offset <nextOffset>`,
    };
  }
}

function registerReads(job: Command, ctx: CommandContext): void {
  job
    .command('status <id>')
    .description(
      'Print a job; exits nonzero once it has failed, been cancelled or been interrupted'
    )
    .option('--namespace <path>', 'Host coordinator namespace')
    .action(
      jobAction(ctx, async (id: string, options: NamespaceOption) => {
        const namespace = namespaceOf(options);
        const current = await readJob(namespace, await resolveJobId(namespace, id));
        printJob(current);
        exitWithState(current);
      })
    );
  job
    .command('wait <id>')
    .description('Wait for a job to end; exit codes tell passed, failed, stopped and wait timeout')
    .option(
      '--timeout <seconds>',
      'Stop waiting after this long; the job itself keeps running',
      '60'
    )
    .option('--namespace <path>', 'Host coordinator namespace')
    .action(
      jobAction(ctx, async (id: string, options: NamespaceOption & { timeout: string }) => {
        const timeout = parseWhole('--timeout', options.timeout, 0) ?? 60;
        const namespace = namespaceOf(options);
        const jobId = await resolveJobId(namespace, id);
        const current = await waitForJob(namespace, jobId, timeout * 1_000);
        printJob(current);
        exitWithState(current, true);
      })
    );
  job
    .command('list')
    .description('List every job on this host, newest first')
    .option('--namespace <path>', 'Host coordinator namespace')
    .action(
      jobAction(ctx, async (options: NamespaceOption) => {
        const jobs = await listJobs(namespaceOf(options));
        printResult({ jobs }, jobs.length === 0 ? 'No jobs' : jobs.map(jobVerdict).join('\n'));
      })
    );
  job
    .command('logs <id>')
    .description(
      'Print a bounded range of a job log; a failed job shows its red step. --json adds the next offset'
    )
    .option('--step <n>', 'Only this step, numbered from 0; offsets count from its start')
    .option('--offset <bytes>', 'Log byte offset; 0 reads from the start', '0')
    .option('--limit <bytes>', 'Maximum log chunk bytes, up to 1048576', String(LOG_LIMIT))
    .option('--namespace <path>', 'Host coordinator namespace')
    .action(
      jobAction(ctx, async (id: string, options: LogOptions, command: Command) => {
        const namespace = namespaceOf(options);
        const jobId = await resolveJobId(namespace, id);
        const job = await readJob(namespace, jobId);
        const step = parseWhole('--step', options.step, 0);
        const offset = Number(options.offset);
        const limit = Number(options.limit);
        const named = (flag: string): boolean => command.getOptionValueSource(flag) === 'cli';
        const red =
          step === undefined && !named('offset') && !named('limit') ? redStep(job) : undefined;
        let chunk: LogChunk;
        let note: string | undefined;
        if (red !== undefined) {
          ({ chunk, note } = await redStepLog(namespace, job, red, limit));
        } else
          chunk =
            step === undefined
              ? await readJobLogs(namespace, jobId, offset, limit)
              : await readJobLogs(namespace, jobId, offset, limit, {
                  step,
                  steps: job.request.steps,
                });
        if (wantsMachineOutput())
          printResult({ ...chunk, ...(note === undefined ? {} : { note }) }, '');
        else {
          process.stdout.write(chunk.text);
          // After the text, where a person reading a long tail sees it.
          if (note !== undefined) process.stderr.write(`job logs: ${note}\n`);
        }
      })
    );
}

/** Durable job lifecycle, independent of an agent/tool caller's lifetime. */
export function registerJob(program: Command, ctx: CommandContext): void {
  const job = program
    .command('job')
    .description('Submit and reconnect to durable frozen-source jobs')
    .option('--json', 'Write one JSON document, or an error envelope');
  registerSubmit(job, ctx);
  registerRun(job, ctx);
  registerReads(job, ctx);
  job
    .command('cancel <id>')
    .description('Cancel any job by ID')
    .option('--namespace <path>', 'Host coordinator namespace')
    .action(
      jobAction(ctx, async (id: string, options: NamespaceOption) => {
        const namespace = namespaceOf(options);
        printJob(await cancelJob(namespace, await resolveJobId(namespace, id)));
      })
    );
  job
    .command('host-clear')
    .description('Clear host quarantine once a process census shows nothing it names still runs')
    .option(
      '--forget-group <group...>',
      'Clear these process groups regardless: their number now belongs to something else'
    )
    .option('--namespace <path>', 'Host coordinator namespace')
    .action(
      jobAction(ctx, async (options: NamespaceOption & { forgetGroup?: string[] }) => {
        const forget = (options.forgetGroup ?? []).map((group) => {
          const parsed = parseWhole('--forget-group', group);
          if (parsed === undefined) throw new InvalidArgumentError('--forget-group needs a group');
          return parsed;
        });
        const { cleared } = await clearHost(namespaceOf(options), forget);
        printResult(
          { cleared },
          cleared.length === 0
            ? 'Host quarantine: nothing to clear'
            : `Host quarantine cleared: ${cleared.join('; ')}`
        );
      })
    );
}
