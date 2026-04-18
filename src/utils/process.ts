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
      return result.stdout.trim().split('\n')[0];
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
