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

export interface RebasePatchEntry {
  filename: string;
  status: RebasePatchStatus;
  /** Fuzz factor used when status is `applied-fuzz`. */
  fuzzFactor?: number;
  /** Error message when status is `failed`. */
  error?: string;
  /** Files that caused conflicts. */
  conflictingFiles?: string[];
}

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

function sessionPath(projectRoot: string): string {
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
 * The looser predicate this replaces checked six `typeof`s and nothing else,
 * which admitted sessions the resume path then acted on. `patches: [null]`
 * reached `patch-loop.ts`, which reads `.filename` off each entry and hands it
 * to `stampPatchVersions`. A `currentIndex` of `NaN` (legal for
 * `typeof === 'number'`) made the resume loop run zero iterations and report
 * success; a negative one indexed out of range in `continue.ts`. `toVersion:
 * ""` passed `isString` and was stamped verbatim onto every Furnace override's
 * `baseVersion`. `fromProduct`/`toProduct` were not checked at all despite
 * being typed `FirefoxProduct`.
 *
 * The session file is written only by `rebase/index.ts` from validated CLI and
 * config values, so every one of these is a corrupt-file or hand-edit case —
 * which is exactly the case this predicate exists to catch.
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
 * load-bearing. Before 0.41.0 both returned `null` while
 * {@link hasActiveRebaseSession} reported liveness from `pathExists` alone, so
 * an invalid session file wedged the operator in a closed cycle: `rebase` said
 * "already in progress — use --continue or --abort", and both of those said
 * "no rebase session in progress". No CLI path deleted the file and no message
 * named it, so the only escape was knowing to `rm` it by hand.
 */
export type RebaseSessionRead =
  | { present: false }
  | { present: true; valid: true; session: RebaseSession }
  | { present: true; valid: false; reason: string };

/** Absolute path of the session file, for messages that must name it. */
export function getRebaseSessionPath(projectRoot: string): string {
  return sessionPath(projectRoot);
}

/**
 * Reads the session file, reporting absent, valid, and corrupt as three
 * distinct outcomes. Never throws for a malformed file: `readJson` calls
 * `JSON.parse` with no guard of its own, so an interrupted write surfaced a
 * raw `SyntaxError` out of `--continue`/`--abort` before 0.41.0.
 *
 * A single read determines liveness and validity: only ENOENT/ENOTDIR from
 * that read mean `absent`. A pathExists pre-probe both raced deletion (a file
 * removed between probe and read misreported an absent session as corrupt)
 * and swallowed EACCES (an unreadable `.fireforge/` misreported a session as
 * absent) — the same failure `readTreeMarkerState` fixed for tree markers.
 */
export async function readRebaseSession(projectRoot: string): Promise<RebaseSessionRead> {
  const path = sessionPath(projectRoot);

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
  return { present: true, valid: true, session: data };
}

/**
 * Loads an existing rebase session, or returns `null` when none exists or the
 * file on disk is unusable. Callers that must tell those two apart — every
 * command that reports to an operator — should use {@link readRebaseSession}.
 */
export async function loadRebaseSession(projectRoot: string): Promise<RebaseSession | null> {
  const result = await readRebaseSession(projectRoot);
  return result.present && result.valid ? result.session : null;
}

/**
 * Persists a rebase session atomically.
 */
export async function saveRebaseSession(
  projectRoot: string,
  session: RebaseSession
): Promise<void> {
  const path = sessionPath(projectRoot);
  await withFileLock(createSiblingLockPath(path, '.rebase-session.lock'), async () => {
    await writeJson(path, session);
  });
}

/**
 * Removes the rebase session file.
 */
export async function clearRebaseSession(projectRoot: string): Promise<void> {
  const path = sessionPath(projectRoot);
  if (await pathExists(path)) {
    await removeFile(path);
  }
}

/**
 * Returns `true` when a rebase session file exists on disk, valid or not.
 * Test-facing convenience — production code reads `readRebaseSession` once
 * instead, so liveness and validity come from the same read.
 */
export async function hasActiveRebaseSession(projectRoot: string): Promise<boolean> {
  return pathExists(sessionPath(projectRoot));
}
