// SPDX-License-Identifier: EUPL-1.2
/**
 * Running other programs. Every child goes through {@link run} (or
 * {@link runBytes}), so each one is known to the interrupt pipeline: a signal
 * is forwarded where the child would not get it by itself, and the process
 * does not exit while a child's teardown is still running.
 *
 * Arguments are an argv array, never a shell string.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import { delimiter, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { errnoCode, ExitCode, FireForgeError, toError } from '../errors.js';
import { verbose, warn } from '../log.js';
import { onForceExit, onShutdown } from '../signals.js';
import { lineSplitter, tailLines } from '../text.js';
import { settlesWithin } from '../time.js';
import {
  ownProcessTree,
  type ProcessOwnership,
  type ProcessTeardown,
  signalChild,
} from './tree.js';

/**
 * Cap on each captured stream. Past it the capture is cut and marked, so a
 * runaway build cannot exhaust memory. Mirrors and callbacks still see everything.
 */
const MAX_CAPTURE = 50 * 1024 * 1024;
/** Default grace between SIGTERM and SIGKILL. */
const DEFAULT_GRACE_MS = 1_500;
/** How long after exit the output pipes get to close before they are abandoned. */
const PIPE_DRAIN_MS = 1_000;
/** Upper bound on a caller's `afterExit`. */
const AFTER_EXIT_LIMIT_MS = 5_000;
/** How long an interrupt waits for children at least, whatever their grace. */
const SHUTDOWN_WAIT_MS = 12_000;

/** How a child is run. */
export interface RunOptions {
  cwd?: string;
  /** Merged over this process's environment. An `undefined` value removes the variable. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Written to the child's stdin, which is then closed. */
  input?: string | Uint8Array;
  /**
   * Where the child's output goes:
   *  - `capture` (default): collected into the result, shown nowhere.
   *  - `tee`: collected, and written live to this process's stdout and stderr
   *    (or to `mirror`). stdin is inherited.
   *  - `inherit`: the child owns the terminal; nothing is collected.
   */
  output?: 'capture' | 'tee' | 'inherit';
  /** Streams that receive the output as it arrives, replacing the `tee` defaults. */
  mirror?: { stdout?: NodeJS.WritableStream; stderr?: NodeJS.WritableStream };
  /** Receives each complete output line (`\n`, `\r\n` or a lone `\r` ends one). */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  /**
   * Deadline in milliseconds. When it passes the child gets SIGTERM, then
   * SIGKILL after `graceMs`, and `run` rejects with `command-timeout`.
   */
  timeoutMs?: number;
  /** Resolve with `timedOut: true` instead of rejecting when the deadline passes. */
  timeoutIsResult?: boolean;
  /** Grace between SIGTERM and SIGKILL, for a timeout and for an interrupt (default 1500). */
  graceMs?: number;
  /**
   * Run the child as the leader of its own process group, signal the whole
   * group, and after the leader exits terminate what remains of its tree.
   * For programs that fork helpers (mach, the browser). No effect on Windows.
   */
  processGroup?: boolean;
  /** Called right after a process-group spawn with the authority over that tree. */
  onProcessGroup?: (owner: ProcessOwnership) => void;
  /**
   * Teardown the caller owns, awaited (five seconds at most) after the tree's
   * and before `run` settles, so an interrupt waits for it too.
   */
  afterExit?: () => Promise<void>;
  /**
   * Forward SIGINT and SIGTERM to the child as SIGTERM. Default: yes for a
   * process group (a detached leader does not get the terminal's Ctrl+C) and
   * for `tee` and `inherit`, no for `capture`.
   */
  forwardSignals?: boolean;
}

/** How a child ended. A non-zero exit is a result, not an exception. */
export interface RunResult {
  /** The exit status; a signal death is 128 plus the signal number. */
  exitCode: number;
  stdout: string;
  stderr: string;
  /**
   * True when a captured stream was cut at the capture cap. A caller that
   * makes a safety decision from the output must treat this as failure.
   */
  truncated: boolean;
  /** True when the deadline passed and the child was terminated for it. */
  timedOut: boolean;
  /** How many processes of its tree outlived the program and were terminated. */
  outlived: number;
}

function childEnv(overrides: RunOptions['env']): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) Reflect.deleteProperty(env, key);
    else env[key] = value;
  }
  return env;
}

function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  const number = signal === null ? undefined : osConstants.signals[signal];
  return number === undefined ? 1 : 128 + number;
}

interface Capture {
  write: (chunk: Buffer) => void;
  end: () => void;
  text: () => string;
  truncated: () => boolean;
}

function capture(
  stream: 'stdout' | 'stderr',
  mirror: NodeJS.WritableStream | undefined,
  onLine: RunOptions['onLine']
): Capture {
  // One decoder per stream keeps a multibyte character split across chunks intact.
  const decoder = new StringDecoder('utf8');
  const lines =
    onLine === undefined
      ? undefined
      : lineSplitter((line) => {
          onLine(line, stream);
        });
  const chunks: string[] = [];
  let length = 0;
  let cut = false;
  const accept = (text: string): void => {
    if (text.length === 0) return;
    mirror?.write(text);
    lines?.push(text);
    if (cut) return;
    const room = MAX_CAPTURE - length;
    chunks.push(text.length > room ? text.slice(0, room) : text);
    length += Math.min(text.length, room);
    if (text.length > room) {
      chunks.push('\n[output truncated]');
      cut = true;
    }
  };
  return {
    write: (chunk) => {
      accept(decoder.write(chunk));
    },
    end: () => {
      accept(decoder.end());
      lines?.flush();
    },
    text: () => chunks.join(''),
    truncated: () => cut,
  };
}

/** A child the interrupt pipeline knows about. */
interface TrackedChild {
  closed: Promise<void>;
  forward: boolean;
  graceMs: number;
  signal: (signal: NodeJS.Signals) => void;
}

const tracked = new Set<TrackedChild>();
let hooked = false;

async function stopChildren(): Promise<void> {
  let wait = SHUTDOWN_WAIT_MS;
  for (const child of tracked) {
    if (!child.forward) continue;
    child.signal('SIGTERM');
    setTimeout(() => {
      if (tracked.has(child)) child.signal('SIGKILL');
    }, child.graceMs).unref();
    wait = Math.max(wait, child.graceMs + 2_000);
  }
  // Holding the exit here is what lets the escalation above actually run.
  await settlesWithin(Promise.allSettled([...tracked].map((child) => child.closed)), wait);
}

function track(child: Omit<TrackedChild, 'closed'>): () => void {
  if (!hooked) {
    hooked = true;
    onShutdown('stop', stopChildren, { timeoutMs: 120_000 });
    onForceExit(() => {
      for (const entry of tracked) if (entry.forward) entry.signal('SIGKILL');
    });
  }
  let settle: () => void = () => undefined;
  const entry: TrackedChild = {
    ...child,
    closed: new Promise<void>((resolve) => {
      settle = resolve;
    }),
  };
  tracked.add(entry);
  return () => {
    tracked.delete(entry);
    settle();
  };
}

/** Told about the lifetime of every process group this process starts. */
export interface ProcessGroupListener {
  /** The group has just been created. Called synchronously; must not throw. */
  started(pgid: number): void;
  /** The group's teardown established that it is gone. Called synchronously; must not throw. */
  ended(pgid: number): void;
}

const groupListeners = new Set<ProcessGroupListener>();

/**
 * Subscribes to the process groups this process starts. A group whose
 * teardown stayed inconclusive is never reported as ended, so a subscriber
 * errs toward treating it as alive.
 *
 * @param listener - See {@link ProcessGroupListener}
 */
export function onProcessGroup(listener: ProcessGroupListener): void {
  groupListeners.add(listener);
}

function reportTeardown(teardown: ProcessTeardown | undefined): void {
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
  if (uncertainty !== undefined) {
    warn(`Process cleanup is inconclusive: ${uncertainty}. No unowned process was signalled.`);
  }
}

interface Outcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** The output pipes were given up on: a background process still held them. */
  abandoned: boolean;
  /** Processes of the tree that outlived the child and were terminated. */
  outlived: number;
}

/**
 * Follows a spawned child to the end of its teardown.
 *
 * `exit` starts the teardown. `close` only means the pipes drained: a
 * background process holding a pipe must not hold up the result or change
 * it, so the wait for it is bounded. Rejects only with the child's own
 * failure (a failed spawn); a survivor or an uncertain teardown is a
 * diagnostic.
 */
async function follow(
  child: ChildProcess,
  owner: ProcessOwnership | undefined,
  options: { graceMs: number; afterExit: RunOptions['afterExit'] }
): Promise<Outcome> {
  let failure: Error | undefined;
  let escalation: NodeJS.Timeout | undefined;
  let hasExited = false;
  const closed = new Promise<void>((resolve) => {
    child.once('close', () => {
      resolve();
    });
  });
  const exit = await new Promise<Pick<Outcome, 'code' | 'signal'>>((resolve) => {
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      hasExited = true;
      resolve({ code, signal });
    };
    child.once('exit', onExit);
    // A failed spawn emits `error` and `close` with no `exit`.
    child.once('close', onExit);
    child.on('error', (error) => {
      if (hasExited) return;
      failure ??= error;
      if (child.pid === undefined) {
        onExit(null, null);
        return;
      }
      // Something went wrong around a live child; nothing else will end it.
      owner?.signal('SIGTERM');
      escalation ??= setTimeout(() => {
        if (owner !== undefined) owner.signal('SIGKILL');
        else signalChild(child, 'SIGKILL');
      }, options.graceMs);
      escalation.unref();
    });
  });
  clearTimeout(escalation);
  const teardown = await owner?.finish(options.graceMs);
  if (owner !== undefined && teardown?.uncertain === undefined && !teardown?.stillAlive.length) {
    for (const listener of groupListeners) listener.ended(owner.pid);
  }
  const abandoned = !(await settlesWithin(closed, PIPE_DRAIN_MS));
  if (abandoned) {
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.stdin?.destroy();
    child.unref();
    verbose(`PID ${child.pid ?? '?'} exited, but a background process still holds its pipes.`);
  }
  if (options.afterExit !== undefined) {
    let sweepFailure: unknown;
    const sweep = options.afterExit().catch((error: unknown) => {
      sweepFailure = error;
    });
    if (!(await settlesWithin(sweep, AFTER_EXIT_LIMIT_MS))) {
      sweepFailure = new Error(`exceeded ${AFTER_EXIT_LIMIT_MS} ms`);
    }
    if (sweepFailure !== undefined) {
      warn(`Cleanup after PID ${child.pid ?? '?'} failed: ${toError(sweepFailure).message}`);
    }
  }
  reportTeardown(teardown);
  if (failure !== undefined) throw failure;
  const outlived = (teardown?.signalled.length ?? 0) - (teardown?.stillAlive.length ?? 0);
  return { ...exit, abandoned, outlived: Math.max(0, outlived) };
}

function spawnFailure(command: string, error: unknown): Error {
  if (errnoCode(error) !== 'ENOENT') return toError(error);
  return new FireForgeError(
    'command-not-found',
    `Could not run "${command}": it is not installed`,
    {
      exitCode: ExitCode.MISSING_DEPENDENCY,
      hint: `Install ${command} and make sure it is on PATH.`,
      cause: error,
    }
  );
}

function timeoutError(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  result: RunResult
): FireForgeError {
  const stream = result.stderr.trim().length > 0 ? 'stderr' : 'stdout';
  const tail = tailLines(result[stream], 20);
  const output =
    tail.length === 0 ? '' : `\nLast output (${stream}):\n${tail.map((l) => `  ${l}`).join('\n')}`;
  return new FireForgeError(
    'command-timeout',
    `Command timed out after ${Math.round(timeoutMs / 1000)}s: ${[command, ...args].join(' ')}${output}`,
    {
      hint: 'It was stopped for exceeding its time budget. On a loaded host, retrying may succeed.',
    }
  );
}

interface Started {
  child: ChildProcess;
  owner: ProcessOwnership | undefined;
  signal: (signal: NodeJS.Signals) => void;
  graceMs: number;
  out: Capture;
  err: Capture;
  untrack: () => void;
}

/** Spawns the child and wires it up, before any of its events can fire. */
function start(command: string, args: readonly string[], options: RunOptions): Started {
  const output = options.output ?? 'capture';
  const useGroup = options.processGroup === true && process.platform !== 'win32';
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const stdin = options.input !== undefined ? 'pipe' : output === 'capture' ? 'ignore' : 'inherit';
  const sink = output === 'inherit' ? 'inherit' : 'pipe';
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: childEnv(options.env),
    detached: useGroup,
    shell: false,
    stdio: [stdin, sink, sink],
  });
  const owner = useGroup ? ownProcessTree(child) : undefined;
  const signal = (value: NodeJS.Signals): void => {
    if (owner !== undefined) owner.signal(value);
    else signalChild(child, value);
  };
  const untrack = track({
    forward: options.forwardSignals ?? (useGroup || output !== 'capture'),
    graceMs,
    signal,
  });
  const live = output === 'tee' ? { stdout: process.stdout, stderr: process.stderr } : undefined;
  const out = capture('stdout', options.mirror?.stdout ?? live?.stdout, options.onLine);
  const err = capture('stderr', options.mirror?.stderr ?? live?.stderr, options.onLine);
  child.stdout?.on('data', out.write);
  child.stderr?.on('data', err.write);
  if (options.input !== undefined) {
    // A child that exits before reading all of stdin makes the write fail
    // with EPIPE. Its exit status reports the real outcome.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(options.input);
  }
  if (owner !== undefined) {
    for (const listener of groupListeners) listener.started(owner.pid);
    options.onProcessGroup?.(owner);
  }
  return { child, owner, signal, graceMs, out, err, untrack };
}

/** Arms the deadline: SIGTERM when it passes, SIGKILL after the grace. */
function armDeadline(
  timeoutMs: number | undefined,
  started: Started
): { passed: () => boolean; clear: () => void } {
  let passed = false;
  let escalation: NodeJS.Timeout | undefined;
  const deadline =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          passed = true;
          started.signal('SIGTERM');
          escalation = setTimeout(() => {
            started.signal('SIGKILL');
          }, started.graceMs);
        }, timeoutMs);
  return {
    passed: () => passed,
    clear: () => {
      clearTimeout(deadline);
      clearTimeout(escalation);
    },
  };
}

/**
 * Runs a program to completion.
 *
 * @param command - The executable (looked up on PATH)
 * @param args - Its arguments
 * @param options - See {@link RunOptions}
 * @returns How it ended. A non-zero exit resolves; only a failed spawn or an
 *   expired deadline rejects
 */
export async function run(
  command: string,
  args: readonly string[],
  options: RunOptions = {}
): Promise<RunResult> {
  const started = start(command, args, options);
  const deadline = armDeadline(options.timeoutMs, started);
  const { out, err } = started;
  try {
    const exit = await follow(started.child, started.owner, {
      graceMs: started.graceMs,
      afterExit: options.afterExit,
    });
    out.end();
    err.end();
    const result: RunResult = {
      exitCode: exitCodeOf(exit.code, exit.signal),
      stdout: out.text(),
      stderr: err.text(),
      truncated: out.truncated() || err.truncated() || exit.abandoned,
      timedOut: deadline.passed(),
      outlived: exit.outlived,
    };
    if (result.timedOut && options.timeoutIsResult !== true) {
      throw timeoutError(command, args, options.timeoutMs ?? 0, result);
    }
    return result;
  } catch (error: unknown) {
    throw error instanceof FireForgeError ? error : spawnFailure(command, error);
  } finally {
    deadline.clear();
    started.untrack();
  }
}

/**
 * Runs a program and returns stdout as raw, uncapped bytes. For protocols
 * whose framing counts bytes (`git cat-file --batch`), where decoding or
 * truncating would corrupt the stream. The caller bounds the output.
 *
 * @param command - The executable
 * @param args - Its arguments
 * @param options - Working directory, environment overrides, and stdin content
 */
export async function runBytes(
  command: string,
  args: readonly string[],
  options: Pick<RunOptions, 'cwd' | 'env' | 'input'> = {}
): Promise<{ exitCode: number; stdout: Buffer; stderr: string }> {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: childEnv(options.env),
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const untrack = track({
    forward: false,
    graceMs: DEFAULT_GRACE_MS,
    signal: (value) => signalChild(child, value),
  });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
  child.stdin.on('error', () => undefined);
  child.stdin.end(options.input ?? '');
  try {
    const exit = await follow(child, undefined, {
      graceMs: DEFAULT_GRACE_MS,
      afterExit: undefined,
    });
    if (exit.abandoned) {
      throw new FireForgeError(
        'command-output-incomplete',
        `${command} exited, but a process it left behind still holds its output; the output is incomplete.`,
        { hint: 'Find and stop the leftover process, then retry.' }
      );
    }
    return {
      exitCode: exitCodeOf(exit.code, exit.signal),
      stdout: Buffer.concat(out),
      stderr: Buffer.concat(err).toString('utf8'),
    };
  } catch (error: unknown) {
    throw error instanceof FireForgeError ? error : spawnFailure(command, error);
  } finally {
    untrack();
  }
}

/**
 * Finds an executable on PATH without running anything.
 *
 * @param name - The program name
 * @returns Its full path, or undefined when it is not installed
 */
export async function findExecutable(name: string): Promise<string | undefined> {
  const extensions =
    process.platform === 'win32'
      ? ['', ...(process.env['PATHEXT'] ?? '.EXE;.CMD').split(';')]
      : [''];
  for (const directory of (process.env['PATH'] ?? '').split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      try {
        await access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return undefined;
}
