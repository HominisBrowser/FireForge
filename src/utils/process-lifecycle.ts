// SPDX-License-Identifier: EUPL-1.2
import type { ChildProcess } from 'node:child_process';

import { signalDirectChild } from './child-process.js';
import { toError } from './errors.js';
import { verbose, warn } from './logger.js';
import {
  announceChildGroup,
  announceChildGroupEnd,
  reportProcessCleanupUncertainty,
} from './process-cleanup.js';
import { ownProcessTree, type ProcessOwnership, type ProcessTeardown } from './process-group.js';

/** How long after exit the output pipes get to close before they are abandoned. */
const DEFAULT_DRAIN_MS = 1_000;

/** Upper bound on a caller's own teardown. */
const POST_CLOSE_SWEEP_LIMIT_MS = 5_000;

/** How a tracked child ended. */
export interface ChildOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  /**
   * True when something still held the child's output pipes after it exited,
   * so output past that point was not collected. Holding a pipe does not make
   * a process this command's to signal.
   */
  pipesHeld: boolean;
}

/** One tracked child, from spawn to the end of its teardown. */
export interface ChildLifetime {
  owner: ProcessOwnership | undefined;
  /**
   * Resolves with the exit, once teardown is done. Rejects only with the
   * child's own failure (a failed spawn, an expired timeout). A survivor or an
   * uncertain teardown is a diagnostic and never changes the result.
   */
  completion: Promise<ChildOutcome>;
  signal: (signal: NodeJS.Signals) => void;
}

/** Options for {@link trackChildLifetime}. */
export interface ChildLifetimeOptions {
  /** Treat the child as a detached group leader and own its tree. */
  processGroup: boolean;
  /** Between SIGTERM and SIGKILL, for a timeout and for survivors. */
  graceMs: number;
  /** How long after exit the pipes get to close. */
  drainMs?: number;
  /** The caller's own teardown, run after the tree's and awaited (bounded). */
  postCloseSweep?: () => Promise<void>;
}

/** Whether `promise` settles within `ms`. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, ms);
  });
  try {
    return await Promise.race([promise.then(() => true), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** Turns what a teardown did into log lines, and uncertainty into a report. */
async function surfaceTeardown(teardown: ProcessTeardown | undefined): Promise<void> {
  if (teardown === undefined) return;
  if (teardown.signalled.length > 0) {
    warn(
      `${teardown.signalled.length} process(es) outlived their command and were terminated: ` +
        `PID ${teardown.signalled.map((entry) => entry.pid).join(', ')}.`
    );
  }
  if (teardown.detached.length > 0) {
    const rows = teardown.detached.map(
      (entry) => `${entry.pid} (${entry.command?.slice(0, 80) ?? 'command unavailable'})`
    );
    verbose(`Left running, detached and not attributable to this run: ${rows.join(', ')}.`);
  }
  const uncertainty =
    teardown.uncertain ??
    (teardown.stillAlive.length > 0
      ? `PID ${teardown.stillAlive.map((entry) => entry.pid).join(', ')} survived SIGKILL`
      : undefined);
  if (uncertainty !== undefined) await surfaceUncertainty(uncertainty);
}

async function surfaceUncertainty(reason: string): Promise<void> {
  warn(`Process cleanup is inconclusive: ${reason}. No unowned process was signalled.`);
  const failure = await reportProcessCleanupUncertainty(reason);
  if (failure !== undefined) {
    warn(`Could not report inconclusive process cleanup: ${toError(failure).message}`);
  }
}

async function runPostCloseSweep(sweep: () => Promise<void>): Promise<void> {
  let failure: unknown;
  const finished = sweep().catch((error: unknown) => {
    failure = error;
  });
  if (!(await settlesWithin(finished, POST_CLOSE_SWEEP_LIMIT_MS))) {
    failure = new Error(`exceeded ${POST_CLOSE_SWEEP_LIMIT_MS} ms`);
  }
  if (failure !== undefined) {
    await surfaceUncertainty(`caller teardown failed: ${toError(failure).message}`);
  }
}

/**
 * Follows a spawned child to the end of its teardown.
 *
 * `exit` starts the teardown. `close` only means the pipes drained: a
 * background process holding a pipe must not hold up the result or change it,
 * so the wait for it is bounded.
 *
 * An expired timeout has already sent SIGTERM (Node's abort path) to the
 * direct child. The group gets it too, and SIGKILL follows only after the
 * grace, so a process that needs its handler to clean up gets to run it.
 *
 * @param child - The spawned child
 * @param options - See {@link ChildLifetimeOptions}
 */
export function trackChildLifetime(
  child: ChildProcess,
  options: ChildLifetimeOptions
): ChildLifetime {
  const owner = options.processGroup ? ownProcessTree(child) : undefined;
  if (owner !== undefined) announceChildGroup(owner.pid);
  const signal = (value: NodeJS.Signals): void => {
    if (owner !== undefined) owner.signal(value);
    else signalDirectChild(child, value);
  };

  let primaryError: Error | undefined;
  let escalation: NodeJS.Timeout | undefined;
  let hasExited = false;
  const closed = new Promise<void>((resolve) => {
    child.once('close', () => {
      resolve();
    });
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    const onExit = (code: number | null, exitSignal: NodeJS.Signals | null): void => {
      hasExited = true;
      resolve({ code, signal: exitSignal });
    };
    child.once('exit', onExit);
    // A failed spawn emits `error` and `close` with no `exit`.
    child.once('close', onExit);
    // Stays attached: an abort can deliver its error at any point of the wait.
    child.on('error', (error) => {
      if (hasExited) return;
      primaryError ??= error;
      if (child.pid === undefined) {
        onExit(null, null);
        return;
      }
      if (owner !== undefined) owner.signal('SIGTERM');
      escalation ??= setTimeout(() => {
        signal('SIGKILL');
      }, options.graceMs);
      escalation.unref();
    });
  });

  const completion = (async (): Promise<ChildOutcome> => {
    const exit = await exited;
    if (escalation !== undefined) clearTimeout(escalation);
    const teardown = await owner?.finish(options.graceMs);
    if (owner !== undefined && teardown?.uncertain === undefined && !teardown?.stillAlive.length) {
      announceChildGroupEnd(owner.pid);
    }
    const pipesHeld = !(await settlesWithin(closed, options.drainMs ?? DEFAULT_DRAIN_MS));
    if (pipesHeld) {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
      child.unref();
      verbose(`PID ${child.pid ?? '?'} exited, but a background process still holds its pipes.`);
    }
    if (options.postCloseSweep !== undefined) await runPostCloseSweep(options.postCloseSweep);
    await surfaceTeardown(teardown);
    if (primaryError !== undefined) throw primaryError;
    return { ...exit, pipesHeld };
  })();
  return { owner, completion, signal };
}
