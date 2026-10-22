// SPDX-License-Identifier: EUPL-1.2
/**
 * Per-run output logs under `.fireforge/logs/`.
 *
 * Without a log, a run's diagnosis exists in exactly one place: the terminal.
 * Piping through `tail`/`grep`, the ergonomic default when output is long,
 * keeps the summary and discards the `TEST-UNEXPECTED-FAIL` lines that say
 * what broke, and it launders the exit code besides. An operator rule
 * ("never pipe a run") does not hold in practice, so this is not an operator
 * problem: the tool is the only party that can make the log survive the
 * mistake.
 *
 * So `test` and `build` write their own complete copy as they stream, and the
 * `FIREFORGE-VERDICT:` line names the path. A piped, truncated, or
 * backgrounded run then still leaves a re-readable artifact.
 *
 * Everything here is best-effort. A log is a diagnostic aid, and a run must
 * never fail because one could not be opened, written, or pruned.
 * Every entry point swallows its errors and degrades to "no log", which is
 * exactly the behaviour of a run without this module.
 */

import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { basename as basenameOf, dirname, join, resolve } from 'node:path';
import { Writable } from 'node:stream';

import { toError } from '../utils/errors.js';
import { verbose } from '../utils/logger.js';
import { FIREFORGE_DIR } from './config-paths.js';
import { redactRunLogText } from './run-log-redact.js';
import { fileSafeTimestamp } from './state-file.js';

/** Directory under `.fireforge/` holding run logs. */
const LOGS_DIRNAME = 'logs';

/**
 * How many logs to keep per command kind. Retention is per-kind so a busy
 * `test` loop cannot evict every `build` log, which is the pair an operator
 * most often needs to read together.
 */
const RETAINED_LOGS_PER_COMMAND = 20;

/**
 * Cap on the partial line held back between writes. A child emitting one
 * enormous unterminated line (a minified dump on stderr) would otherwise
 * grow the buffer without bound (and, because each write rebuilds
 * `pending + chunk`, quadratically), with nothing reaching disk until
 * close. Past the cap the tail is redacted and written as-is. A `KEY=value`
 * split exactly at the cap boundary is the accepted cost. Same figure as
 * `line-dispatch.ts` uses for the stream matchers.
 */
const MAX_PENDING_LINE_SIZE = 1024 * 1024;

/**
 * Index just past the last line terminator in `text`, or -1 when there is
 * none. `\n` and lone `\r` both terminate: progress-bar output (mach,
 * cargo) repaints a line with carriage returns and may never send a
 * newline, which would otherwise pin the whole run in `pending`. A single
 * trailing `\r` is not a terminator yet: it may be the first half of a
 * `\r\n` split across chunks.
 */
function lastLineEnd(text: string): number {
  const lastNewline = text.lastIndexOf('\n');
  const lastReturn = text.lastIndexOf('\r');
  const cut = lastReturn > lastNewline && lastReturn < text.length - 1 ? lastReturn : lastNewline;
  return cut === -1 ? -1 : cut + 1;
}

/** A run log sink. `write` never throws. */
export interface RunLog {
  /** Absolute path to the log file. */
  path: string;
  /**
   * Appends output. Complete lines pass through {@link redactRunLogText}
   * before hitting disk. A trailing partial line is held until its newline
   * arrives (or until `close`). Silently drops on any stream error.
   */
  write: (chunk: string) => void;
  /** Flushes and closes. Resolves even when the stream already failed. */
  close: () => Promise<void>;
}

/** `.fireforge/logs` under `projectRoot`. */
export function getRunLogDir(projectRoot: string): string {
  return join(projectRoot, FIREFORGE_DIR, LOGS_DIRNAME);
}

/**
 * Makes room for one new log by deleting the oldest, so that at most
 * {@link RETAINED_LOGS_PER_COMMAND} logs for `command` exist once the new
 * one is created. Pruning runs before the file is opened, hence the
 * `- 1`, without which the directory settles at N + 1.
 *
 * Best-effort: a failure here must not stop the run that is about to be
 * logged.
 */
async function pruneRunLogs(dir: string, command: string): Promise<void> {
  const keep = RETAINED_LOGS_PER_COMMAND - 1;
  try {
    const entries = await readdir(dir);
    const mine = entries.filter((name) => name.startsWith(`${command}-`) && name.endsWith('.log'));
    if (mine.length <= keep) return;
    // Names embed a lexically-sortable timestamp, so sorting is ordering by
    // age without stat-ing every file.
    const stale = mine.sort().slice(0, mine.length - keep);
    await Promise.all(
      stale.map(async (name) => {
        try {
          await unlink(join(dir, name));
        } catch {
          // A concurrent run may have pruned it already.
        }
      })
    );
  } catch (error: unknown) {
    verbose(`Run-log pruning skipped: ${toError(error).message}`);
  }
}

/**
 * Opens `.fireforge/logs/<command>-<timestamp>.log` for a run, pruning older
 * logs of the same kind first.
 *
 * @param projectRoot - Project root directory
 * @param command - Command kind, e.g. `test` or `build`
 * @param now - Clock injection point for deterministic tests
 * @returns The sink, or undefined when no log could be opened
 */
export async function openRunLog(
  projectRoot: string,
  command: string,
  now: Date = new Date()
): Promise<RunLog | undefined> {
  const dir = getRunLogDir(projectRoot);
  const path = join(dir, `${command}-${fileSafeTimestamp(now)}.log`);
  try {
    await mkdir(dir, { recursive: true });
    await pruneRunLogs(dir, command);
  } catch (error: unknown) {
    verbose(`Run log unavailable (${path}): ${toError(error).message}`);
    return undefined;
  }
  return openRunLogSink(path);
}

/**
 * Opens one redacting log file at `path`, creating its directory.
 *
 * @param path - Absolute file path
 * @returns The sink, or undefined when the file could not be opened
 */
async function openRunLogSink(path: string): Promise<RunLog | undefined> {
  let stream: WriteStream;
  try {
    await mkdir(dirname(path), { recursive: true });
    stream = createWriteStream(path, { flags: 'a' });
  } catch (error: unknown) {
    verbose(`Run log unavailable (${path}): ${toError(error).message}`);
    return undefined;
  }

  // A stream error after open (disk full, a removed directory) must not
  // become an unhandled 'error' event and kill the run the log exists to
  // describe. Latch it and drop every later write.
  let broken = false;
  stream.on('error', (error: Error) => {
    broken = true;
    verbose(`Run log write failed (${path}): ${error.message}`);
  });

  // Redaction is per LINE, and chunks arrive at arbitrary byte boundaries,
  // so a `KEY=value` split across two chunks would slip past a per-chunk
  // pass. Hold the trailing partial line until its terminator arrives (or
  // it outgrows MAX_PENDING_LINE_SIZE, or the log is closed).
  let pending = '';
  const emit = (text: string): void => {
    if (broken || text.length === 0) return;
    try {
      stream.write(redactRunLogText(text));
    } catch {
      broken = true;
    }
  };

  return {
    path,
    write: (chunk: string): void => {
      if (broken) return;
      const buffered = pending + chunk;
      const lineEnd = lastLineEnd(buffered);
      if (lineEnd === -1) {
        pending = buffered;
      } else {
        pending = buffered.slice(lineEnd);
        emit(buffered.slice(0, lineEnd));
      }
      if (pending.length > MAX_PENDING_LINE_SIZE) {
        emit(pending);
        pending = '';
      }
    },
    close: async (): Promise<void> => {
      const tail = pending;
      pending = '';
      emit(tail);
      await new Promise<void>((resolve) => {
        stream.end(() => {
          resolve();
        });
      });
    },
  };
}

/** Environment variable naming where every run's log is also kept. */
const LOG_KEEP_ENV_VAR = 'FIREFORGE_LOG_KEEP';

/**
 * Where a run's kept copy goes: `--keep-log <path>` when given, else
 * {@link LOG_KEEP_ENV_VAR}, else nowhere. A value that ends in a path
 * separator or names an existing directory receives the log under its own
 * `.fireforge/logs/` basename, so a session-wide directory collects one
 * file per run. Any other value is the file itself. Relative values resolve
 * against the caller's working directory.
 *
 * @param flag - The `--keep-log` value, if any
 * @param basename - The run log's own file name
 * @returns The absolute destination, or undefined when none was asked for
 */
async function resolveRunLogKeepPath(
  flag: string | undefined,
  basename: string
): Promise<string | undefined> {
  const raw = flag ?? process.env[LOG_KEEP_ENV_VAR]?.trim();
  if (raw === undefined || raw.length === 0) return undefined;
  const target = resolve(raw);
  let directory = /[\\/]$/.test(raw);
  if (!directory) {
    try {
      directory = (await stat(target)).isDirectory();
    } catch {
      directory = false;
    }
  }
  return directory ? join(target, basename) : target;
}

/**
 * Tees a run log into a caller-chosen copy (`--keep-log`,
 * {@link LOG_KEEP_ENV_VAR}) that retention never prunes.
 *
 * `.fireforge/logs/` keeps twenty logs per command kind for EVERY session
 * on the checkout, so on a shared checkout a log named by a verdict line
 * can be gone within the hour, and a failure recorded only by its log path
 * cannot be read later. The copy is written live, line for line with the
 * same redaction, rather than copied at the end: a killed run keeps what it
 * had written, like the primary log does.
 *
 * The primary path stays the one `log=` names. When the primary could not
 * be opened the copy stands in for it.
 *
 * @param log - The primary run log, if one opened
 * @param flag - The `--keep-log` value, if any
 * @param command - Command kind, naming a copy that has no primary
 * @returns A sink writing to both, or whichever one opened
 */
export async function keepRunLogCopy(
  log: RunLog | undefined,
  flag: string | undefined,
  command: string
): Promise<RunLog | undefined> {
  const basename =
    log === undefined ? `${command}-${fileSafeTimestamp(new Date())}.log` : basenameOf(log.path);
  const keepPath = await resolveRunLogKeepPath(flag, basename);
  if (keepPath === undefined || keepPath === log?.path) return log;
  const copy = await openRunLogSink(keepPath);
  if (copy === undefined) return log;
  if (log === undefined) return copy;
  return {
    path: log.path,
    write: (chunk: string): void => {
      log.write(chunk);
      copy.write(chunk);
    },
    close: async (): Promise<void> => {
      await Promise.all([log.close(), copy.close()]);
    },
  };
}

/**
 * The run log for the command currently executing, if any.
 *
 * Module state rather than a threaded parameter, for the same reason
 * `test-verdict.ts` keeps its emitted-once flag here: the sink has to be
 * reachable from `mach.ts`'s stream callbacks, which sit five frames below
 * the command that opened it, behind dispatch signatures that exist to
 * describe TESTS rather than logging. Threading it would have touched every
 * dispatcher, the retry wrapper and the shard loop to deliver one pointer.
 *
 * One command runs per process, so a single slot is the whole lifetime.
 */
let activeRunLog: RunLog | undefined;
/** Newlines written to the active log so far, for line references into it. */
let activeRunLogNewlines = 0;

/** Installs (or clears, with `undefined`) the run log for this process. */
export function setActiveRunLog(log: RunLog | undefined): void {
  activeRunLog = log;
  activeRunLogNewlines = 0;
}

/**
 * The 1-based line of the active run log the next write starts on.
 * Redaction rewrites within a line and never adds or drops one, so the
 * number holds for the file on disk.
 */
export function activeRunLogLine(): number {
  return activeRunLogNewlines + 1;
}

/** Absolute path of the active run log, or undefined when none is open. */
export function getActiveRunLogPath(): string | undefined {
  return activeRunLog?.path;
}

/** Appends to the active run log. A no-op when none is open. */
export function writeToActiveRunLog(chunk: string): void {
  if (activeRunLog === undefined) return;
  for (let index = chunk.indexOf('\n'); index !== -1; index = chunk.indexOf('\n', index + 1)) {
    activeRunLogNewlines += 1;
  }
  activeRunLog.write(chunk);
}

/**
 * Closes and clears the active run log. Resolves even when none is open.
 *
 * Also called from the entry point's SIGINT/SIGTERM path: the held partial
 * line and anything queued in the stream would otherwise be lost across
 * `process.exit`, and a killed run's last line is usually the one that
 * says what it was doing.
 */
export async function closeActiveRunLog(): Promise<void> {
  const log = activeRunLog;
  activeRunLog = undefined;
  await log?.close();
}

/**
 * A writable that forwards to `base` and to the active run log.
 *
 * Used by the stdio-inheriting capture path, whose collectors take a mirror
 * stream rather than per-chunk callbacks, so the tee reuses the mirror the
 * exec layer already supports instead of growing a second hook.
 *
 * @param base - The stream to forward to (normally `process.stdout`)
 * @returns A writable teeing into `base` and the run log
 */
export function teeToRunLog(base: NodeJS.WritableStream): NodeJS.WritableStream {
  return new Writable({
    write(chunk: Buffer | string, _encoding, callback): void {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      base.write(text);
      writeToActiveRunLog(text);
      callback();
    },
  });
}
