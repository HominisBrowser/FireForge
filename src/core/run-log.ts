// SPDX-License-Identifier: EUPL-1.2
/**
 * Per-run output logs under `.fireforge/logs/`.
 *
 * A run's diagnosis used to exist in exactly one place: the terminal. Piping
 * through `tail`/`grep` — the ergonomic default when output is long — keeps
 * the summary and discards the `TEST-UNEXPECTED-FAIL` lines that say WHAT
 * broke, and it launders the exit code besides. The operator rule ("never
 * pipe a run") was written down three times downstream and broken after each
 * writing, which is the tell that it is not an operator problem: the tool is
 * the only party that can make the log survive the mistake.
 *
 * So `test` and `build` write their own complete copy as they stream, and the
 * `FIREFORGE-VERDICT:` line names the path. A piped, truncated, or
 * backgrounded run then still leaves a re-readable artifact.
 *
 * Everything here is BEST-EFFORT by construction. A log is a diagnostic aid;
 * a run must never fail because one could not be opened, written, or pruned.
 * Every entry point swallows its errors and degrades to "no log", which is
 * exactly the behaviour that existed before this module.
 */

import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { verbose } from '../utils/logger.js';
import { FIREFORGE_DIR } from './config-paths.js';

/** Directory under `.fireforge/` holding run logs. */
const LOGS_DIRNAME = 'logs';

/**
 * How many logs to keep per command kind. Retention is per-kind so a busy
 * `test` loop cannot evict every `build` log, which is the pair an operator
 * most often needs to read together.
 */
const RETAINED_LOGS_PER_COMMAND = 20;

/** A run log sink. `write` never throws. */
export interface RunLog {
  /** Absolute path to the log file. */
  path: string;
  /** Appends raw output. Silently drops on any stream error. */
  write: (chunk: string) => void;
  /** Flushes and closes. Resolves even when the stream already failed. */
  close: () => Promise<void>;
}

/** `.fireforge/logs` under `projectRoot`. */
export function getRunLogDir(projectRoot: string): string {
  return join(projectRoot, FIREFORGE_DIR, LOGS_DIRNAME);
}

/**
 * A filesystem-safe, sortable timestamp: `2026-08-28T14-32-05-123Z`.
 *
 * Colons are not portable in filenames (Windows rejects them outright), so
 * the ISO form is punctuated with dashes only. Lexical order still equals
 * chronological order, which is what the pruning below relies on.
 */
function logTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

/**
 * Makes room for one new log by deleting the oldest, so that at most
 * {@link RETAINED_LOGS_PER_COMMAND} logs for `command` exist once the new
 * one is created. Pruning runs BEFORE the file is opened — hence the
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
    verbose(`Run-log pruning skipped: ${String(error)}`);
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
  let stream: WriteStream;
  const path = join(dir, `${command}-${logTimestamp(now)}.log`);
  try {
    await mkdir(dir, { recursive: true });
    await pruneRunLogs(dir, command);
    stream = createWriteStream(path, { flags: 'a' });
  } catch (error: unknown) {
    verbose(`Run log unavailable (${path}): ${String(error)}`);
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

  return {
    path,
    write: (chunk: string): void => {
      if (broken) return;
      try {
        stream.write(chunk);
      } catch {
        broken = true;
      }
    },
    close: async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        stream.end(() => {
          resolve();
        });
      });
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

/** Installs (or clears, with `undefined`) the run log for this process. */
export function setActiveRunLog(log: RunLog | undefined): void {
  activeRunLog = log;
}

/** Absolute path of the active run log, or undefined when none is open. */
export function getActiveRunLogPath(): string | undefined {
  return activeRunLog?.path;
}

/** Appends to the active run log. A no-op when none is open. */
export function writeToActiveRunLog(chunk: string): void {
  activeRunLog?.write(chunk);
}

/** Closes and clears the active run log. Resolves even when none is open. */
export async function closeActiveRunLog(): Promise<void> {
  const log = activeRunLog;
  activeRunLog = undefined;
  await log?.close();
}

/**
 * A writable that forwards to `base` AND to the active run log.
 *
 * Used by the stdio-inheriting capture path, whose collectors take a mirror
 * stream rather than per-chunk callbacks — so the tee reuses the mirror the
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
