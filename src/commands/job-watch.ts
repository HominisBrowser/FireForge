// SPDX-License-Identifier: EUPL-1.2
/**
 * `job watch`: the source-mode rebuild loop. Every saved change to what a
 * capture holds is captured, submitted as the job `job run` would submit and
 * waited for, and each job's verdict line is printed as `job run` prints it.
 * Watch jobs are ordinary jobs: the request carries nothing about watching, so
 * their evidence counts as a `job run`'s does.
 */
import type { Command } from 'commander';

import { captureAuthoredSnapshot, capturedRoots } from '../core/authored/index.js';
import type { AuthoredSnapshot } from '../core/authored/types.js';
import { loadConfig } from '../core/config.js';
import { cancelJob, submitJob, waitForJob } from '../core/jobs/client.js';
import { type JobView, normalizeRequest } from '../core/jobs/schema.js';
import type { StepShape } from '../core/proof/plan.js';
import { InvalidArgumentError } from '../errors/base.js';
import type { CommandContext } from '../types/cli.js';
import { toError } from '../utils/errors.js';
import { runSteps } from './job-run.js';
import {
  assertSourceMode,
  exitWithState,
  jobAction,
  namespaceOf,
  parseWhole,
  printJob,
  pristineDonor,
  redStep,
  waitReporter,
} from './job-support.js';
import { capturedChanges, defaultInputWatcher, type InputWatcher } from './job-watch-inputs.js';

/** How long Ctrl-C or SIGTERM waits for the in-flight job's cancel to settle. */
const STOP_SETTLE_MS = 60_000;
const DEFAULT_DEBOUNCE_MS = 500;

const SIGNALS = ['SIGINT', 'SIGTERM'] as const;
type Signal = (typeof SIGNALS)[number];

export interface WatchJobsOptions {
  namespace: string;
  projectRoot: string;
  build: 'ui' | 'full' | 'none';
  tests: readonly string[];
  check: boolean;
  /** How the tests run, as `job run` composes it. */
  shape?: StepShape;
  /** A slot's name, or `auto` for the scheduler's pick, which the watch then keeps. */
  slot: string;
  /** Further capture inputs, as `job run --path` takes them. */
  paths: readonly string[];
  /** Capture with changed files outside the selection left out. */
  allowDirtyRoot?: boolean;
  owner?: string;
  /** Quiet time after the last change before a capture. */
  debounceMs: number;
  /** Cancel the running job when a newer capture differs, rather than let it finish. */
  supersede: boolean;
}

/** What a test replaces, so it neither waits on the OS nor reads the terminal. */
export interface WatchSeams {
  watcher?: InputWatcher;
  /** Each finished job: its verdict line, or its record under `--json`. */
  verdict?: (job: JobView) => void;
  /** What the watch itself says, to stderr. */
  note?: (line: string) => void;
  stopSettleMs?: number;
}

interface Running {
  id: string;
  /** Settles once the job is terminal and its verdict printed. */
  done: Promise<void>;
  /** This watch cancelled it, for a newer capture or for a stop. */
  cancelledHere: boolean;
  /** A change waits for it to end, and the operator was told. */
  deferred: boolean;
}

const short = (id: string): string => id.slice(0, 8);

/** The loop: one capture at a time, at most one job in flight, at most one pending change. */
class WatchLoop {
  private slot: string;
  /** A change, or the start, awaits a capture. Many changes are one pending capture. */
  private dirty = true;
  private stopping: Signal | undefined;
  private wakeUp: () => void = () => undefined;
  private current: Running | undefined;
  private lastSubmitted: string | undefined;
  private lastFinished: JobView | undefined;
  private readonly pending = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private filtering: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: WatchJobsOptions,
    private readonly selection: readonly string[],
    private readonly verdict: (job: JobView) => void,
    private readonly note: (line: string) => void,
    private readonly stopSettleMs: number
  ) {
    this.slot = options.slot;
  }

  /** Raw changes from the watcher. A capture follows once they have been quiet for the debounce. */
  changed(paths: readonly string[]): void {
    for (const path of paths) this.pending.add(path);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.settleChanges();
    }, this.options.debounceMs);
  }

  stop(signal: Signal): void {
    this.stopping = signal;
    clearTimeout(this.timer);
    this.wake();
  }

  /** @returns The last job that ran to its own end, which the exit code reads */
  async run(): Promise<JobView | undefined> {
    while (this.stopping === undefined) {
      if (!this.dirty || (this.current !== undefined && !this.options.supersede)) {
        await this.sleep();
        continue;
      }
      this.dirty = false;
      await this.pass();
    }
    await this.settleOnStop(this.stopping);
    return this.lastFinished;
  }

  private settleChanges(): void {
    const batch = [...this.pending];
    this.pending.clear();
    this.filtering = this.filtering.then(async () => {
      const relevant = await capturedChanges(
        this.options.projectRoot,
        this.selection,
        this.options.paths,
        batch
      ).catch((error: unknown) => {
        this.note(`Could not sort the changes (${toError(error).message}): capturing anyway`);
        return batch;
      });
      if (relevant.length === 0 || this.stopping !== undefined) return;
      this.dirty = true;
      const running = this.current;
      if (running !== undefined && !this.options.supersede && !running.deferred) {
        running.deferred = true;
        this.note(`Changed while job ${short(running.id)} runs: captured once it ends`);
      }
      this.wake();
    });
  }

  private sleep(): Promise<void> {
    return new Promise((wake) => {
      this.wakeUp = wake;
    });
  }

  private wake(): void {
    const wake = this.wakeUp;
    this.wakeUp = () => undefined;
    wake();
  }

  /** One capture, and a submission when it differs from the last one submitted. */
  private async pass(): Promise<void> {
    let snapshot: AuthoredSnapshot;
    try {
      snapshot = await captureAuthoredSnapshot({
        projectRoot: this.options.projectRoot,
        intendedPaths: [...this.options.paths],
        pristineRepository: await pristineDonor(this.options.namespace, this.options.projectRoot),
        ...(this.options.allowDirtyRoot === true ? { allowDirtyRoot: true } : {}),
        onNotice: (message) => {
          this.note(message);
        },
      });
    } catch (error) {
      this.note(`Capture refused: ${toError(error).message}. Watching for the next change`);
      return;
    }
    if (this.stopped()) return;
    if (snapshot.id === this.lastSubmitted) {
      this.note(`Snapshot ${short(snapshot.id)} unchanged: nothing submitted`);
      return;
    }
    if (this.current !== undefined) await this.supersede(this.current);
    if (!this.stopped()) await this.submit(snapshot);
  }

  /** Read through a call, so a check after an await sees a stop that came during it. */
  private stopped(): boolean {
    return this.stopping !== undefined;
  }

  private async supersede(running: Running): Promise<void> {
    running.cancelledHere = true;
    this.note(`Job ${short(running.id)} superseded by a newer capture: cancelling it`);
    await cancelJob(this.options.namespace, running.id, { force: true }).catch((error: unknown) => {
      this.note(`Job ${short(running.id)}: the cancel was refused: ${toError(error).message}`);
    });
    await running.done;
  }

  /** Submits the request `job run` would, with the kept slot named once there is one. */
  private async submit(snapshot: AuthoredSnapshot): Promise<void> {
    const { namespace, build, tests, check, shape, owner } = this.options;
    const request = normalizeRequest(
      {
        steps: runSteps({ check, build, tests, ...(shape === undefined ? {} : { shape }) }),
        ...(this.slot === 'auto' ? {} : { slot: this.slot }),
      },
      snapshot.id
    );
    let job: JobView;
    try {
      job = await submitJob(namespace, request, snapshot, ...(owner === undefined ? [] : [owner]));
    } catch (error) {
      if (error instanceof TypeError || error instanceof ReferenceError) throw error;
      this.note(`Submission refused: ${toError(error).message}. Watching for the next change`);
      return;
    }
    this.lastSubmitted = snapshot.id;
    this.note(`Job ${job.id} submitted for snapshot ${short(snapshot.id)}`);
    const running: Running = {
      id: job.id,
      cancelledHere: false,
      deferred: false,
      done: Promise.resolve(),
    };
    let blocked: string | undefined;
    running.done = waitForJob(
      namespace,
      job.id,
      Number.POSITIVE_INFINITY,
      (reason) => {
        if (reason !== blocked) this.note(`Job ${job.id} waiting: ${reason}`);
        blocked = reason;
      },
      waitReporter((line) => {
        this.note(`Job ${job.id} ${line}`);
      })
    ).then(
      (view) => {
        this.finished(running, view);
      },
      (error: unknown) => {
        this.note(
          `Job ${job.id}: lost track of it (${toError(error).message}); fireforge job status ${short(job.id)} reads it`
        );
        if (this.current === running) this.current = undefined;
        this.wake();
      }
    );
    this.current = running;
  }

  private finished(running: Running, view: JobView): void {
    if (this.current === running) this.current = undefined;
    this.verdict(view);
    const red = redStep(view);
    if (view.state === 'failed')
      this.note(
        red === undefined
          ? `Job ${short(view.id)} went red: fireforge job logs ${short(view.id)}`
          : `Job ${short(view.id)} went red at step ${red} (${view.request.steps[red]?.command ?? 'step'}): fireforge job logs ${short(view.id)} prints that step`
      );
    // A job this watch cancelled ended because the watch asked, not on its own.
    if (!(running.cancelledHere && view.state === 'cancelled')) this.lastFinished = view;
    if (this.slot === 'auto' && view.slot !== undefined) {
      this.slot = view.slot;
      this.note(`Keeping slot ${view.slot} for the next jobs, so its object directory stays warm`);
    }
    if (running.deferred) this.dirty = true;
    this.wake();
  }

  private async settleOnStop(signal: Signal): Promise<void> {
    const running = this.current;
    if (running === undefined) return;
    running.cancelledHere = true;
    this.note(
      `${signal}: cancelling job ${short(running.id)} and waiting up to ${Math.round(this.stopSettleMs / 1000)}s for the cancel to settle; ${signal === 'SIGINT' ? 'Ctrl-C' : signal} again stops waiting, and the cancel stands`
    );
    await cancelJob(this.options.namespace, running.id, { force: true }).catch((error: unknown) => {
      this.note(`Job ${short(running.id)}: the cancel was refused: ${toError(error).message}`);
    });
    let timer: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      running.done.then(() => true),
      new Promise<false>((give) => {
        timer = setTimeout(() => {
          give(false);
        }, this.stopSettleMs);
      }),
    ]);
    clearTimeout(timer);
    if (!settled)
      this.note(
        `Job ${short(running.id)} is still settling its cancel; fireforge job status ${short(running.id)} reads it`
      );
  }
}

/**
 * Takes SIGINT and SIGTERM from the process's own handlers while watching. The
 * first one calls `onFirst`; a second one hands the signal back to those
 * handlers, which end the process.
 *
 * @returns What gives the handlers back
 */
function holdSignals(onFirst: (signal: Signal) => void): () => void {
  const saved = new Map(SIGNALS.map((signal) => [signal, process.listeners(signal)] as const));
  let seen = false;
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    for (const signal of SIGNALS) {
      process.off(signal, handler);
      for (const listener of saved.get(signal) ?? []) process.on(signal, listener);
    }
  };
  function handler(signal: Signal): void {
    if (!seen) {
      seen = true;
      onFirst(signal);
      return;
    }
    restore();
    process.kill(process.pid, signal);
  }
  for (const signal of SIGNALS) {
    process.removeAllListeners(signal);
    process.on(signal, handler);
  }
  return restore;
}

/**
 * Watches what a capture holds and runs a job for every change that alters it,
 * until SIGINT or SIGTERM. The first pass captures the checkout as it stands.
 *
 * @returns The last job that ran to its own end, or undefined when none did
 */
export async function watchJobs(
  options: WatchJobsOptions,
  seams: WatchSeams = {}
): Promise<JobView | undefined> {
  const note =
    seams.note ??
    ((line: string): void => {
      process.stderr.write(`job watch: ${line}\n`);
    });
  const { sources } = await loadConfig(options.projectRoot);
  if (sources === undefined)
    throw new InvalidArgumentError(
      'job watch needs a source-mode project: it watches what a capture holds'
    );
  const selection = [...new Set([...capturedRoots(sources), ...options.paths])];
  const loop = new WatchLoop(
    options,
    selection,
    seams.verdict ?? printJob,
    note,
    seams.stopSettleMs ?? STOP_SETTLE_MS
  );
  const release = holdSignals((signal) => {
    loop.stop(signal);
  });
  let watch: Awaited<ReturnType<InputWatcher>> | undefined;
  try {
    watch = await (seams.watcher ?? defaultInputWatcher)({
      projectRoot: options.projectRoot,
      selection,
      onChange: (paths) => {
        loop.changed(paths);
      },
      onError: (error) => {
        note(`The watch reported: ${error.message}`);
      },
    });
    note(`Watching ${selection.join(', ')} with ${watch.backend}; Ctrl-C stops`);
    return await loop.run();
  } finally {
    watch?.close();
    release();
  }
}

interface WatchFlags {
  build: string;
  test?: string[];
  check?: boolean;
  headed?: boolean;
  repeat?: string;
  shuffle?: string;
  slot: string;
  path?: string[];
  owner?: string;
  allowDirtyRoot?: boolean;
  debounce: string;
  supersede: boolean;
  namespace?: string;
}

/** What `job watch` flags cannot mean together. */
function assertWatchFlags(options: WatchFlags): void {
  if (!['ui', 'full', 'none'].includes(options.build))
    throw new InvalidArgumentError('--build must be ui, full or none', '--build');
  if (
    options.test === undefined &&
    (options.headed === true || options.repeat !== undefined || options.shuffle !== undefined)
  )
    throw new InvalidArgumentError(
      '--headed, --repeat and --shuffle describe how tests run: name them with --test',
      '--test'
    );
  if (options.build === 'none' && options.test === undefined && options.check !== true)
    throw new InvalidArgumentError(
      '--build none leaves nothing to run on each change: name --test or --check, or a build',
      '--build'
    );
}

/** The test shape `job run` composes from the same flags. */
function watchShape(options: WatchFlags): StepShape {
  const repeat = parseWhole('--repeat', options.repeat);
  const shuffle = parseWhole('--shuffle', options.shuffle);
  return {
    ...(options.headed === true ? { headed: true } : {}),
    ...(repeat === undefined && shuffle === undefined
      ? {}
      : {
          args: [
            ...(repeat === undefined ? [] : ['--repeat', String(repeat)]),
            ...(shuffle === undefined ? [] : ['--shuffle', String(shuffle)]),
          ],
        }),
  };
}

/** Registers `job watch`. */
export function registerWatch(job: Command, ctx: CommandContext): void {
  job
    .command('watch')
    .description(
      'Capture, run and print a verdict line on every saved change, in one kept slot, until Ctrl-C'
    )
    .option('--build <kind>', 'Build each change first: ui, full or none', 'ui')
    .option(
      '--test <path...>',
      'Browser test files to run after each build, headless unless --headed'
    )
    .option('--check', 'Run the project check on each change, before the build')
    .option('--headed', 'Run the tests with a visible window, which holds the display')
    .option('--repeat <n>', 'Run the tests this many times; the verdict reads red if any repeat is')
    .option('--shuffle <seed>', 'Run the tests in the order this seed gives')
    .option(
      '--slot <name>',
      'A slot by name; auto lets the scheduler pick the first, which the watch then keeps',
      'auto'
    )
    .option(
      '--path <path...>',
      'Further paths to capture and watch beside the source and project inputs'
    )
    .option('--owner <label>', 'Free-text label shown in job list; it grants nothing')
    .option('--allow-dirty-root', 'Capture with changed files outside the selection left out')
    .option(
      '--debounce <ms>',
      'Quiet time after the last change before a capture',
      String(DEFAULT_DEBOUNCE_MS)
    )
    .option('--no-supersede', 'Let a running job finish before the newest change runs')
    .option('--namespace <path>', 'Host coordinator namespace')
    .action(
      jobAction(ctx, async (options: WatchFlags) => {
        assertWatchFlags(options);
        const debounceMs = parseWhole('--debounce', options.debounce, 0) ?? DEFAULT_DEBOUNCE_MS;
        const shape = watchShape(options);
        const projectRoot = ctx.getProjectRoot();
        await assertSourceMode(projectRoot);
        const last = await watchJobs({
          namespace: namespaceOf(options),
          projectRoot,
          build: options.build as WatchJobsOptions['build'],
          tests: options.test ?? [],
          check: options.check === true,
          shape,
          slot: options.slot,
          paths: options.path ?? [],
          ...(options.allowDirtyRoot === true ? { allowDirtyRoot: true } : {}),
          ...(options.owner === undefined ? {} : { owner: options.owner }),
          debounceMs,
          supersede: options.supersede,
        });
        // Exit 0 when the last job that ran to its own end passed, or none did; else what `job run` exits for it.
        if (last !== undefined) exitWithState(last);
      })
    );
}
