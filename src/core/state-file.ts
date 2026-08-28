// SPDX-License-Identifier: EUPL-1.2
import { rename } from 'node:fs/promises';
import { basename } from 'node:path';

import { pathExists } from '../utils/fs.js';
import { createSiblingLockPath, withFileLock } from './file-lock.js';

/** Runs an operation while holding the sidecar lock for a FireForge state file. */
export async function withStateFileLock<T>(
  statePath: string,
  operation: () => Promise<T>
): Promise<T> {
  return withFileLock(createSiblingLockPath(statePath, '.fireforge-state.lock'), operation, {
    onTimeoutMessage:
      `Timed out waiting to update FireForge state at ${statePath}. ` +
      'If no other fireforge process is running, remove the stale lock directory and retry.',
    onStaleLockMessage: (ageMs) =>
      `Removing stale FireForge state lock for ${basename(statePath)} ` +
      `(age: ${Math.round(ageMs / 1000)}s). A previous fireforge process may have crashed.`,
  });
}

/** Renames a state file out of the way while preserving it for later inspection. */
export async function quarantineStateFile(
  statePath: string,
  reason = 'corrupt'
): Promise<string | undefined> {
  if (!(await pathExists(statePath))) {
    return undefined;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const quarantinedPath = `${statePath}.${reason}-${timestamp}`;
  await rename(statePath, quarantinedPath);
  return basename(quarantinedPath);
}

/**
 * Outcome of a version check on a persisted FireForge document.
 *
 * The distinction that matters is `newer` vs `corrupt`. A document written
 * by a NEWER FireForge is not damaged — the operator simply needs to upgrade
 * — but a check that collapses the two offers destructive remedies. The
 * sharpest case is the tree marker, whose `schemaVersion` check inside a
 * boolean type guard makes a `schemaVersion: 2` marker read as "missing or
 * mistypes a required field"; `tree-guard.ts` is default-deny on corrupt, so
 * a newer FireForge would lock the operator out of every mutating command
 * inside that tree.
 *
 * `furnace.json` is the pattern the rest should follow: it refuses a newer
 * version by name and tells the operator to upgrade (`migrateFurnaceConfig`
 * in `furnace-config.ts`).
 */
export type DocumentVersionCheck =
  | { kind: 'current' }
  | { kind: 'older'; found: number }
  | { kind: 'newer'; found: number }
  | { kind: 'malformed' };

/**
 * Classifies a persisted document's `version`/`schemaVersion` field.
 *
 * @param raw - The parsed document
 * @param field - Version field name, e.g. `schemaVersion`
 * @param supported - Version this build writes and understands
 * @returns Whether the document is current, older, newer, or malformed
 */
export function checkDocumentVersion(
  raw: unknown,
  field: string,
  supported: number
): DocumentVersionCheck {
  if (typeof raw !== 'object' || raw === null) return { kind: 'malformed' };
  const found = (raw as Record<string, unknown>)[field];
  if (typeof found !== 'number' || !Number.isInteger(found) || found < 1) {
    return { kind: 'malformed' };
  }
  if (found > supported) return { kind: 'newer', found };
  if (found < supported) return { kind: 'older', found };
  return { kind: 'current' };
}

/**
 * The refusal shown for a document this build is too old to read.
 *
 * @param label - Operator-facing document name, e.g. `tree marker`
 * @param found - Version found on disk
 * @param supported - Version this build understands
 * @returns A message naming both versions and the remedy
 */
export function describeNewerDocument(label: string, found: number, supported: number): string {
  return (
    `the ${label} was written by a newer FireForge (schema version ${found}; ` +
    `this build understands ${supported}). Upgrade FireForge to read it — the file is ` +
    'not damaged, so do not delete it.'
  );
}
