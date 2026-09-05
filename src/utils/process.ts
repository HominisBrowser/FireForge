// SPDX-License-Identifier: EUPL-1.2
import { type ChildProcess, spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { StringDecoder } from 'node:string_decoder';

import { ExecTimeoutError, type ExecTimeoutOutput } from '../errors/base.js';
import { buildChildEnv } from './child-env.js';
import { dispatchCompleteLines } from './line-dispatch.js';
import { killProcessTree, sweepProcessGroup } from './process-group.js';

// 50 MB cap per stream to prevent OOM — large toolchain builds (e.g. Firefox, Chromium)
// can easily blow past this, so we truncate rather than let the buffer grow unbounded.
// Callers for whom truncation is unacceptable (e.g. the archive-safety preflight
// scanning a full `tar -tvf` listing) must check `wasTruncated` and fail hard.
const MAX_OUTPUT_SIZE = 50 * 1024 * 1024;

function createStreamCollector(mirror?: NodeJS.WritableStream): {
  onData: (data: Buffer) => void;
  getText: () => string;
  wasTruncated: () => boolean;
} {
  const chunks: string[] = [];
  let totalLength = 0;
  let truncated = false;
  // A per-stream StringDecoder keeps multibyte UTF-8 characters split across
  // pipe chunk boundaries intact. Per-chunk `Buffer.toString()` turned a
  // straddling character into two U+FFFD replacement chars, which silently
  // broke regex matching over captured output (smoke-run allowlists, mach
  // error hints) whenever a non-ASCII path or localized message landed on a
  // 64 KB chunk boundary.
  const decoder = new StringDecoder('utf8');
  return {
    onData: (data: Buffer) => {
      const chunk = decoder.write(data);
      if (chunk.length === 0) return;
      mirror?.write(chunk);
      if (truncated) return;
      const remaining = MAX_OUTPUT_SIZE - totalLength;
      if (chunk.length > remaining) {
        chunks.push(chunk.slice(0, remaining));
        chunks.push('\n[truncated — output exceeded 50 MB]');
        totalLength = MAX_OUTPUT_SIZE;
        truncated = true;
      } else {
        chunks.push(chunk);
        totalLength += chunk.length;
      }
    },
    getText: () => chunks.join(''),
    wasTruncated: () => truncated,
  };
}

/**
 * Result of executing a command.
 */
export interface ExecResult {
  /** Standard output content */
  stdout: string;
  /** Standard error content */
  stderr: string;
  /** Process exit code */
  exitCode: number;
  /**
   * True when `stdout` was cut off at the 50 MB collector cap. Optional so
   * existing mocks stay valid; absent means "not truncated". Callers that
   * feed the output into safety decisions (e.g. archive-listing scans) must
   * treat `true` as a hard failure — a truncated listing looks exactly like
   * a complete one otherwise.
   */
  stdoutTruncated?: boolean;
  /** True when `stderr` was cut off at the 50 MB collector cap. See {@link ExecResult.stdoutTruncated}. */
  stderrTruncated?: boolean;
}

/**
 * Options for plain `exec()` — the pipe-capturing, non-grouped, non-mirrored
 * path. The other wrappers extend this with the fields they actually read:
 * `processGroup` lives in {@link ProcessGroupOptions}, `mirror` in
 * {@link MirrorOptions}. Neither belongs here because `exec()` reads
 * neither — a field the type accepts but the function ignores is a trap
 * (the caller believes it got a process group, and never did).
 */
export interface ExecOptions {
  /** Working directory for the command */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /**
   * Environment variables to REMOVE from the child's inherited environment,
   * applied after {@link ExecOptions.env} is merged over `process.env`.
   *
   * Needed because `env` can only add or overwrite, and some variables are
   * read for their PRESENCE — mozbuild's `is_running_under_coding_agent()`
   * keys on `CLAUDECODE`, so setting it empty would not unset it. An
   * explicit delete says what it means; relying on Node dropping
   * `undefined`-valued env entries would be a semantics gamble at a layer
   * that must not have any.
   */
  envUnset?: readonly string[];
  /** Timeout in milliseconds */
  timeout?: number;
}

/**
 * Output mirroring for the wrappers that capture through a collector
 * ({@link execInheritCapture}, {@link execSmokeRun}).
 */
export interface MirrorOptions {
  /**
   * Streams to mirror the child's output into, replacing the default
   * `process.stdout` / `process.stderr` on the stdio-inheriting capture
   * path, or an operator-supplied `--capture-console` file on the smoke
   * path. Lets a caller tee the live output somewhere else (a run log)
   * without a second per-chunk hook. Writes happen inline with capture and
   * the stream is NOT closed here — the caller owns its lifecycle.
   */
  mirror?: { stdout?: NodeJS.WritableStream; stderr?: NodeJS.WritableStream };
}

/**
 * Process-group reaping for the long-lived wrappers ({@link execStream},
 * {@link execInherit}, {@link execInheritCapture}).
 */
export interface ProcessGroupOptions {
  /**
   * POSIX: spawn the child as a process-group leader and route every kill
   * (parent-signal forwarding, abort, escalation) to the whole GROUP, then
   * sweep the group for survivors after close — so a harness that dies at
   * startup cannot strand spinning `multiprocessing` workers, which reparent
   * to launchd and busy-spin at 100% CPU indefinitely. Win32: tree-kill via
   * `taskkill /T /F` on abort/signals only, no post-run sweep
   * (best-effort). Default false — non-mach consumers are unaffected.
   *
   * NOTE for callers: a detached group leader does NOT receive terminal
   * Ctrl+C; the exec layer installs its own group-aware signal forwarder
   * whenever this option is set.
   */
  processGroup?: boolean;
}

function buildSignalFromTimeout(timeout: number | undefined): AbortSignal | undefined {
  if (timeout === undefined) return undefined;
  return AbortSignal.timeout(timeout);
}

/**
 * Maps a child-process `error` event to the rejection the caller sees.
 * When the caller set a `timeout` and the error is the AbortError produced
 * by `AbortSignal.timeout` firing, rejects with a typed
 * {@link ExecTimeoutError} naming the command and budget instead of Node's
 * opaque `AbortError: The operation was aborted`.
 */
function toExecRejection(
  error: Error,
  command: string,
  args: readonly string[],
  timeout: number | undefined,
  output?: ExecTimeoutOutput
): Error {
  if (timeout !== undefined && error.name === 'AbortError') {
    return new ExecTimeoutError(command, args, timeout, error, output);
  }
  return error;
}

/**
 * Snapshot of what two collectors hold, for carrying onto a timeout
 * rejection. Without it a `git add -A` killed at its budget rejected with
 * nothing but the budget — the partial stdout/stderr that said what git was
 * doing when it died was already collected and simply dropped.
 */
function collectedOutput(
  out: ReturnType<typeof createStreamCollector>,
  err: ReturnType<typeof createStreamCollector>
): ExecTimeoutOutput {
  return {
    stdout: out.getText(),
    stderr: err.getText(),
    truncated: out.wasTruncated() || err.wasTruncated(),
  };
}

function exitCodeFromClose(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) {
    return code;
  }

  if (signal) {
    const signalNumber = osConstants.signals[signal];
    if (typeof signalNumber === 'number') {
      return 128 + signalNumber;
    }
  }

  return 1;
}

/**
 * Executes a command and returns its output.
 * @param command - Command to execute
 * @param args - Command arguments
 * @param options - Execution options
 * @returns Execution result with stdout, stderr, and exit code
 */
export async function exec(
  command: string,
  args: string[],
  options: ExecOptions = {}
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: buildChildEnv(options),
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: buildSignalFromTimeout(options.timeout),
    });

    const out = createStreamCollector();
    const err = createStreamCollector();
    child.stdout.on('data', out.onData);
    child.stderr.on('data', err.onData);

    child.on('error', (error) => {
      reject(toExecRejection(error, command, args, options.timeout, collectedOutput(out, err)));
    });

    child.on('close', (code, signal) => {
      resolve({
        stdout: out.getText(),
        stderr: err.getText(),
        exitCode: exitCodeFromClose(code, signal),
        stdoutTruncated: out.wasTruncated(),
        stderrTruncated: err.wasTruncated(),
      });
    });
  });
}

/**
 * Callback for streaming output.
 */
type StreamCallback = (data: string) => void;

/**
 * Options for streaming command execution.
 */
interface StreamOptions extends ExecOptions, ProcessGroupOptions {
  /** Callback for stdout data */
  onStdout?: StreamCallback;
  /** Callback for stderr data */
  onStderr?: StreamCallback;
}

/** The spawn options {@link spawnTracked} decides for every tracked variant. */
interface TrackedSpawnBase {
  cwd: string | undefined;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal | undefined;
  detached: boolean;
}

/** How one tracked wrapper differs from the others. See {@link spawnTracked}. */
interface TrackedSpawnSpec<C extends ChildProcess, T> {
  /** Command name, carried into the timeout rejection. */
  command: string;
  /** Command arguments, carried into the timeout rejection. */
  args: string[];
  /** Caller options; only `cwd`, `timeout` and `processGroup` are read here. */
  options: ExecOptions & ProcessGroupOptions;
  /** Grace between the forwarded SIGTERM and the SIGKILL escalation. */
  graceMs: number;
  /**
   * Whether a child that is NOT a process-group leader still gets the
   * shutdown forwarder. A detached leader always gets one — it no longer
   * receives the terminal's Ctrl+C, so forwarding is what keeps it killable.
   */
  forwardWithoutProcessGroup: boolean;
  /** Performs the spawn, adding the variant's `stdio` to the shared base. */
  spawnChild: (base: TrackedSpawnBase) => C;
  /** Wires stream handlers, before any exit handler can fire. */
  attach?: (child: C) => void;
  /** Builds the resolved value from the child's `close` arguments. */
  result: (code: number | null, signal: NodeJS.Signals | null) => T;
  /** Partial output to carry onto a timeout rejection, when the variant captures any. */
  rejectionOutput?: () => ExecTimeoutOutput;
}

/**
 * The shared body of every spawn wrapper that outlives its call: detach
 * decision, shutdown forwarding, closure tracking, process-group sweep and
 * typed timeout rejection.
 *
 * `execStream`, `execInherit` and `execInheritCapture` each hand-rolled this
 * sequence, and the copies drifted: `execStream` was the one that omitted
 * {@link trackChildClosure}, so the bin signal handler did not wait for
 * `runMachStream`'s children on Ctrl+C and the forwarder's SIGTERM → grace →
 * SIGKILL escalation could not finish before the parent exited — the exact
 * failure the tracking set was introduced to fix, left unwired in one copy.
 * Keeping the sequence in one place is what stops that recurring.
 *
 * `exec` deliberately stays outside: it neither forwards signals nor tracks
 * closure, because it is for short-lived helpers that no one Ctrl+Cs through.
 * `execSmokeRun` also stays outside: its deadline owns the SIGTERM → grace →
 * SIGKILL escalation directly, so it shares no forwarder with the others.
 *
 * @param spec - The variant's stdio, stream wiring, grace budget and result shape
 * @returns Whatever `spec.result` builds from the child's `close` event
 */
async function spawnTracked<C extends ChildProcess, T>(spec: TrackedSpawnSpec<C, T>): Promise<T> {
  const { command, args, options } = spec;
  return new Promise<T>((resolve, reject) => {
    const usesProcessGroup = options.processGroup === true && process.platform !== 'win32';
    const child = spec.spawnChild({
      cwd: options.cwd,
      env: buildChildEnv(options),
      signal: buildSignalFromTimeout(options.timeout),
      detached: usesProcessGroup,
    });
    const groupPid = usesProcessGroup ? child.pid : undefined;

    spec.attach?.(child);

    // Group-aware kills route to the whole tree; a non-group child is killed
    // directly by the forwarder's own `child.kill`.
    const killTarget =
      options.processGroup === true
        ? (signal: NodeJS.Signals): void => {
            killProcessTree(child, signal, usesProcessGroup);
          }
        : undefined;
    const forwarder =
      spec.forwardWithoutProcessGroup || options.processGroup === true
        ? installGracefulShutdownForwarder(child, spec.graceMs, killTarget)
        : undefined;
    const closure = trackChildClosure();

    child.on('error', (error) => {
      // Abort/startup failure: make sure a partially-started tree does not
      // outlive the dispatch (a mach dying at startup used to strand
      // multiprocessing workers).
      if (options.processGroup === true) {
        killProcessTree(child, 'SIGKILL', usesProcessGroup);
      }
      forwarder?.dispose();
      closure.settle();
      reject(toExecRejection(error, command, args, options.timeout, spec.rejectionOutput?.()));
    });

    child.on('close', (code, signal) => {
      forwarder?.dispose();
      const finish = (): void => {
        closure.settle();
        resolve(spec.result(code, signal));
      };
      if (groupPid !== undefined) {
        sweepProcessGroup(groupPid).then(finish, finish);
      } else {
        finish();
      }
    });
  });
}

/**
 * Executes a command and streams its output.
 * @param command - Command to execute
 * @param args - Command arguments
 * @param options - Execution options
 * @returns Exit code of the process
 */
export async function execStream(
  command: string,
  args: string[],
  options: StreamOptions = {}
): Promise<number> {
  return spawnTracked({
    command,
    args,
    options,
    graceMs: 1500,
    // A detached group leader no longer receives the terminal's Ctrl+C, so
    // the forwarder is mandatory (not just graceful-UX) when processGroup
    // is set — but a plain streamed child does not get one.
    forwardWithoutProcessGroup: false,
    spawnChild: (base) => spawn(command, args, { ...base, stdio: ['ignore', 'pipe', 'pipe'] }),
    attach: (child) => {
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');

      child.stdout.on('data', (data: Buffer) => {
        const chunk = stdoutDecoder.write(data);
        if (chunk.length > 0) options.onStdout?.(chunk);
      });

      child.stderr.on('data', (data: Buffer) => {
        const chunk = stderrDecoder.write(data);
        if (chunk.length > 0) options.onStderr?.(chunk);
      });
    },
    result: exitCodeFromClose,
  });
}

/**
 * Close-promises of children whose shutdown the CLI must wait for when a
 * termination signal arrives. A bin signal handler that calls `process.exit`
 * within a microtask of the first Ctrl+C makes `execInherit`'s documented
 * SIGTERM → grace → SIGKILL escalation unreachable: the parent is gone
 * before the 1500 ms grace timer can fire, so a hung Firefox is orphaned
 * forever instead of being SIGKILLed and a healthy one loses its
 * AsyncShutdown flush window.
 */
const activeChildClosures = new Set<Promise<void>>();

/**
 * Registers a child with {@link waitForActiveChildShutdown}.
 *
 * Exported for the one legitimate spawn outside this module:
 * `core/marionette-preflight.ts` keeps its own `spawn` because it needs the
 * live `ChildProcess` mid-run, returns while the child is still running, and
 * aborts on a TCP byte rather than a deadline — none of which any wrapper
 * here can express. It still needs the shutdown contract, and a second
 * hand-rolled copy is what lets a Ctrl+C orphan the whole mach → Firefox
 * tree.
 */

/**
 * Registers a child whose shutdown {@link waitForActiveChildShutdown} must
 * wait for, and returns the handle that deregisters it.
 *
 * @returns `settle()` — call from both the child's `close` and `error`
 *   handlers so a dead child never holds the shutdown wait open
 */
export function trackChildClosure(): { settle: () => void } {
  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  activeChildClosures.add(closed);
  return {
    settle: (): void => {
      resolveClosed?.();
      activeChildClosures.delete(closed);
    },
  };
}

/**
 * Waits (bounded) for every tracked child process to close. Called by the
 * bin signal handler after forwarding SIGINT/SIGTERM, so the parent stays
 * alive long enough for the grace-then-SIGKILL escalation to actually run.
 * Resolves immediately when no children are active.
 */
export async function waitForActiveChildShutdown(timeoutMs: number): Promise<void> {
  if (activeChildClosures.size === 0) return;
  await Promise.race([
    Promise.allSettled([...activeChildClosures]),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref();
    }),
  ]);
}

/** Options for {@link execInherit}. */
export interface InheritOptions extends ExecOptions, ProcessGroupOptions {
  /** Grace period between the forwarded SIGTERM and the SIGKILL escalation (default 1500 ms). */
  shutdownGraceMs?: number;
}

/** Options for {@link execInheritCapture}: the inherit path plus output mirroring. */
export interface InheritCaptureOptions extends InheritOptions, MirrorOptions {}

/**
 * Executes a command and inherits stdio (shows output directly).
 *
 * Graceful shutdown: when the FireForge process receives SIGINT/SIGTERM, the
 * signal is forwarded to the child as SIGTERM and a short grace timer (default
 * 1500ms) runs before escalating to SIGKILL. A second matching signal during
 * the grace period triggers an immediate SIGKILL — matching the usual
 * "hit Ctrl-C again to force-quit" UX. Without this, Firefox's AsyncShutdown
 * / profileBeforeChange blockers (which flush in-memory state to disk) can be
 * racing the OS child-exit path, losing the last few seconds of edits.
 *
 * @param command - Command to execute
 * @param args - Command arguments
 * @param options - Execution options
 * @returns Exit code of the process
 */
export async function execInherit(
  command: string,
  args: string[],
  options: InheritOptions = {}
): Promise<number> {
  return spawnTracked({
    command,
    args,
    options,
    graceMs: options.shutdownGraceMs ?? 1500,
    forwardWithoutProcessGroup: true,
    spawnChild: (base) => spawn(command, args, { ...base, stdio: 'inherit' }),
    result: exitCodeFromClose,
  });
}

/**
 * Wires parent-process SIGINT/SIGTERM to a child: first signal → child.kill
 * (SIGTERM) + grace timer; second matching signal → immediate SIGKILL; grace
 * timer expiry → SIGKILL. Returns a `dispose()` that clears the listeners and
 * any outstanding timer. Callers must invoke `dispose()` from both the child's
 * `close` and `error` handlers so the process does not accumulate signal
 * listeners across repeated spawns.
 */
export function installGracefulShutdownForwarder(
  child: ReturnType<typeof spawn>,
  graceMs: number,
  killTarget?: (signal: NodeJS.Signals) => void
): { dispose: () => void } {
  let graceTimer: NodeJS.Timeout | undefined;
  const forwarded = new Set<NodeJS.Signals>();
  const sendKill = (signal: NodeJS.Signals): void => {
    if (killTarget) {
      killTarget(signal);
      return;
    }
    child.kill(signal);
  };

  const escalate = (): void => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      sendKill('SIGKILL');
    } catch {
      // Child is already gone — nothing to do.
    }
  };

  const handleSignal = (signal: NodeJS.Signals): void => {
    if (forwarded.has(signal)) {
      // Second receipt of the same signal while still running: escalate now.
      escalate();
      return;
    }
    forwarded.add(signal);
    try {
      sendKill('SIGTERM');
    } catch {
      // If the child can't accept SIGTERM (already dead), nothing to do.
      return;
    }
    graceTimer = setTimeout(escalate, graceMs);
    graceTimer.unref();
  };

  const onSigint = (): void => {
    handleSignal('SIGINT');
  };
  const onSigterm = (): void => {
    handleSignal('SIGTERM');
  };

  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  const dispose = (): void => {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = undefined;
    }
  };

  return { dispose };
}

/**
 * Executes a command while inheriting stdin, streaming stdout/stderr live,
 * and capturing the emitted output for diagnostics.
 * @param command - Command to execute
 * @param args - Command arguments
 * @param options - Execution options
 * @returns Execution result with stdout, stderr, and exit code
 */
export async function execInheritCapture(
  command: string,
  args: string[],
  options: InheritCaptureOptions = {}
): Promise<ExecResult> {
  const out = createStreamCollector(options.mirror?.stdout ?? process.stdout);
  const err = createStreamCollector(options.mirror?.stderr ?? process.stderr);
  return spawnTracked({
    command,
    args,
    options,
    graceMs: options.shutdownGraceMs ?? 1500,
    forwardWithoutProcessGroup: true,
    spawnChild: (base) => spawn(command, args, { ...base, stdio: ['inherit', 'pipe', 'pipe'] }),
    attach: (child) => {
      child.stdout.on('data', out.onData);
      child.stderr.on('data', err.onData);
    },
    result: (code, signal) => ({
      stdout: out.getText(),
      stderr: err.getText(),
      exitCode: exitCodeFromClose(code, signal),
      stdoutTruncated: out.wasTruncated(),
      stderrTruncated: err.wasTruncated(),
    }),
    rejectionOutput: () => collectedOutput(out, err),
  });
}

/** Per-line callback for smoke-run stream dispatch. */
export type SmokeLineCallback = (line: string) => void;

/**
 * Options for {@link execSmokeRun}.
 *
 * Deliberately omits `ExecOptions.timeout`: the smoke run's only deadline is
 * {@link SmokeRunOptions.smokeTimeoutMs}, which signals the whole process
 * group. Inheriting `timeout` is a leaky trap — accepted by the type but
 * silently ignored, so a caller setting it gets no deadline at all.
 *
 * {@link ProcessGroupOptions} is not mixed in for the same reason: a smoke
 * run is ALWAYS detached on POSIX (`usesProcessGroup` is derived from
 * `process.platform` alone), so the field would be accepted and never read.
 */
interface SmokeRunOptions extends Omit<ExecOptions, 'timeout'>, MirrorOptions {
  /**
   * Hard deadline in milliseconds. When it elapses the child process
   * group is sent SIGTERM and, after `killGraceMs`, SIGKILL. The returned
   * {@link SmokeRunResult.timedOut} is `true` when the deadline fires —
   * callers treat that as a clean smoke window (no child-driven error),
   * not a failure.
   */
  smokeTimeoutMs: number;
  /**
   * Grace period between SIGTERM and SIGKILL when the deadline fires.
   * Defaults to 10000 ms because Firefox's AsyncShutdown and
   * profileBeforeChange blockers can take ~5–10 s to flush in-memory
   * state. A shorter grace risks corrupting the dev profile mid-quit.
   */
  killGraceMs?: number;
  /** Invoked once per complete line of stdout. Final partial line is flushed on close. */
  onStdoutLine?: SmokeLineCallback;
  /** Invoked once per complete line of stderr. Final partial line is flushed on close. */
  onStderrLine?: SmokeLineCallback;
}

/** Result of {@link execSmokeRun}. */
export interface SmokeRunResult extends ExecResult {
  /**
   * `true` when the smoke deadline fired and we SIGTERMed the child
   * ourselves. Callers that want to distinguish "smoke window elapsed
   * cleanly" from "child exited on its own" check this flag — the
   * `exitCode` in the timedOut path is almost always 143 (SIGTERM) and
   * should NOT be treated as a child-driven failure.
   */
  timedOut: boolean;
}

/**
 * Spawns `command` with `args` in its own process group (POSIX), streams
 * stdout/stderr line-by-line to the caller, enforces a deadline by
 * SIGTERMing the whole group when it elapses, and returns the captured
 * output alongside a `timedOut` flag.
 *
 * Process-group semantics matter here because `mach run` execs a Python
 * wrapper that then forks Firefox, which itself spawns content processes.
 * Sending SIGTERM only to the Python PID leaves an orphan Firefox tree
 * behind. Running the child as a process-group leader (`detached: true`
 * on POSIX) and signalling `-pid` routes the kill to every descendant
 * that inherited the group.
 *
 * Windows fallback: `detached: true` does not create an equivalent group
 * there, so we kill the descendant tree with `taskkill /pid <pid> /T /F`
 * instead. taskkill has no graceful-signal equivalent — both the deadline
 * and the grace re-invocation are forced kills, so Windows children get
 * no shutdown window (best-effort; Windows is untested, see README).
 * `child.kill()` is still sent as a direct-child fallback in case
 * taskkill itself is unavailable.
 */
export async function execSmokeRun(
  command: string,
  args: string[],
  options: SmokeRunOptions
): Promise<SmokeRunResult> {
  return new Promise((resolve, reject) => {
    const usesProcessGroup = process.platform !== 'win32';

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: buildChildEnv(options),
      stdio: ['ignore', 'pipe', 'pipe'],
      // A new process group on POSIX lets us signal the whole descendant
      // tree at once, which is essential for mach → python → firefox →
      // content-process chains. On Windows spawn ignores this for our
      // purposes and we fall back to a taskkill /T tree kill below.
      detached: usesProcessGroup,
    });

    const out = createStreamCollector(options.mirror?.stdout);
    const err = createStreamCollector(options.mirror?.stderr);

    const stdoutLineDecoder = new StringDecoder('utf8');
    const stderrLineDecoder = new StringDecoder('utf8');
    let stdoutBuffer = '';
    let stderrBuffer = '';

    child.stdout.on('data', (data: Buffer) => {
      out.onData(data);
      stdoutBuffer += stdoutLineDecoder.write(data);
      stdoutBuffer = dispatchCompleteLines(stdoutBuffer, options.onStdoutLine);
    });

    child.stderr.on('data', (data: Buffer) => {
      err.onData(data);
      stderrBuffer += stderrLineDecoder.write(data);
      stderrBuffer = dispatchCompleteLines(stderrBuffer, options.onStderrLine);
    });

    let timedOut = false;
    let graceTimer: NodeJS.Timeout | undefined;
    let signalGraceTimer: NodeJS.Timeout | undefined;

    const signalChildGroup = (signal: NodeJS.Signals): void => {
      killProcessTree(child, signal, usesProcessGroup);
    };

    const deadlineTimer = setTimeout(() => {
      timedOut = true;
      signalChildGroup('SIGTERM');
      graceTimer = setTimeout(() => {
        signalChildGroup('SIGKILL');
      }, options.killGraceMs ?? 10000);
      graceTimer.unref();
    }, options.smokeTimeoutMs);
    deadlineTimer.unref();

    // Forward parent SIGINT/SIGTERM to the whole child process group. The
    // smoke child is a group leader (detached), so it does NOT receive the
    // terminal's Ctrl+C SIGINT — without this forwarder, the parent exits
    // and the entire mach → firefox tree is orphaned. Second signal (or
    // grace expiry) escalates to a group SIGKILL.
    const forwardedSignals = new Set<NodeJS.Signals>();
    const onParentSignal = (signal: NodeJS.Signals): void => {
      if (forwardedSignals.has(signal)) {
        signalChildGroup('SIGKILL');
        return;
      }
      forwardedSignals.add(signal);
      signalChildGroup('SIGTERM');
      signalGraceTimer = setTimeout(() => {
        signalChildGroup('SIGKILL');
      }, options.killGraceMs ?? 10000);
      signalGraceTimer.unref();
    };
    const onSigint = (): void => {
      onParentSignal('SIGINT');
    };
    const onSigterm = (): void => {
      onParentSignal('SIGTERM');
    };
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);

    const closure = trackChildClosure();
    const cleanupSignalForwarding = (): void => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      if (signalGraceTimer) clearTimeout(signalGraceTimer);
      closure.settle();
    };

    child.on('error', (error) => {
      clearTimeout(deadlineTimer);
      if (graceTimer) clearTimeout(graceTimer);
      cleanupSignalForwarding();
      reject(error);
    });

    child.on('close', (code, signal) => {
      clearTimeout(deadlineTimer);
      if (graceTimer) clearTimeout(graceTimer);
      cleanupSignalForwarding();

      // Flush any remaining partial line (child ended without a trailing newline).
      if (stdoutBuffer.length > 0) options.onStdoutLine?.(stdoutBuffer);
      if (stderrBuffer.length > 0) options.onStderrLine?.(stderrBuffer);

      resolve({
        stdout: out.getText(),
        stderr: err.getText(),
        exitCode: exitCodeFromClose(code, signal),
        stdoutTruncated: out.wasTruncated(),
        stderrTruncated: err.wasTruncated(),
        timedOut,
      });
    });
  });
}

/**
 * Finds an executable in the system PATH.
 * @param name - Name of the executable
 * @returns Full path to the executable, or undefined if not found
 */
export async function findExecutable(name: string): Promise<string | undefined> {
  const command = process.platform === 'win32' ? 'where' : 'which';
  try {
    const result = await exec(command, [name]);
    if (result.exitCode === 0 && result.stdout.trim()) {
      // Return the first line (first match)
      return result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Checks if an executable exists in the system PATH.
 * @param name - Name of the executable
 * @returns True if the executable exists
 */
export async function executableExists(name: string): Promise<boolean> {
  const path = await findExecutable(name);
  return path !== undefined;
}
