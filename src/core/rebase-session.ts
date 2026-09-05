// SPDX-License-Identifier: EUPL-1.2
/**
 * Rebase session persistence for multi-patch Firefox source upgrades.
 * Session state is stored at `.fireforge/rebase-session.json` and
 * survives across CLI invocations so the user can fix conflicts and
 * resume with `fireforge rebase --continue`.
 */

import { join } from 'node:path';

import type { FirefoxProduct } from '../types/config.js';
import { getNodeErrorCode, toError } from '../utils/errors.js';
import { pathExists, readJson, removeFile, writeJson } from '../utils/fs.js';
import {
  isArray,
  isNumber,
  isObject,
  isString,
  isValidFirefoxProduct,
  isValidFirefoxVersion,
} from '../utils/validation.js';
import { getProjectPaths } from './config-paths.js';
import { createSiblingLockPath, withFileLock } from './file-lock.js';

// ── Types ──

export type RebasePatchStatus =
  'pending' | 'applied-clean' | 'applied-fuzz' | 'failed' | 'resolved' | 'skipped';

/**
 * One patch's outcome in a rebase session.
 *
 * A discriminated union on `status`, so a payload can only be present on the
 * status it belongs to. A flat-optionals shape makes
 * `{ status: 'resolved', error, conflictingFiles }` representable, and
 * `rebase --continue` will write it — flipping the status without clearing
 * the failure payload, then persisting that to the session file.
 *
 * The on-disk validator (`isValidPatchEntry`) is deliberately NOT tightened
 * to match. The session file carries no schema version, so a stricter
 * validator would reject an older file mid-rebase, where the only remedies
 * discard the operator's in-progress conflict resolution. Instead
 * {@link normalizeEntry} drops payload that does not belong to the status on
 * read, so an older file loads and is corrected rather than refused.
 */
export type RebasePatchEntry = { filename: string } & (
  | { status: 'pending' | 'applied-clean' | 'skipped' | 'resolved' }
  | { status: 'applied-fuzz'; fuzzFactor: number }
  | { status: 'failed'; error?: string; conflictingFiles?: string[] }
);

export interface RebaseSession {
  /** ISO timestamp when the rebase started. */
  startedAt: string;
  /** Source product being rebased FROM. */
  fromProduct?: FirefoxProduct;
  /** Source product being rebased TO. */
  toProduct?: FirefoxProduct;
  /** Source version being rebased FROM. */
  fromVersion: string;
  /** Source version being rebased TO. */
  toVersion: string;
  /** Commit hash recorded before the rebase started (for --abort). */
  preRebaseCommit: string;
  /** Ordered list of all patches and their status. */
  patches: RebasePatchEntry[];
  /** Index of the next patch to process (resume point). */
  currentIndex: number;
}

// ── Helpers ──

const SESSION_FILENAME = 'rebase-session.json';

/** Absolute path of the session file, for messages that must name it. */
export function getRebaseSessionPath(projectRoot: string): string {
  return join(getProjectPaths(projectRoot).fireforgeDir, SESSION_FILENAME);
}

const REBASE_PATCH_STATUSES: readonly RebasePatchStatus[] = [
  'pending',
  'applied-clean',
  'applied-fuzz',
  'failed',
  'resolved',
  'skipped',
];

/** Validates one `patches[]` element to its declared shape. */
/**
 * Drops payload that does not belong to an entry's status.
 *
 * Applied on read so a session written by an older FireForge — where
 * `rebase --continue` left `error`/`conflictingFiles` on a now-`resolved`
 * entry — loads cleanly and is corrected, instead of being refused by a
 * stricter validator mid-rebase.
 *
 * @param entry - A structurally valid entry, possibly carrying stale payload
 * @returns The entry with only the fields its status permits
 */
function normalizeEntry(entry: RebasePatchEntry): RebasePatchEntry {
  if (entry.status === 'applied-fuzz') {
    return { filename: entry.filename, status: 'applied-fuzz', fuzzFactor: entry.fuzzFactor };
  }
  if (entry.status === 'failed') {
    return {
      filename: entry.filename,
      status: 'failed',
      ...(entry.error !== undefined ? { error: entry.error } : {}),
      ...(entry.conflictingFiles !== undefined ? { conflictingFiles: entry.conflictingFiles } : {}),
    };
  }
  return { filename: entry.filename, status: entry.status };
}

function isValidPatchEntry(value: unknown): value is RebasePatchEntry {
  if (!isObject(value)) return false;
  if (!isString(value['filename']) || value['filename'].length === 0) return false;
  if (!REBASE_PATCH_STATUSES.includes(value['status'] as RebasePatchStatus)) return false;
  if (value['fuzzFactor'] !== undefined && !isNumber(value['fuzzFactor'])) return false;
  if (value['error'] !== undefined && !isString(value['error'])) return false;
  const conflicting = value['conflictingFiles'];
  if (conflicting !== undefined && (!isArray(conflicting) || !conflicting.every(isString))) {
    return false;
  }
  return true;
}

/** Optional product field: absent is legal, present must be a real product. */
function isValidOptionalProduct(value: unknown): boolean {
  return value === undefined || (isString(value) && isValidFirefoxProduct(value));
}

/**
 * Validates a session file against the shape the rebase commands actually
 * consume — not merely against broad field types.
 *
 * A looser predicate that checks six `typeof`s and nothing else admits
 * sessions the resume path then acts on. `patches: [null]` reaches
 * `patch-loop.ts`, which reads `.filename` off each entry and hands it to
 * `stampPatchVersions`. A `currentIndex` of `NaN` (legal for
 * `typeof === 'number'`) makes the resume loop run zero iterations and
 * report success; a negative one indexes out of range in `continue.ts`.
 * `toVersion: ""` passes `isString` and is stamped verbatim onto every
 * Furnace override's `baseVersion`. `fromProduct`/`toProduct` go unchecked
 * despite being typed `FirefoxProduct`.
 *
 * The session file is written only by `rebase/index.ts` from validated CLI
 * and config values, so every one of these is a corrupt-file or hand-edit
 * case — which is exactly what this predicate exists to catch.
 */
function isValidSession(data: unknown): data is RebaseSession {
  if (!isObject(data)) return false;
  if (!isString(data['startedAt']) || Number.isNaN(Date.parse(data['startedAt']))) return false;
  // 4 is git's own minimum abbreviation length; 40/64 are full SHA-1/SHA-256.
  if (!isString(data['preRebaseCommit']) || !/^[0-9a-f]{4,64}$/i.test(data['preRebaseCommit'])) {
    return false;
  }
  if (!isString(data['fromVersion']) || !isValidFirefoxVersion(data['fromVersion'])) return false;
  if (!isString(data['toVersion']) || !isValidFirefoxVersion(data['toVersion'])) return false;
  if (!isValidOptionalProduct(data['fromProduct'])) return false;
  if (!isValidOptionalProduct(data['toProduct'])) return false;

  const patches = data['patches'];
  if (!isArray(patches) || !patches.every(isValidPatchEntry)) return false;

  // `<= patches.length` because the resume point legally sits one past the
  // last entry once every patch has been processed.
  const currentIndex = data['currentIndex'];
  if (!isNumber(currentIndex) || !Number.isInteger(currentIndex)) return false;
  return currentIndex >= 0 && currentIndex <= patches.length;
}

// ── Public API ──

/**
 * Outcome of reading the session file, following the {@link LockOwner}
 * discriminated-union form rather than collapsing three states into `null`.
 *
 * Distinguishing `present: false` from `present: true, valid: false` is
 * load-bearing. Collapsing both to `null` while reporting liveness from
 * `pathExists` alone wedges the operator in a closed cycle: `rebase` says
 * "already in progress — use --continue or --abort", and both of those say
 * "no rebase session in progress", with no CLI path deleting the file and no
 * message naming it.
 */
export type RebaseSessionRead =
  | { present: false }
  | { present: true; valid: true; session: RebaseSession }
  | { present: true; valid: false; reason: string };

/**
 * Reads the session file, reporting absent, valid, and corrupt as three
 * distinct outcomes. Never throws for a malformed file: `readJson` calls
 * `JSON.parse` with no guard of its own, so an interrupted write would
 * otherwise surface a raw `SyntaxError` out of `--continue`/`--abort`.
 *
 * A single read determines liveness and validity: only ENOENT/ENOTDIR from
 * that read mean `absent`. A pathExists pre-probe both races deletion (a
 * file removed between probe and read misreports an absent session as
 * corrupt) and swallows EACCES (an unreadable `.fireforge/` misreports a
 * session as absent) — the same failure `readTreeMarker` avoids for tree
 * markers.
 */
export async function readRebaseSession(projectRoot: string): Promise<RebaseSessionRead> {
  const path = getRebaseSessionPath(projectRoot);

  let data: unknown;
  try {
    data = await readJson<unknown>(path);
  } catch (error: unknown) {
    const code = getNodeErrorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return { present: false };
    return { present: true, valid: false, reason: toError(error).message };
  }

  if (!isValidSession(data)) {
    return { present: true, valid: false, reason: 'the file is not a valid rebase session' };
  }
  // Normalize on read: an older session can carry a failure's
  // `error`/`conflictingFiles` on an entry whose status has since been
  // flipped to `resolved`. Correcting it here is what lets the validator
  // stay permissive, so an in-flight rebase from an older FireForge still
  // loads.
  return {
    present: true,
    valid: true,
    session: { ...data, patches: data.patches.map(normalizeEntry) },
  };
}

/**
 * Persists a rebase session atomically.
 */
export async function saveRebaseSession(
  projectRoot: string,
  session: RebaseSession
): Promise<void> {
  const path = getRebaseSessionPath(projectRoot);
  await withFileLock(createSiblingLockPath(path, '.rebase-session.lock'), async () => {
    await writeJson(path, session);
  });
}

/**
 * Removes the rebase session file.
 */
export async function clearRebaseSession(projectRoot: string): Promise<void> {
  const path = getRebaseSessionPath(projectRoot);
  if (await pathExists(path)) {
    await removeFile(path);
  }
}
