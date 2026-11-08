// SPDX-License-Identifier: EUPL-1.2
import { type ChildProcess, spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { StringDecoder } from 'node:string_decoder';

import { ExecTimeoutError, type ExecTimeoutOutput } from '../errors/base.js';
import { buildChildEnv } from './child-env.js';
import { signalDirectChild } from './child-process.js';
import { toError } from './errors.js';
import { dispatchCompleteLines } from './line-dispatch.js';
import type { ProcessOwnership } from './process-group.js';
import { trackChildLifetime } from './process-lifecycle.js';

// 50 MB cap per stream to prevent OOM. Large toolchain builds (e.g. Firefox, Chromium)
// can easily blow past this, so we truncate rather than let the buffer grow unbounded.
// Callers for whom truncation is unacceptable (e.g. the archive-safety preflight
// scanning a full `tar -tvf` listing) must check `wasTruncated` and fail hard.
const MAX_OUTPUT_SIZE = 50 * 1024 * 1024;

/** Default grace between SIGTERM and the SIGKILL escalation. */
const DEFAULT_GRACE_MS = 1500;

function createStreamCollector(mirror?: NodeJS.WritableStream): {
  onData: (data: Buffer) => void;
  getText: () => string;
  wasTruncated: () => boolean;
} {
  const chunks: string[] = [];
  let totalLength = 0;
  let truncated = false;
  // A per-stream StringDecoder keeps multibyte UTF-8 characters split across
  // pipe chunk boundaries intact. Per-chunk `Buffer.toString()` would turn a
  // straddling character into two U+FFFD replacement chars, which breaks regex
  // matching over captured output (smoke-run allowlists, mach error hints).
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
   * existing mocks stay valid. Absent means "not truncated". Callers that
   * feed the output into safety decisions (e.g. archive-listing scans) must
   * treat `true` as a hard failure, since a truncated listing otherwise
   * looks exactly like a complete one.
   */
  stdoutTruncated?: boolean;
  /** True when `stderr` was cut off at the 50 MB collector cap. See {@link ExecResult.stdoutTruncated}. */
  stderrTruncated?: boolean;
  /**
   * True when a background process still held the output pipes after the
   * command exited, so output written after that point was not collected. The
   * exit code stands. Absent otherwise.
   */
  pipesHeld?: true;
}

/**
 * Options for plain `exec()`, the pipe-capturing, non-grouped, non-mirrored
 * path. The other wrappers extend this with the fields they actually read:
 * `processGroup` lives in {@link ProcessGroupOptions}, `mirror` in
 * {@link MirrorOptions}. Neither belongs here because `exec()` reads
 * neither, and a field the type accepts but the function ignores is a trap
 * (the caller believes it got a process group, and never did).
 */
export interface ExecOptions {
  /** Working directory for the command */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /**
   * Environment variables to remove from the child's inherited environment,
   * applied after {@link ExecOptions.env} is merged over `process.env`.
   *
   * Needed because `env` can only add or overwrite, and some variables are
   * read only for their presence: mozbuild's `is_running_under_coding_agent()`
   * keys on `CLAUDECODE`, so setting it empty would not unset it. An
   * explicit delete says what it means. Relying on Node dropping
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
   * the stream is not closed here. The caller owns its lifecycle.
   */
  mirror?: { stdout?: NodeJS.WritableStream; stderr?: NodeJS.WritableStream };
}

/**
 * Process-group reaping for the long-lived wrappers ({@link execStream},
 * {@link execInherit}, {@link execInheritCapture}).
 */
export interface ProcessGroupOptions {
  /**
   * POSIX: spawn the child as a process-group leader, route every signal
   * (parent-signal forwarding, timeout, escalation) to the whole group, and
   * after the leader exits terminate what remains of its owned tree, so a
   * harness that dies at startup cannot strand spinning `multiprocessing`
   * workers. Windows: signals reach the direct child only; descendants are not
   * tracked. Default false, so non-mach consumers are unaffected.
   *
   * NOTE for callers: a detached group leader does not receive terminal
   * Ctrl+C. The exec layer installs its own group-aware signal forwarder
   * whenever this option is set.
   */
  processGroup?: boolean;
  /**
   * Receives the process-group id (the detached child's pid) right after a
   * group-leader spawn. Lets a caller expose the group to a supervisor that
   * cannot signal FireForge itself gracefully (`fireforge test --pgid-file`),
   * or hold it for a teardown of its own. Not called when no group was
   * created (`processGroup` unset, or win32).
   */
  onProcessGroup?: (pgid: number, ownership?: ProcessOwnership) => void;
  /**
   * Extra teardown the caller owns, awaited (for at most five seconds) after
   * the tree's teardown, before the child's closure settles. Placed here
   * rather than after the wrapper resolves so the bin signal handler's
   * `waitForActiveChildShutdown` covers it too: a reap that ran after the
   * wrapper resolved would race `process.exit` on a forwarded SIGTERM. A
   * failure or overrun is reported as inconclusive cleanup and leaves the
   * child's result as it was.
   */
  postCloseSweep?: () => Promise<void>;
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
 * Snapshot of what two collectors hold, for carrying onto a timeout rejection:
 * the partial stdout and stderr say what the command was doing when it died.
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

/** Builds the result of a capturing wrapper from its two collectors. */
function collectedResult(
  out: ReturnType<typeof createStreamCollector>,
  err: ReturnType<typeof createStreamCollector>,
  code: number | null,
  signal: NodeJS.Signals | null,
  pipesHeld: boolean
): ExecResult {
  return {
    stdout: out.getText(),
    stderr: err.getText(),
    exitCode: exitCodeFromClose(code, signal),
    stdoutTruncated: out.wasTruncated(),
    stderrTruncated: err.wasTruncated(),
    ...(pipesHeld ? { pipesHeld: true as const } : {}),
  };
}

/** A child's exit code, with a signal death mapped to 128 + its number. */
export function exitCodeFromClose(code: number | null, signal: NodeJS.Signals | null): number {
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
  const out = createStreamCollector();
  const err = createStreamCollector();
  return spawnTracked({
    command,
    args,
    options,
    graceMs: DEFAULT_GRACE_MS,
    forwardWithoutProcessGroup: false,
    spawnChild: (base) => spawn(command, args, { ...base, stdio: ['ignore', 'pipe', 'pipe'] }),
    attach: (child) => {
      child.stdout.on('data', out.onData);
      child.stderr.on('data', err.onData);
    },
    result: (code, signal, pipesHeld) => collectedResult(out, err, code, signal, pipesHeld),
    rejectionOutput: () => collectedOutput(out, err),
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
  shutdownGraceMs?: number;
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
  /** Caller options. Only `cwd`, `timeout` and `processGroup` are read here. */
  options: ExecOptions & ProcessGroupOptions;
  /** Grace between the forwarded SIGTERM and the SIGKILL escalation. */
  graceMs: number;
  /**
   * Whether a child that is not a process-group leader still gets the
   * shutdown forwarder. A detached leader always gets one, because it no
   * longer receives the terminal's Ctrl+C, so forwarding keeps it killable.
   */
  forwardWithoutProcessGroup: boolean;
  /** Performs the spawn, adding the variant's `stdio` to the shared base. */
  spawnChild: (base: TrackedSpawnBase) => C;
  /** Wires stream handlers, before any exit handler can fire. */
  attach?: (child: C) => void;
  /** Starts the variant's own timers, returning what stops them. */
  setup?: (signal: (value: NodeJS.Signals) => void) => () => void;
  /** Builds the resolved value from how the child ended. */
  result: (code: number | null, signal: NodeJS.Signals | null, pipesHeld: boolean) => T;
  /** Partial output to carry onto a timeout rejection, when the variant captures any. */
  rejectionOutput?: () => ExecTimeoutOutput;
}

/**
 * The shared body of every spawn wrapper: detach decision, shutdown forwarding
 * when the variant wants it, closure tracking, tree teardown and typed timeout
 * rejection. Every wrapper goes through here, so the bin signal handler's
 * shutdown wait covers all of them.
 *
 * @param spec - The variant's stdio, stream wiring, grace budget and result shape
 * @returns Whatever `spec.result` builds from how the child ended
 */
async function spawnTracked<C extends ChildProcess, T>(spec: TrackedSpawnSpec<C, T>): Promise<T> {
  const { command, args, options } = spec;
  const usesProcessGroup = options.processGroup === true && process.platform !== 'win32';
  const child = spec.spawnChild({
    cwd: options.cwd,
    env: buildChildEnv(options),
    signal: buildSignalFromTimeout(options.timeout),
    detached: usesProcessGroup,
  });
  const closure = trackChildClosure();
  const lifetime = trackChildLifetime(child, {
    processGroup: usesProcessGroup,
    graceMs: spec.graceMs,
    ...(options.postCloseSweep ? { postCloseSweep: options.postCloseSweep } : {}),
  });
  let forwarder: { dispose: () => void } | undefined;
  let disposeSetup: (() => void) | undefined;
  let waiting = false;
  try {
    spec.attach?.(child);
    if (usesProcessGroup && child.pid !== undefined) {
      options.onProcessGroup?.(child.pid, lifetime.owner);
    }
    if (spec.forwardWithoutProcessGroup || options.processGroup === true) {
      forwarder = installGracefulShutdownForwarder(child, spec.graceMs, lifetime.signal);
    }
    disposeSetup = spec.setup?.(lifetime.signal);
    waiting = true;
    const { code, signal, pipesHeld } = await lifetime.completion;
    return spec.result(code, signal, pipesHeld);
  } catch (error) {
    if (!waiting) {
      // The wiring itself failed, so nothing else will ever end this child.
      lifetime.signal('SIGKILL');
      await lifetime.completion.catch(() => undefined);
    }
    throw toExecRejection(toError(error), command, args, options.timeout, spec.rejectionOutput?.());
  } finally {
    forwarder?.dispose();
    disposeSetup?.();
    closure.settle();
  }
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
    graceMs: options.shutdownGraceMs ?? DEFAULT_GRACE_MS,
    // A detached group leader does not receive the terminal's Ctrl+C, so
    // the forwarder is mandatory (not just graceful-UX) when processGroup
    // is set. A plain streamed child does not get one.
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
 * Registers a child whose shutdown {@link waitForActiveChildShutdown} must
 * wait for, and returns the handle that deregisters it. Exported for spawns
 * outside this module that still owe the shutdown contract.
 *
 * @returns `settle()`. Call after child closure and required teardown finish.
 *   An abort's `error` event does not prove closure; do not settle there.
 *   A failed start may settle when no live child or teardown remains.
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
 * the grace period triggers an immediate SIGKILL, matching the usual
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
    graceMs: options.shutdownGraceMs ?? DEFAULT_GRACE_MS,
    forwardWithoutProcessGroup: true,
    spawnChild: (base) => spawn(command, args, { ...base, stdio: 'inherit' }),
    result: exitCodeFromClose,
  });
}

/**
 * Wires parent-process SIGINT/SIGTERM to a child: first signal → child.kill
 * (SIGTERM) + grace timer. A second matching signal → immediate SIGKILL.
 * Grace timer expiry → SIGKILL. Returns a `dispose()` that clears the
 * listeners and any outstanding timer. Callers must invoke `dispose()` once the
 * child has been followed to its end, so the process does not accumulate signal
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
    signalDirectChild(child, signal);
  };

  const escalate = (): void => {
    if (!killTarget && (child.exitCode !== null || child.signalCode !== null)) return;
    try {
      sendKill('SIGKILL');
    } catch {
      // Child is already gone, nothing to do.
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
    graceMs: options.shutdownGraceMs ?? DEFAULT_GRACE_MS,
    forwardWithoutProcessGroup: true,
    spawnChild: (base) => spawn(command, args, { ...base, stdio: ['inherit', 'pipe', 'pipe'] }),
    attach: (child) => {
      child.stdout.on('data', out.onData);
      child.stderr.on('data', err.onData);
    },
    result: (code, signal, pipesHeld) => collectedResult(out, err, code, signal, pipesHeld),
    rejectionOutput: () => collectedOutput(out, err),
  });
}

/** Per-line callback for smoke-run stream dispatch. */
export type SmokeLineCallback = (line: string) => void;

/**
 * Options for {@link execSmokeRun}.
 *
 * Omits `ExecOptions.timeout`: the smoke run's only deadline is
 * {@link SmokeRunOptions.smokeTimeoutMs}, which signals the whole process
 * group. Inheriting `timeout` would be a leaky trap, accepted by the type
 * but silently ignored, so a caller setting it gets no deadline at all.
 *
 * {@link ProcessGroupOptions} is not mixed in for the same reason: a smoke
 * run is always detached on POSIX (`usesProcessGroup` is derived from
 * `process.platform` alone), so the field would be accepted and never read.
 */
interface SmokeRunOptions extends Omit<ExecOptions, 'timeout'>, MirrorOptions {
  /**
   * Hard deadline in milliseconds. When it elapses the child process
   * group is sent SIGTERM and, after `killGraceMs`, SIGKILL. The returned
   * {@link SmokeRunResult.timedOut} is `true` when the deadline fires.
   * Callers treat that as a clean smoke window (no child-driven error)
   * rather than a failure.
   */
  smokeTimeoutMs: number;
  /**
   * Grace period between SIGTERM and SIGKILL when the deadline fires.
   * Defaults to 10000 ms because Firefox's AsyncShutdown and
   * profileBeforeChange blockers can take roughly 5 to 10 s to flush in-memory
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
   * cleanly" from "child exited on its own" check this flag: the
   * `exitCode` in the timedOut path is almost always 143 (SIGTERM) and
   * should not be treated as a child-driven failure.
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
 * Windows has no equivalent group: signals reach the direct child only, so
 * descendants of the Python wrapper can survive. Windows is untested, see
 * README.
 */
export async function execSmokeRun(
  command: string,
  args: string[],
  options: SmokeRunOptions
): Promise<SmokeRunResult> {
  const out = createStreamCollector(options.mirror?.stdout);
  const err = createStreamCollector(options.mirror?.stderr);
  const stdoutLineDecoder = new StringDecoder('utf8');
  const stderrLineDecoder = new StringDecoder('utf8');
  let stdoutBuffer = '';
  let stderrBuffer = '';
  let timedOut = false;
  const graceMs = options.killGraceMs ?? 10000;
  return spawnTracked({
    command,
    args,
    options: { ...options, processGroup: true },
    graceMs,
    forwardWithoutProcessGroup: true,
    spawnChild: (base) => spawn(command, args, { ...base, stdio: ['ignore', 'pipe', 'pipe'] }),
    attach: (child) => {
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
    },
    setup: (signal) => {
      let graceTimer: NodeJS.Timeout | undefined;
      const deadline = setTimeout(() => {
        timedOut = true;
        signal('SIGTERM');
        graceTimer = setTimeout(() => {
          signal('SIGKILL');
        }, graceMs);
        graceTimer.unref();
      }, options.smokeTimeoutMs);
      deadline.unref();
      return () => {
        clearTimeout(deadline);
        if (graceTimer) clearTimeout(graceTimer);
      };
    },
    result: (code, signal, pipesHeld) => {
      if (stdoutBuffer) options.onStdoutLine?.(stdoutBuffer);
      if (stderrBuffer) options.onStderrLine?.(stderrBuffer);
      return { ...collectedResult(out, err, code, signal, pipesHeld), timedOut };
    },
    rejectionOutput: () => collectedOutput(out, err),
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
