// SPDX-License-Identifier: EUPL-1.2
/**
 * `test --build/--build-only --extend-coverage` (FORGE L1): unions the
 * requested paths into the recorded `testPackagingCoverage` instead of
 * replacing it, under an anchor guard.
 *
 * Coverage REPLACES by default for a documented reason
 * (`build-baseline-types.ts`): every baseline write refreshes
 * `packageableFingerprints` for ALL dirty packageable paths, so a blind
 * union would whitewash an earlier scope's edited fixtures while
 * `obj-*`/`_tests/` still holds that scope's stale staging. Extending is
 * honest only while everything the PREVIOUS record vouched for is still
 * true, which is what {@link checkExtendCoverageAnchor} and
 * {@link checkExtendMozconfigAnchor} verify:
 *
 *   1. engine HEAD is unchanged — every committed edit is excluded;
 *   2. every path the previous baseline fingerprinted still hashes to the
 *      recorded digest — the earlier scope's staging inputs are byte-identical.
 *      Files that became dirty SINCE that build are fine: the current
 *      whole-tree `mach build faster` repackages `dist/` and vouches for them;
 *   3. the generated `engine/mozconfig` is unchanged. Engine HEAD does not
 *      cover this — the mozconfig is regenerated from project-side
 *      `configs/*.mozconfig` templates plus `fireforge.json` on every build,
 *      so two builds at the same engine SHA can configure differently.
 *
 * Every failure refuses fail-closed; the operator's remedy is always a plain
 * scoped build, which resets the claim to the paths it actually vouches for.
 *
 * Known boundary, documented rather than closed: dirty NON-packageable
 * fixtures under previously covered paths (plain test files, manifests
 * `isPackageablePath` rejects) are invisible to check 2. Editing one
 * uncommitted between two builds leaves the earlier scope's `_tests/`
 * staging stale while extend still vouches for it. Plain REPLACE has no
 * such window, because the earlier scope simply stops being covered.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getNodeErrorCode, toError } from '../utils/errors.js';
import { verbose } from '../utils/logger.js';
import {
  type BuildBaseline,
  DELETED_FILE_FINGERPRINT,
  type TestPackagingCoverage,
} from './build-baseline-types.js';
import { getHead, isMissingHeadError } from './git.js';

/** Filename of the generated mozconfig, relative to the engine directory. */
const MOZCONFIG_FILENAME = 'mozconfig';

/** How many diverged paths a refusal names before truncating. */
const MAX_DIVERGED_REPORTED = 5;
/** Why `--extend-coverage` could not union onto the recorded claim. */
export type ExtendAnchorReason =
  | 'no-baseline'
  | 'no-fingerprints'
  | 'no-mozconfig-hash'
  | 'head-moved'
  | 'fingerprint-diverged'
  | 'mozconfig-changed';

/** Outcome of an anchor check: either extend is sound, or it is refused. */
export type ExtendAnchorResult =
  { ok: true } | { ok: false; reason: ExtendAnchorReason; detail: string[] };

/**
 * Verifies the parts of the anchor knowable before the build runs: a usable
 * previous baseline, an unchanged engine HEAD, and byte-identical content
 * for every path that baseline fingerprinted.
 * @param engineDir - Path to the engine directory
 * @param previousBaseline - Baseline recorded by the previous build
 */
export async function checkExtendCoverageAnchor(
  engineDir: string,
  previousBaseline: BuildBaseline | undefined
): Promise<ExtendAnchorResult> {
  if (previousBaseline === undefined) {
    return { ok: false, reason: 'no-baseline', detail: [] };
  }
  if (previousBaseline.mozconfigHash === undefined) {
    return { ok: false, reason: 'no-mozconfig-hash', detail: [] };
  }
  const recordedFingerprints = previousBaseline.packageableFingerprints;
  if (recordedFingerprints === undefined) {
    return { ok: false, reason: 'no-fingerprints', detail: [] };
  }

  const currentHead = await readEngineHead(engineDir);
  if (currentHead === undefined || previousBaseline.engineHeadSha === '') {
    // An unborn or unreadable HEAD gives nothing to anchor to.
    return { ok: false, reason: 'head-moved', detail: [] };
  }
  if (currentHead !== previousBaseline.engineHeadSha) {
    return {
      ok: false,
      reason: 'head-moved',
      detail: [`recorded ${previousBaseline.engineHeadSha}`, `current ${currentHead}`],
    };
  }

  const diverged: string[] = [];
  for (const [relPath, recordedHash] of Object.entries(recordedFingerprints)) {
    const liveHash = await hashEngineFile(engineDir, relPath);
    if (liveHash !== recordedHash) diverged.push(relPath);
  }
  if (diverged.length > 0) {
    return { ok: false, reason: 'fingerprint-diverged', detail: diverged.sort() };
  }

  return { ok: true };
}

/**
 * Verifies the mozconfig half of the anchor. Split from
 * {@link checkExtendCoverageAnchor} because it can only run AFTER
 * `prepareBuildEnvironment` regenerates `engine/mozconfig` — that file is
 * the one this build will configure with — and must still run BEFORE mach,
 * so a refusal costs no build time.
 * @param engineDir - Path to the engine directory
 * @param previousBaseline - Baseline recorded by the previous build
 */
export async function checkExtendMozconfigAnchor(
  engineDir: string,
  previousBaseline: BuildBaseline | undefined
): Promise<ExtendAnchorResult> {
  const recorded = previousBaseline?.mozconfigHash;
  if (recorded === undefined) {
    return { ok: false, reason: 'no-mozconfig-hash', detail: [] };
  }
  const live = await hashEngineFile(engineDir, MOZCONFIG_FILENAME);
  if (live === undefined || live !== recorded) {
    return { ok: false, reason: 'mozconfig-changed', detail: [] };
  }
  return { ok: true };
}

/**
 * Unions the newly built paths onto the recorded claim. A `'full'` claim
 * (or a pre-0.37.0 absent one, which means full historically) stays
 * `'full'` — it already covers everything.
 * @param previous - Coverage recorded by the previous build
 * @param requested - Normalized request paths this build packaged
 */
export function unionTestPackagingCoverage(
  previous: TestPackagingCoverage | undefined,
  requested: readonly string[]
): TestPackagingCoverage {
  if (previous === undefined || previous === 'full') {
    return 'full';
  }
  return [...new Set([...previous, ...requested])].sort();
}

/**
 * Renders the fail-closed refusal for an anchor check that did not pass.
 * Kept separate from the probes so tests can assert the structured result
 * without matching copy.
 * @param result - Failing result from an anchor check
 */
export function formatExtendCoverageRefusal(result: {
  reason: ExtendAnchorReason;
  detail: string[];
}): string {
  const remedy =
    'Re-run without --extend-coverage: a plain scoped build REPLACES the coverage claim ' +
    'with the paths it actually vouches for.';
  switch (result.reason) {
    case 'no-baseline':
      return `--extend-coverage has nothing to extend: no previous build baseline is recorded. ${remedy}`;
    case 'no-mozconfig-hash':
      return (
        '--extend-coverage refused: the recorded baseline predates the mozconfig anchor, so it ' +
        `cannot be proven that this build configures identically. ${remedy}`
      );
    case 'no-fingerprints':
      return (
        '--extend-coverage refused: the recorded baseline carries no packageable fingerprints, so ' +
        `the earlier scope's staging inputs cannot be verified unchanged. ${remedy}`
      );
    case 'head-moved':
      return (
        '--extend-coverage refused: engine HEAD moved since the recorded build ' +
        `(${result.detail.join(', ') || 'no usable HEAD'}), so the earlier scope's packaging is no ` +
        `longer anchored. ${remedy}`
      );
    case 'fingerprint-diverged':
      return (
        '--extend-coverage refused: ' +
        `${String(result.detail.length)} packageable file(s) the recorded build staged have changed ` +
        `since (${formatDivergedPaths(result.detail)}). Extending would vouch for the earlier scope ` +
        `while obj-*/_tests/ still holds its stale staging. ${remedy}`
      );
    case 'mozconfig-changed':
      return (
        '--extend-coverage refused: engine/mozconfig differs from the recorded build (it is ' +
        'regenerated from configs/*.mozconfig and fireforge.json on every build, so engine HEAD ' +
        `does not cover it). ${remedy}`
      );
  }
}

function formatDivergedPaths(paths: readonly string[]): string {
  const head = paths.slice(0, MAX_DIVERGED_REPORTED).join(', ');
  const extra = paths.length - Math.min(paths.length, MAX_DIVERGED_REPORTED);
  return extra > 0 ? `${head}, … (+${String(extra)} more)` : head;
}

/**
 * Hex-encoded SHA-256 of an engine-relative file, matching the digest the
 * baseline writer produces. `undefined` on any IO error, which every caller
 * treats as "cannot prove unchanged" — i.e. a refusal.
 * @param engineDir - Path to the engine directory
 * @param relPath - Engine-relative POSIX path
 */
export async function hashEngineFile(
  engineDir: string,
  relPath: string
): Promise<string | undefined> {
  try {
    const buffer = await readFile(join(engineDir, relPath));
    return createHash('sha256').update(buffer).digest('hex');
  } catch (error: unknown) {
    if (getNodeErrorCode(error) === 'ENOENT') {
      return DELETED_FILE_FINGERPRINT;
    }
    verbose(`Extend-coverage anchor: could not hash ${relPath} — ${toError(error).message}`);
    return undefined;
  }
}

async function readEngineHead(engineDir: string): Promise<string | undefined> {
  try {
    return await getHead(engineDir);
  } catch (error: unknown) {
    if (isMissingHeadError(error)) return undefined;
    throw error;
  }
}
