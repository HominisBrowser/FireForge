// SPDX-License-Identifier: EUPL-1.2
import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';

// 50 MB cap per stream to prevent OOM — large toolchain builds (e.g. Firefox, Chromium)
// can easily blow past this, so we truncate rather than let the buffer grow unbounded.
const MAX_OUTPUT_SIZE = 50 * 1024 * 1024;

function createStreamCollector(mirror?: NodeJS.WritableStream): {
  onData: (data: Buffer) => void;
  getText: () => string;
} {
  const chunks: string[] = [];
  let totalLength = 0;
  let truncated = false;
  return {
    onData: (data: Buffer) => {
      const chunk = data.toString();
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
}

/**
 * Options for command execution.
 */
export interface ExecOptions {
  /** Working directory for the command */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Timeout in milliseconds */
  timeout?: number;
}

function buildSignalFromTimeout(timeout: number | undefined): AbortSignal | undefined {
  if (timeout === undefined) return undefined;
  return AbortSignal.timeout(timeout);
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
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: buildSignalFromTimeout(options.timeout),
    });

    const out = createStreamCollector();
    const err = createStreamCollector();
    child.stdout.on('data', out.onData);
    child.stderr.on('data', err.onData);

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code, signal) => {
      resolve({
        stdout: out.getText(),
        stderr: err.getText(),
        exitCode: exitCodeFromClose(code, signal),
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
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: buildSignalFromTimeout(options.timeout),
    });

    child.stdout.on('data', (data: Buffer) => {
      options.onStdout?.(data.toString());
    });

    child.stderr.on('data', (data: Buffer) => {
      options.onStderr?.(data.toString());
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code, signal) => {
      resolve(exitCodeFromClose(code, signal));
    });
  });
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
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: 'inherit',
      signal: buildSignalFromTimeout(options.timeout),
    });

    const graceMs = options.shutdownGraceMs ?? 1500;
    const { dispose } = installGracefulShutdownForwarder(child, graceMs);

    child.on('error', (error) => {
      dispose();
      reject(error);
    });

    child.on('close', (code, signal) => {
      dispose();
      resolve(exitCodeFromClose(code, signal));
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
function installGracefulShutdownForwarder(
  child: ReturnType<typeof spawn>,
  graceMs: number
): { dispose: () => void } {
  let graceTimer: NodeJS.Timeout | undefined;
  const forwarded = new Set<NodeJS.Signals>();

  const escalate = (): void => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill('SIGKILL');
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
      child.kill('SIGTERM');
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
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['inherit', 'pipe', 'pipe'],
      signal: buildSignalFromTimeout(options.timeout),
    });

    const out = createStreamCollector(process.stdout);
    const err = createStreamCollector(process.stderr);
    child.stdout.on('data', out.onData);
    child.stderr.on('data', err.onData);

    const graceMs = options.shutdownGraceMs ?? 1500;
    const { dispose } = installGracefulShutdownForwarder(child, graceMs);

    child.on('error', (error) => {
      dispose();
      reject(error);
    });

    child.on('close', (code, signal) => {
      dispose();
      resolve({
        stdout: out.getText(),
        stderr: err.getText(),
        exitCode: exitCodeFromClose(code, signal),
      });
    });
  });
}

/** Per-line callback for smoke-run stream dispatch. */
export type SmokeLineCallback = (line: string) => void;

/** Options for {@link execSmokeRun}. */
export interface SmokeRunOptions extends ExecOptions {
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
 * there, so we degrade to `child.kill()` and log a best-effort warning
 * via the `onStderrLine` callback if the caller wired one.
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
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      // A new process group on POSIX lets us signal the whole descendant
      // tree at once, which is essential for mach → python → firefox →
      // content-process chains. On Windows spawn ignores this for our
      // purposes and we fall back to child.kill below.
      detached: usesProcessGroup,
    });

    const out = createStreamCollector(options.mirror?.stdout);
    const err = createStreamCollector(options.mirror?.stderr);

    let stdoutBuffer = '';
    let stderrBuffer = '';

    child.stdout.on('data', (data: Buffer) => {
      out.onData(data);
      stdoutBuffer += data.toString();
      stdoutBuffer = dispatchCompleteLines(stdoutBuffer, options.onStdoutLine);
    });

    child.stderr.on('data', (data: Buffer) => {
      err.onData(data);
      stderrBuffer += data.toString();
      stderrBuffer = dispatchCompleteLines(stderrBuffer, options.onStderrLine);
    });

    let timedOut = false;
    let graceTimer: NodeJS.Timeout | undefined;

    const signalChildGroup = (signal: NodeJS.Signals): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const targetPid = child.pid;
      if (targetPid === undefined) return;
      try {
        if (usesProcessGroup) {
          // Negative PID routes to the process group, killing the Python
          // wrapper, the firefox it forked, and every content process
          // that inherited the group.
          process.kill(-targetPid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        // Already gone. Nothing to do.
      }
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

    child.on('error', (error) => {
      clearTimeout(deadlineTimer);
      if (graceTimer) clearTimeout(graceTimer);
      reject(error);
    });

    child.on('close', (code, signal) => {
      clearTimeout(deadlineTimer);
      if (graceTimer) clearTimeout(graceTimer);

      // Flush any remaining partial line (child ended without a trailing newline).
      if (stdoutBuffer.length > 0) options.onStdoutLine?.(stdoutBuffer);
      if (stderrBuffer.length > 0) options.onStderrLine?.(stderrBuffer);

      resolve({
        stdout: out.getText(),
        stderr: err.getText(),
        exitCode: exitCodeFromClose(code, signal),
        timedOut,
      });
    });
  });
}

/**
 * Drains complete newline-terminated lines from `buffer`, dispatching each
 * trimmed-of-newline line to `cb`. Returns the remaining partial line that
 * has not yet been terminated — callers should keep accumulating into it.
 */
function dispatchCompleteLines(buffer: string, cb: SmokeLineCallback | undefined): string {
  if (!cb) {
    // No listener — still need to collapse accumulated newlines so the
    // buffer does not grow forever. Keep only the partial-line tail.
    const lastNewline = buffer.lastIndexOf('\n');
    if (lastNewline === -1) return buffer;
    return buffer.slice(lastNewline + 1);
  }
  let idx: number;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).replace(/\r$/, '');
    buffer = buffer.slice(idx + 1);
    cb(line);
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
