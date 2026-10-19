// SPDX-License-Identifier: EUPL-1.2
/**
 * Where the patch history log lives, and who wrote each record.
 *
 * The log used to be `patches/.fireforge-history.jsonl`, inside the tracked
 * patch queue, so it was committed with every export until consumers
 * gitignored it, and it grew to tens of megabytes. It now defaults to
 * `.fireforge/history.jsonl` (FireForge's own untracked data directory), or
 * `fireforge.json#history.path` when a project sets one. A log left at the
 * old path is moved on the first append.
 *
 * Several sessions sharing one checkout all append to the same log, so each
 * record carries the invocation that wrote it, plus a session hint, letting
 * a session select its own lines mechanically.
 */
import { randomUUID } from 'node:crypto';
import { appendFile, link, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { getNodeErrorCode, toError } from '../utils/errors.js';
import { ensureDir, pathExists } from '../utils/fs.js';
import { info, verbose } from '../utils/logger.js';
import { FIREFORGE_DIR } from './config-paths.js';
import { isValidHistoryPath } from './config-validate-history.js';

/** Filename of the history log at its pre-0.50 location, inside `patches/`. */
export const LEGACY_HISTORY_LOG_FILENAME = '.fireforge-history.jsonl';

/** Default history log location, relative to the project root. */
export const DEFAULT_HISTORY_LOG_PATH = join(FIREFORGE_DIR, 'history.jsonl');

/** Environment variable a caller sets to tag every record of its session. */
export const HISTORY_SESSION_ENV = 'FIREFORGE_SESSION_ID';

let invocationId: string | undefined;

/** Who wrote a history record. */
export interface HistoryRecordIdentity {
  /** One id per FireForge process: every record one command writes shares it. */
  invocationId: string;
  /** The caller's `FIREFORGE_SESSION_ID`, when set. */
  sessionId?: string;
  pid: number;
  ppid: number;
}

/**
 * Identity fields stamped on every history record: one id per FireForge
 * process (every record one command writes shares it), the process and its
 * parent, and the caller's `FIREFORGE_SESSION_ID` when set. The parent PID
 * is a weak hint (usually the shell); the environment variable is the
 * reliable way for a session to tag its own lines.
 */
export function historyRecordIdentity(): HistoryRecordIdentity {
  invocationId ??= randomUUID();
  const session = process.env[HISTORY_SESSION_ENV]?.trim();
  return {
    invocationId,
    ...(session !== undefined && session !== '' ? { sessionId: session } : {}),
    pid: process.pid,
    ppid: process.ppid,
  };
}

/**
 * Reads `history.path` from the project's raw `fireforge.json`.
 *
 * Fail-open: the writer runs after a mutation has already committed, so a
 * missing or unreadable config means "use the default", never an error. An
 * invalid value is refused by config validation when the command loads its
 * config; here it also falls back to the default rather than writing
 * somewhere validation would not allow.
 */
async function readConfiguredHistoryPath(projectRoot: string): Promise<string | undefined> {
  let data: unknown;
  try {
    data = JSON.parse(await readFile(join(projectRoot, 'fireforge.json'), 'utf-8'));
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null) return undefined;
  const history = (data as Record<string, unknown>)['history'];
  if (typeof history !== 'object' || history === null) return undefined;
  const path = (history as Record<string, unknown>)['path'];
  if (path === undefined) return undefined;
  if (!isValidHistoryPath(path)) {
    verbose(`Ignoring invalid history.path in fireforge.json; using ${DEFAULT_HISTORY_LOG_PATH}`);
    return undefined;
  }
  return path;
}

/**
 * Resolves the history log path for a project.
 *
 * @param projectRoot - Project root containing `fireforge.json`
 * @returns Absolute path of the history log
 */
export async function resolveHistoryLogPath(projectRoot: string): Promise<string> {
  const configured = await readConfiguredHistoryPath(projectRoot);
  return resolve(projectRoot, configured ?? DEFAULT_HISTORY_LOG_PATH);
}

/**
 * Moves a history log left at the legacy `patches/` path to `target`.
 *
 * Records are never dropped, whatever else is happening:
 * - The legacy file is first claimed by renaming it aside, so of two
 *   commands migrating at once exactly one does the work and neither
 *   duplicates it.
 * - When `target` does not exist yet (the first run), the claimed file is
 *   hard-linked into place, which cannot overwrite a log another command
 *   created in the meantime, and keeps a large log a constant-time move.
 * - When both exist (an older FireForge appended to the legacy path after
 *   a migration, or `history.path` changed), the legacy records are
 *   appended to the target in one write. They then follow newer records;
 *   every record carries its own `ts`.
 *
 * A crash between the claim and the move leaves the records in a
 * `.migrating-*` file next to the legacy path, never deleted.
 *
 * @param patchesDir - The patches directory that may hold a legacy log
 * @param target - Absolute path of the history log
 */
export async function migrateLegacyHistoryLog(patchesDir: string, target: string): Promise<void> {
  const legacy = join(patchesDir, LEGACY_HISTORY_LOG_FILENAME);
  if (resolve(legacy) === resolve(target)) return;
  try {
    await stat(legacy);
  } catch {
    return;
  }

  const claimed = `${legacy}.migrating-${process.pid}-${randomUUID()}`;
  try {
    await rename(legacy, claimed);
  } catch (error: unknown) {
    if (getNodeErrorCode(error) === 'ENOENT') return;
    throw error;
  }

  await ensureDir(dirname(target));
  try {
    await link(claimed, target);
  } catch (error: unknown) {
    // Windows can report two racing renames of one file as both
    // succeeding, the file ending under the other claimant's name. That
    // claimant holds the records and moves them, so this one stands down.
    if (getNodeErrorCode(error) === 'ENOENT' && !(await pathExists(claimed))) {
      verbose('History log migration lost the claim to a concurrent command');
      return;
    }
    // EEXIST: both logs exist. Anything else (a filesystem without hard
    // links, a target on another device): the append below creates the
    // target when it is missing, so it covers that case too.
    verbose(`History log migration falls back to appending (${toError(error).message})`);
    await appendFile(target, await readFile(claimed));
  }
  await rm(claimed, { force: true });
  info(
    `Moved the patch history log from ${legacy} to ${target}. ` +
      'Nothing reads it back; it is an audit trail only.'
  );
}

/**
 * Appends one serialized record to the project's history log, migrating a
 * legacy log first.
 *
 * @param patchesDir - The project's `patches/` directory; the project root is
 *   its parent, as every caller derives it from `getProjectPaths`
 * @param line - One JSON record, without the trailing newline
 */
export async function appendHistoryLine(patchesDir: string, line: string): Promise<void> {
  const target = await resolveHistoryLogPath(dirname(resolve(patchesDir)));
  await migrateLegacyHistoryLog(patchesDir, target);
  await ensureDir(dirname(target));
  await appendFile(target, `${line}\n`, 'utf-8');
}
