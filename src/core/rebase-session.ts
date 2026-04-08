// SPDX-License-Identifier: EUPL-1.2
/**
 * Rebase session persistence for multi-patch ESR version upgrades.
 * Session state is stored at `.fireforge/rebase-session.json` and
 * survives across CLI invocations so the user can fix conflicts and
 * resume with `fireforge rebase --continue`.
 */

import { join } from 'node:path';

import { pathExists, readJson, removeFile, writeJson } from '../utils/fs.js';
import { isArray, isObject, isString } from '../utils/validation.js';
import { getProjectPaths } from './config-paths.js';
import { createSiblingLockPath, withFileLock } from './file-lock.js';

// ── Types ──

export type RebasePatchStatus =
  | 'pending'
  | 'applied-clean'
  | 'applied-fuzz'
  | 'failed'
  | 'resolved'
  | 'skipped';

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
  /** ESR version being rebased FROM. */
  fromVersion: string;
  /** ESR version being rebased TO. */
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

function isValidSession(data: unknown): data is RebaseSession {
  if (!isObject(data)) return false;
  return (
    isString(data['startedAt']) &&
    isString(data['fromVersion']) &&
    isString(data['toVersion']) &&
    isString(data['preRebaseCommit']) &&
    isArray(data['patches']) &&
    typeof data['currentIndex'] === 'number'
  );
}

// ── Public API ──

/**
 * Loads an existing rebase session, or returns `null` if none exists.
 */
export async function loadRebaseSession(projectRoot: string): Promise<RebaseSession | null> {
  const path = sessionPath(projectRoot);
  if (!(await pathExists(path))) return null;

  const data = await readJson<unknown>(path);
  if (!isValidSession(data)) return null;
  return data;
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
 * Returns `true` when an active rebase session exists on disk.
 */
export async function hasActiveRebaseSession(projectRoot: string): Promise<boolean> {
  return pathExists(sessionPath(projectRoot));
}
