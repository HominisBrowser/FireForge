// SPDX-License-Identifier: EUPL-1.2
import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { StringDecoder } from 'node:string_decoder';

import { ExecTimeoutError } from '../errors/base.js';
import { buildChildEnv } from './child-env.js';
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
 * Options for command execution.
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
  /**
   * Streams to mirror the child's output into, replacing the default
   * `process.stdout` / `process.stderr` on the stdio-inheriting capture
   * path. Lets a caller tee the live output somewhere else (a run log)
   * without a second per-chunk hook.
   */
  mirror?: { stdout?: NodeJS.WritableStream; stderr?: NodeJS.WritableStream };
  /** Timeout in milliseconds */
  timeout?: number;
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
  timeout: number | undefined
): Error {
  if (timeout !== undefined && error.name === 'AbortError') {
    return new ExecTimeoutError(command, args, timeout, error);
  }
  return error;
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
      reject(toExecRejection(error, command, args, options.timeout));
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
export type StreamCallback = (data: string) => void;

/**
 * Options for streaming command execution.
 */
export interface StreamOptions extends ExecOptions {
  /** Callback for stdout data */
  onStdout?: StreamCallback;
  /** Callback for stderr data */
  onStderr?: StreamCallback;
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
  return new Promise((resolve, reject) => {
    const usesProcessGroup = options.processGroup === true && process.platform !== 'win32';
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: buildChildEnv(options),
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: buildSignalFromTimeout(options.timeout),
      detached: usesProcessGroup,
    });
    const groupPid = usesProcessGroup ? child.pid : undefined;

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

    // A detached group leader no longer receives the terminal's Ctrl+C, so
    // the forwarder is mandatory (not just graceful-UX) when processGroup
    // is set. Group-aware: kills route to the whole tree.
    const forwarder =
      options.processGroup === true
        ? installGracefulShutdownForwarder(child, 1500, (signal) => {
            killProcessTree(child, signal, usesProcessGroup);
          })
        : undefined;

    // Closure tracking: this was the one wrapper that omitted it, so the bin
    // signal handler did not wait for `runMachStream`'s children on Ctrl+C
    // and the forwarder's SIGTERM → grace → SIGKILL escalation above could
    // not finish before the parent exited — the exact failure the tracking
    // set was introduced to fix, left unwired here.
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
      reject(toExecRejection(error, command, args, options.timeout));
    });

    child.on('close', (code, signal) => {
      forwarder?.dispose();
      const finish = (): void => {
        closure.settle();
        resolve(exitCodeFromClose(code, signal));
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
  options: ExecOptions & { shutdownGraceMs?: number } = {}
): Promise<number> {
  return new Promise((resolve, reject) => {
    const usesProcessGroup = options.processGroup === true && process.platform !== 'win32';
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: buildChildEnv(options),
      stdio: 'inherit',
      signal: buildSignalFromTimeout(options.timeout),
      detached: usesProcessGroup,
    });
    const groupPid = usesProcessGroup ? child.pid : undefined;

    const graceMs = options.shutdownGraceMs ?? 1500;
    const { dispose } = installGracefulShutdownForwarder(
      child,
      graceMs,
      options.processGroup === true
        ? (signal) => {
            killProcessTree(child, signal, usesProcessGroup);
          }
        : undefined
    );
    const closure = trackChildClosure();

    child.on('error', (error) => {
      if (options.processGroup === true) {
        killProcessTree(child, 'SIGKILL', usesProcessGroup);
      }
      dispose();
      closure.settle();
      reject(toExecRejection(error, command, args, options.timeout));
    });

    child.on('close', (code, signal) => {
      dispose();
      const finish = (): void => {
        closure.settle();
        resolve(exitCodeFromClose(code, signal));
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
  options: ExecOptions & { shutdownGraceMs?: number } = {}
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const usesProcessGroup = options.processGroup === true && process.platform !== 'win32';
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: buildChildEnv(options),
      stdio: ['inherit', 'pipe', 'pipe'],
      signal: buildSignalFromTimeout(options.timeout),
      detached: usesProcessGroup,
    });
    const groupPid = usesProcessGroup ? child.pid : undefined;

    const out = createStreamCollector(options.mirror?.stdout ?? process.stdout);
    const err = createStreamCollector(options.mirror?.stderr ?? process.stderr);
    child.stdout.on('data', out.onData);
    child.stderr.on('data', err.onData);

    const graceMs = options.shutdownGraceMs ?? 1500;
    const { dispose } = installGracefulShutdownForwarder(
      child,
      graceMs,
      options.processGroup === true
        ? (signal) => {
            killProcessTree(child, signal, usesProcessGroup);
          }
        : undefined
    );
    const closure = trackChildClosure();

    child.on('error', (error) => {
      if (options.processGroup === true) {
        killProcessTree(child, 'SIGKILL', usesProcessGroup);
      }
      dispose();
      closure.settle();
      reject(toExecRejection(error, command, args, options.timeout));
    });

    child.on('close', (code, signal) => {
      dispose();
      const finish = (): void => {
        closure.settle();
        resolve({
          stdout: out.getText(),
          stderr: err.getText(),
          exitCode: exitCodeFromClose(code, signal),
          stdoutTruncated: out.wasTruncated(),
          stderrTruncated: err.wasTruncated(),
        });
      };
      if (groupPid !== undefined) {
        sweepProcessGroup(groupPid).then(finish, finish);
      } else {
        finish();
      }
    });
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
 * `processGroup` is omitted for the same reason: a smoke run is ALWAYS
 * detached on POSIX (`usesProcessGroup` is derived from `process.platform`
 * alone), so the field would be accepted and never read.
 */
export interface SmokeRunOptions extends Omit<ExecOptions, 'processGroup' | 'timeout'> {
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
  /**
   * Optional writable stream to mirror captured output to (e.g. an
   * operator-supplied `--capture-console` file). Writes happen inline
   * with line dispatch and the stream is NOT closed here — the caller
   * owns its lifecycle.
   */
  mirror?: { stdout?: NodeJS.WritableStream; stderr?: NodeJS.WritableStream };
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
 * Cap on the partial-line tail kept between chunks. A child emitting one
 * enormous line with no terminator (minified JS dumped to stderr, a raw
 * binary blob) would otherwise grow the buffer without bound — the 50 MB cap
 * guards the collector, not these line buffers. When the tail exceeds the
 * cap it is dispatched as a synthetic (oversized) line so the matchers still
 * see its content, then the buffer resets.
 */
const MAX_PARTIAL_LINE_SIZE = 1024 * 1024;

/**
 * Drains complete lines from `buffer`, dispatching each to `cb`. Treats
 * `\n`, `\r\n`, and lone `\r` as line terminators — the lone-`\r` case
 * matters for progress-bar style output (mach, cargo) that repaints a line
 * with carriage returns and never sends a newline, which otherwise
 * accumulates indefinitely. A single trailing `\r` is held back since it may
 * be the first half of a `\r\n` pair split across chunks. Returns the
 * remaining partial line — callers keep accumulating into it.
 */
function dispatchCompleteLines(buffer: string, cb: SmokeLineCallback | undefined): string {
  let searchFrom = 0;
  for (;;) {
    const nl = buffer.indexOf('\n', searchFrom);
    const cr = buffer.indexOf('\r', searchFrom);
    const idx = nl === -1 ? cr : cr === -1 ? nl : Math.min(nl, cr);
    if (idx === -1) break;
    if (buffer[idx] === '\r' && idx === buffer.length - 1) {
      // Possible first half of a chunk-split \r\n — wait for the next chunk.
      break;
    }
    const line = buffer.slice(0, idx);
    const terminatorLength = buffer[idx] === '\r' && buffer[idx + 1] === '\n' ? 2 : 1;
    buffer = buffer.slice(idx + terminatorLength);
    searchFrom = 0;
    cb?.(line);
  }
  if (buffer.length > MAX_PARTIAL_LINE_SIZE) {
    cb?.(buffer);
    return '';
  }
  return buffer;
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
  } catch (error: unknown) {
    void error;
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
