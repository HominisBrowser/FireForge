// SPDX-License-Identifier: EUPL-1.2
/**
 * The scoped half of the `re-export --dry-run` purity guard.
 *
 * A dry run takes no engine-session lock since 0.51.0, so peers keep
 * writing while it runs. The whole-tree fingerprint then reported every
 * peer's write as "invariant violated … This is a FireForge bug", and an
 * immediate repeat was clean. The scoped fingerprint covers only what the
 * dry run could touch: the selected patches' bodies and manifest rows, the
 * engine files they own, the engine HEAD and the engine index. A mismatch
 * that remains is attributed to a foreign writer when the history log or
 * the engine lock shows one in the window.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { readEngineSessionLockStatus } from '../core/engine-session-lock.js';
import { git } from '../core/git-base.js';
import { historyRecordIdentity, resolveHistoryLogPath } from '../core/history-log-file.js';
import { PATCHES_MANIFEST } from '../core/patch-manifest-io.js';
import { GeneralError } from '../errors/base.js';
import type { PatchMetadata } from '../types/commands/index.js';
import { getNodeErrorCode, toError } from '../utils/errors.js';
import { sha256Hex } from '../utils/hash.js';
import { isArray, isObject } from '../utils/validation.js';

/** What a scoped dry run could touch: the patches it was asked about. */
export interface DryRunPurityScope {
  /** The selected patches. */
  patches: readonly PatchMetadata[];
}

/** Reads a file's bytes as a hash, `absent` when it does not exist. */
async function hashOrAbsent(path: string, label: string): Promise<string> {
  try {
    return sha256Hex(await readFile(path));
  } catch (error: unknown) {
    const code = getNodeErrorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'absent';
    throw new GeneralError(
      `[dry-run] cannot fingerprint ${label} for the purity guard: ${toError(error).message}`,
      error
    );
  }
}

/** The selected rows of `patches.json`, so a peer's write to another row is not a violation. */
async function selectedRowsFingerprint(
  patchesDir: string,
  filenames: ReadonlySet<string>
): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(join(patchesDir, PATCHES_MANIFEST), 'utf8');
  } catch (error: unknown) {
    if (getNodeErrorCode(error) === 'ENOENT') return 'absent';
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const rows = isObject(parsed) && isArray(parsed['patches']) ? parsed['patches'] : [];
    const selected = rows.filter(
      (row) =>
        isObject(row) && typeof row['filename'] === 'string' && filenames.has(row['filename'])
    );
    return sha256Hex(JSON.stringify(selected));
  } catch {
    // A manifest that no longer parses changed, whoever wrote it.
    return sha256Hex(raw);
  }
}

/**
 * Fingerprints exactly the state a scoped `re-export --dry-run` could
 * disturb. Every key names what it covers, so a violation reads as the
 * path that moved.
 */
export async function fingerprintScopedDryRunState(
  engineDir: string,
  patchesDir: string,
  scope: DryRunPurityScope
): Promise<Map<string, string>> {
  const fingerprint = new Map<string, string>();
  try {
    fingerprint.set('engine HEAD', (await git(['rev-parse', 'HEAD'], engineDir)).trim());
    // The index as a whole: the historic purity defect was a transient
    // `--intent-to-add` entry, which may land on any path a scan reads.
    fingerprint.set(
      'the engine index',
      sha256Hex(await git(['ls-files', '--stage', '-z'], engineDir))
    );
  } catch (error: unknown) {
    throw new GeneralError(
      `[dry-run] cannot fingerprint the engine for the purity guard: ${toError(error).message}`,
      error
    );
  }
  const filenames = new Set(scope.patches.map((patch) => patch.filename));
  fingerprint.set(
    `${PATCHES_MANIFEST} rows of ${[...filenames].sort().join(', ')}`,
    await selectedRowsFingerprint(patchesDir, filenames)
  );
  for (const filename of [...filenames].sort()) {
    fingerprint.set(
      `patches/${filename}`,
      await hashOrAbsent(join(patchesDir, filename), `patches/${filename}`)
    );
  }
  const owned = [...new Set(scope.patches.flatMap((patch) => patch.filesAffected))].sort();
  for (const file of owned) {
    fingerprint.set(`engine/${file}`, await hashOrAbsent(join(engineDir, file), `engine/${file}`));
  }
  return fingerprint;
}

interface HistoryLine {
  ts?: unknown;
  operation?: unknown;
  invocationId?: unknown;
  pid?: unknown;
  sessionId?: unknown;
}

/** History records another invocation wrote at or after `sinceMs`. */
async function foreignHistoryRecords(projectRoot: string, sinceMs: number): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(await resolveHistoryLogPath(projectRoot), 'utf8');
  } catch {
    return [];
  }
  const own = historyRecordIdentity().invocationId;
  const writers: string[] = [];
  for (const line of text.split('\n').slice(-500)) {
    let record: HistoryLine;
    try {
      record = JSON.parse(line) as HistoryLine;
    } catch {
      continue;
    }
    const ts = typeof record.ts === 'string' ? Date.parse(record.ts) : Number.NaN;
    if (!(ts >= sinceMs) || record.invocationId === own) continue;
    const session = typeof record.sessionId === 'string' ? `, session ${record.sessionId}` : '';
    writers.push(`${String(record.operation)} (PID ${String(record.pid)}${session})`);
  }
  return writers;
}

/**
 * Names whoever else wrote during the dry run: history records from other
 * invocations since it started, and a live holder of the engine-session
 * lock (which a dry run no longer takes). Empty when there is no evidence.
 */
export async function describeForeignWriters(
  patchesDir: string,
  sinceMs: number
): Promise<string[]> {
  const projectRoot = dirname(resolve(patchesDir));
  const writers = await foreignHistoryRecords(projectRoot, sinceMs);
  try {
    const lock = await readEngineSessionLockStatus(projectRoot);
    if (lock.held && lock.holder !== undefined && lock.holder.pid !== process.pid) {
      const detail = lock.holder.metadata.length > 0 ? ` (${lock.holder.metadata.join(', ')})` : '';
      writers.push(`the engine-session lock holder, PID ${lock.holder.pid}${detail}`);
    }
  } catch {
    // Attribution is best effort; the violation is reported either way.
  }
  return writers;
}
