// SPDX-License-Identifier: EUPL-1.2
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  isUnavailableGenerationToken,
  snapshotEngineGeneration,
  unavailableGenerationReason,
} from '../core/engine-session-lock.js';
import { createSiblingLockPath, withFileLock } from '../core/file-lock.js';
import { formatPatchNotFoundError } from '../core/patch-identifier-suggest.js';
import { resolvePatchIdentifier } from '../core/patch-manifest.js';
import { GeneralError, InvalidArgumentError } from '../errors/base.js';
import type { PatchesManifest } from '../types/commands/index.js';
import { mapWithConcurrency } from '../utils/concurrency.js';
import { getNodeErrorCode, toError } from '../utils/errors.js';
import { readText } from '../utils/fs.js';
import { normalizeEngineRelativeInput } from './re-export-scan.js';

/** Concurrency bound for patch-body hashing (matches the classify/lint pools). */
const PATCH_HASH_CONCURRENCY = 8;

interface ScanFilesManifestAssignment {
  patch: string;
  files: string[];
}

interface ScanFilesManifest {
  assignments: ScanFilesManifestAssignment[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseScanFilesManifest(raw: string, manifestPath: string): ScanFilesManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    throw new InvalidArgumentError(
      `--scan-files manifest is not valid JSON (${manifestPath}): ${toError(error).message}`,
      '--scan-files'
    );
  }

  if (!isRecord(parsed) || !Array.isArray(parsed['assignments'])) {
    throw new InvalidArgumentError(
      '--scan-files manifest must contain an assignments array.',
      '--scan-files'
    );
  }

  const assignments: ScanFilesManifestAssignment[] = [];
  for (const [index, assignment] of parsed['assignments'].entries()) {
    if (!isRecord(assignment)) {
      throw new InvalidArgumentError(
        `--scan-files assignments[${index}] must be an object.`,
        '--scan-files'
      );
    }
    const { patch, files } = assignment;
    if (typeof patch !== 'string' || patch.trim().length === 0) {
      throw new InvalidArgumentError(
        `--scan-files assignments[${index}].patch must be a non-empty string.`,
        '--scan-files'
      );
    }
    if (
      !Array.isArray(files) ||
      files.length === 0 ||
      !files.every((file) => typeof file === 'string')
    ) {
      throw new InvalidArgumentError(
        `--scan-files assignments[${index}].files must be a non-empty string array.`,
        '--scan-files'
      );
    }
    assignments.push({ patch, files });
  }

  if (assignments.length === 0) {
    throw new InvalidArgumentError(
      '--scan-files manifest must assign at least one file.',
      '--scan-files'
    );
  }

  return { assignments };
}

/** Loads and validates a `re-export --scan-files` assignment manifest. */
export async function loadScanFilesAssignments(
  manifestPath: string,
  manifest: PatchesManifest
): Promise<Map<string, string[]>> {
  const parsed = parseScanFilesManifest(await readText(manifestPath), manifestPath);
  const filesByPatch = new Map<string, Set<string>>();
  const ownerByFile = new Map<string, string>();

  for (const assignment of parsed.assignments) {
    const patch = resolvePatchIdentifier(assignment.patch, manifest.patches);
    if (!patch) {
      // Suggest, never dump.
      throw new InvalidArgumentError(
        `--scan-files: ${formatPatchNotFoundError(assignment.patch, manifest.patches)}`,
        '--scan-files'
      );
    }

    const patchFiles = filesByPatch.get(patch.filename) ?? new Set<string>();
    filesByPatch.set(patch.filename, patchFiles);
    for (const rawFile of assignment.files) {
      const file = normalizeEngineRelativeInput(rawFile, '--scan-files');
      const previousOwner = ownerByFile.get(file);
      if (previousOwner !== undefined && previousOwner !== patch.filename) {
        throw new InvalidArgumentError(
          `--scan-files path is assigned to more than one patch: ${file} (${previousOwner}, ${patch.filename})`,
          '--scan-files'
        );
      }
      ownerByFile.set(file, patch.filename);
      patchFiles.add(file);
    }
  }

  return new Map(
    [...filesByPatch.entries()].map(([patchFilename, files]) => [patchFilename, [...files].sort()])
  );
}

/**
 * Fingerprints every piece of state a `re-export --dry-run` promises not to
 * disturb: the engine's commit + working-tree status (via the same generation
 * token `fireforge test` uses) and the byte content of every regular file
 * under `patches/` — ALL of them, not just the selected patches, because the
 * field incident was a dry-run of patch B reverting a just-written
 * export of patch A. A missing patches directory (ENOENT/ENOTDIR) fingerprints
 * as empty — there is nothing there to protect — but any other listing failure
 * (EACCES, EIO, …) throws: an unreadable directory is not evidence it is
 * empty, and treating it as such would let the guard silently vouch for state
 * it never saw (fail closed). The same rule covers an unmeasurable engine
 * generation and an unreadable individual patch file; a before-pass failure
 * aborts the dry run before it starts, since a guard that measured nothing
 * cannot vouch for anything.
 */
async function fingerprintDryRunState(
  engineDir: string,
  patchesDir: string
): Promise<Map<string, string>> {
  const fingerprint = new Map<string, string>();
  const generation = await snapshotEngineGeneration(engineDir);
  if (isUnavailableGenerationToken(generation)) {
    // A failed probe measured nothing — hashing the failure token would let
    // two identical failures compare "unchanged" (vouching for unmeasured
    // state) and two differing messages report a spurious violation.
    throw new GeneralError(
      `[dry-run] cannot fingerprint the engine working tree for the purity guard: ` +
        unavailableGenerationReason(generation)
    );
  }
  fingerprint.set('the engine working tree', createHash('sha256').update(generation).digest('hex'));
  let names: string[] = [];
  try {
    const entries = await readdir(patchesDir, { withFileTypes: true });
    names = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch (error: unknown) {
    // No patches directory — nothing there to protect; the same condition on
    // the post-run pass produces the same empty set, and a directory that
    // appears mid-dry-run correctly reports as a violation. Any OTHER failure
    // must not read as "empty": the guard would be vouching for state it
    // never saw.
    const code = getNodeErrorCode(error);
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      throw new GeneralError(
        `[dry-run] cannot fingerprint ${patchesDir} for the purity guard: ${toError(error).message}`,
        error
      );
    }
  }
  // Bounded pool over the per-file hashing (28 MB of patch
  // bodies were read strictly serially, twice per dry run). Workers never
  // throw — each returns a discriminated result, and error selection
  // happens in the ordered pass below so the refusal deterministically
  // names the FIRST failing file in sorted order, exactly as the serial
  // loop did. The guard's semantics are untouched: whole-queue scope,
  // fresh measurement on both passes, fail closed on any non-ENOENT read.
  type PatchHashResult = { hash: string } | { vanished: true } | { error: unknown };
  const results = await mapWithConcurrency(
    names,
    PATCH_HASH_CONCURRENCY,
    async (name): Promise<PatchHashResult> => {
      try {
        return {
          hash: createHash('sha256')
            .update(await readFile(join(patchesDir, name)))
            .digest('hex'),
        };
      } catch (error: unknown) {
        // A file that vanished between the listing and the read is omitted, so
        // a dry run that DELETED a patch artifact reports as the violation it
        // is (key present before, absent after) instead of hiding behind a
        // fingerprinting error. Every other failure fails closed: a constant
        // placeholder would make unreadable-before equal unreadable-after even
        // when the bytes changed underneath.
        const code = getNodeErrorCode(error);
        if (code === 'ENOENT' || code === 'ENOTDIR') return { vanished: true };
        return { error };
      }
    }
  );
  for (const [index, name] of names.entries()) {
    const result = results[index];
    if (result === undefined) continue;
    if ('error' in result) {
      throw new GeneralError(
        `[dry-run] cannot fingerprint ${join(patchesDir, name)} for the purity guard: ${toError(result.error).message}`,
        result.error
      );
    }
    if ('vanished' in result) continue;
    fingerprint.set(`patches/${name}`, result.hash);
  }
  return fingerprint;
}

/**
 * Runtime enforcement of the dry-run purity contract: fingerprints
 * the engine tree and every patch artifact before and after `operation`, and
 * throws when a dry-run changed anything it promised only to inspect. This
 * turns any recurrence of the 0.40.0 "dry-run reverted a just-written export"
 * incident into a hard, named failure instead of silent data loss discovered
 * only when a later gate fails. The post-fingerprint runs whether `operation`
 * resolves or rejects — a dry-run that mutates state and THEN fails is exactly
 * the case where a rollback defect must not go unreported; a rejection with a
 * purity violation surfaces the violation with the original error as `cause`.
 * No-op outside dry-run.
 */
export async function withDryRunPurityGuard<T>(
  engineDir: string,
  patchesDir: string,
  isDryRun: boolean,
  operation: () => Promise<T>
): Promise<T> {
  if (!isDryRun) return operation();
  const before = await fingerprintDryRunState(engineDir, patchesDir);
  let result: T | undefined;
  let operationError: unknown;
  let failed = false;
  try {
    result = await operation();
  } catch (error: unknown) {
    failed = true;
    operationError = error;
  }
  let after: Map<string, string>;
  try {
    after = await fingerprintDryRunState(engineDir, patchesDir);
  } catch (fingerprintError: unknown) {
    // The post-run fingerprint failing must not swallow the dry run's own
    // failure — an operation that mutated state, broke it, AND made it
    // unreadable is exactly the case where both facts matter. The combined
    // message carries both; the operation error stays the `cause`.
    if (failed) {
      throw new GeneralError(
        `[dry-run] this dry run failed (${toError(operationError).message}), and its purity could ` +
          `not be verified afterwards: ${toError(fingerprintError).message}. Inspect engine/ and ` +
          'your patches/ diff before trusting them.',
        operationError
      );
    }
    throw fingerprintError;
  }
  const touched = [...new Set([...before.keys(), ...after.keys()])]
    .sort()
    .filter((key) => before.get(key) !== after.get(key));
  if (touched.length > 0) {
    throw new GeneralError(
      `[dry-run] invariant violated: this dry run modified ${touched.join(', ')}. ` +
        'This is a FireForge bug — please report it, and inspect the listed state ' +
        '(e.g. `git status` in engine/ and your patches/ diff) before trusting it.' +
        (failed ? ` The dry run also failed: ${toError(operationError).message}` : ''),
      operationError
    );
  }
  if (failed) throw operationError;
  return result as T;
}

/** Serializes dry-run re-export git inspection against the same project tree. */
export async function withDryRunReExportLock<T>(
  fireforgeDir: string,
  isDryRun: boolean,
  operation: () => Promise<T>
): Promise<T> {
  if (!isDryRun) return operation();
  const lockPath = createSiblingLockPath(join(fireforgeDir, 're-export-dry-run'), '.lock');
  return withFileLock(lockPath, operation, {
    timeoutMs: 24 * 60 * 60 * 1000,
    onTimeoutMessage:
      `Timed out waiting for the FireForge re-export dry-run lock at ${lockPath}. ` +
      'If no other `fireforge re-export --dry-run` is running, remove the lock directory and retry.',
    onStaleLockMessage: (ageMs) =>
      `Removing stale FireForge re-export dry-run lock (age: ${Math.round(ageMs / 1000)}s). A previous dry-run process may have crashed.`,
  });
}
