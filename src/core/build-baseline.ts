// SPDX-License-Identifier: EUPL-1.2
/**
 * Persists a marker describing the state of the engine tree at the time of
 * the last successful `fireforge build`. Two downstream consumers share this
 * marker:
 *
 *   - `build-audit`: after a build succeeds, compare engine files touched
 *     since the baseline against the dist bundle to flag silent
 *     packaging drops (e.g. a pref file never registered in moz.build).
 *   - `build-prepare`: before a build starts, detect whether any
 *     `moz.build` / `moz.configure` / `Makefile.in` changed since the
 *     baseline and run `mach configure` before the build step so the
 *     recursive-make backend isn't stale.
 *
 * The marker lives under `.fireforge/last-build.json`. It is written only
 * on successful build completion. A failed build does not update it, so a
 * subsequent run still audits against the last known-good tree.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PreflightRefusalError } from '../errors/base.js';
import { mapWithConcurrency } from '../utils/concurrency.js';
import { getNodeErrorCode, toError } from '../utils/errors.js';
import { readJson, writeJson } from '../utils/fs.js';
import { sha256Hex } from '../utils/hash.js';
import { verbose } from '../utils/logger.js';
import {
  isBuildInputPath,
  isJarManifestPath,
  isPackageablePath,
  isXpcomManifestPath,
} from './build-audit.js';
import {
  type BaselineRecorder,
  type BuildBaseline,
  type ControlBuildStamp,
  type CoverageAnchor,
  type CoverageRecord,
  DELETED_FILE_FINGERPRINT,
  type StaticComponentsBaseline,
  type TestPackagingCoverage,
} from './build-baseline-types.js';
import {
  type BuildBaselineProblem,
  describeBuildBaselineProblem,
  findBuildBaselineProblem,
  isCoverageProblem,
} from './build-baseline-validate.js';
import { FIREFORGE_DIR } from './config-paths.js';
import { hashEngineFile } from './coverage-extend.js';
import { readEngineInventory } from './engine-state.js';
import { getHead, isMissingHeadError } from './git.js';
import { historyRecordIdentity } from './history-log-file.js';

/*
 * Keep the IO fan-out bounded: a patched Firefox checkout can carry hundreds
 * of dirty packageable paths and serial reads add directly to every build.
 */
const FINGERPRINT_IO_CONCURRENCY = 16;

/**
 * Which mach build produced the baseline being written. Decides whether
 * the `jar.mn` half of {@link BuildBaseline.buildInputFingerprints} is
 * refreshed (`'full'`) or carried forward from the previous record
 * (`'faster'`). `fireforge build --ui` and a non-escalated `test --build`
 * are `'faster'`. `fireforge build` and an escalated `test --build` are
 * `'full'`.
 */
export type BaselineBuildKind = 'full' | 'faster';

/** Name of the last-build marker file under `.fireforge/`. */
const BUILD_BASELINE_FILENAME = 'last-build.json';

/**
 * Resolves the on-disk path of the build baseline marker.
 * @param projectRoot - Root directory of the project
 * @returns Absolute path of the marker file
 */
export function getBuildBaselinePath(projectRoot: string): string {
  return join(projectRoot, FIREFORGE_DIR, BUILD_BASELINE_FILENAME);
}

/**
 * Reads the last-build baseline if present. Returns undefined when no
 * previous successful build has been recorded. Builds can replace invalid
 * markers; dispatch preflights pass `refuse` so invalid coverage never
 * becomes the implicit full claim of a baseline without coverage.
 * @param projectRoot - Root directory of the project
 */
export async function readBuildBaseline(
  projectRoot: string,
  invalid: 'ignore' | 'refuse' = 'ignore'
): Promise<BuildBaseline | undefined> {
  const path = getBuildBaselinePath(projectRoot);
  let problem: BuildBaselineProblem | undefined;
  try {
    const value = await readJson<unknown>(path);
    problem = findBuildBaselineProblem(value);
    if (problem !== undefined) {
      throw new Error(`invalid baseline field ${describeBuildBaselineProblem(problem)}`);
    }
    return value as BuildBaseline;
  } catch (error: unknown) {
    if (getNodeErrorCode(error) === 'ENOENT') return undefined;
    if (invalid === 'refuse') {
      // A coverage field is what a scoped `test --build` writes, so a fresh
      // scoped build over the requested paths replaces it as well as a full
      // one does.
      const remedy =
        problem !== undefined && isCoverageProblem(problem)
          ? 'The field is part of the packaging-coverage claim a scoped "fireforge test --build" records. Rerun this test with --build to record a fresh claim for its paths, or run "fireforge build" to record a full baseline.'
          : 'Run "fireforge build" to record a fresh baseline before dispatching tests.';
      throw new PreflightRefusalError(
        `Build baseline ${path} is invalid: ${toError(error).message}. ${remedy}`,
        'invalid-build-baseline'
      );
    }
    verbose(`Ignoring invalid build baseline ${path}: ${toError(error).message}`);
    return undefined;
  }
}

export interface WriteBuildBaselineOptions {
  /** Root directory of the project. */
  projectRoot: string;
  /** Path to the engine directory. */
  engineDir: string;
  /** Current `binaryName` from fireforge.json. */
  binaryName: string;
  /**
   * Coverage claim of the packaged test runtime this build produced
   * (`'full'`, or the scoped request paths of a `test --build` invocation).
   * Omitted → field left off the marker.
   */
  testPackagingCoverage?: TestPackagingCoverage | undefined;
  /** Per-path anchors of a scoped claim. Omitted → field left off the marker. */
  testCoverageRecords?: Record<string, CoverageRecord> | undefined;
  /** Carried full-build anchor of a narrowed claim. Omitted → field left off. */
  fullCoverageAnchor?: CoverageAnchor | undefined;
  /**
   * The baseline this write replaces, when the caller has it. A scoped
   * (non-`'full'`) write carries its `staticComponentsBaseline` forward
   * verbatim, because `mach build faster` does not rebake `components.conf`
   * registrations, so the last full build stays the anchor for the
   * compiled StaticComponents table.
   */
  previousBaseline?: BuildBaseline | undefined;
  /** Invocation shape that produced this baseline. */
  recordedBy?: string | undefined;
  /**
   * `'auto'` (default) refreshes the static-components anchor whenever the
   * coverage claim is `'full'` or absent. `'refresh'` records it even for a
   * scoped coverage claim whose implementation escalated to a full build.
   * `'carry-forward'` always keeps the previous anchor: needed by
   * `--extend-coverage`, whose union can evaluate to `'full'` while the
   * build that produced it was still a scoped `mach build faster` that did
   * not rebake the compiled table.
   */
  staticComponentsHandling?: 'auto' | 'refresh' | 'carry-forward' | undefined;
  /**
   * Which mach build produced this baseline (default `'full'`). A
   * `'faster'` write carries the previous record's `jar.mn` fingerprints
   * forward instead of refreshing them. See
   * {@link BuildBaseline.buildInputFingerprints}. Every caller that ran
   * `mach build faster` must say so, or the next pre-test build skips an
   * escalation no full build has honoured.
   */
  buildKind?: BaselineBuildKind | undefined;
  /**
   * Stamp for a build that compiled a negative control into the binary.
   * Omitted → field left off, which is how every other build clears it.
   * See {@link BuildBaseline.controlBuild}.
   */
  controlBuild?: ControlBuildStamp | undefined;
}

/** This process's {@link BuildBaseline.recorder} stamp. */
function baselineRecorder(): BaselineRecorder {
  const { pid, invocationId, sessionId } = historyRecordIdentity();
  return { pid, invocationId, ...(sessionId !== undefined ? { sessionId } : {}) };
}

/**
 * Records a successful build by writing a fresh baseline marker. Captures
 * engine HEAD SHA (or an empty string when the engine has no HEAD yet) and
 * the current binaryName. Caller is responsible for only invoking this
 * after the build exit code was zero.
 *
 * @param options - See {@link WriteBuildBaselineOptions}
 */
export async function writeBuildBaseline(options: WriteBuildBaselineOptions): Promise<void> {
  const {
    projectRoot,
    engineDir,
    binaryName,
    testPackagingCoverage,
    testCoverageRecords,
    fullCoverageAnchor,
    previousBaseline,
    recordedBy,
    staticComponentsHandling = 'auto',
    buildKind = 'full',
    controlBuild,
  } = options;
  let engineHeadSha = '';
  try {
    engineHeadSha = await getHead(engineDir);
  } catch (error: unknown) {
    // Engine may be an unborn branch (freshly cloned + reset, or
    // mid-import). Record an empty SHA and let downstream fall back to "no
    // prior state" behavior. Any other git failure is bubbled up, because
    // we don't want to silently write a garbage marker.
    if (!isMissingHeadError(error)) {
      throw error;
    }
  }

  const dirty = await hashDirtyEngineFiles(engineDir);
  const packageableFingerprints = selectFingerprints(dirty, isPackageablePath);
  const testInputFingerprints = selectFingerprints(dirty, () => true);
  const buildInputFingerprints = recordBuildInputFingerprints(dirty, previousBaseline, buildKind);

  // A full-coverage write (and a no-claim `fireforge build` record)
  // just recompiled the StaticComponents table, so it anchors the table to
  // the current engine state. A scoped write did not, so carry the previous
  // anchor forward verbatim.
  const staticComponentsBaseline =
    staticComponentsHandling === 'refresh' ||
    (staticComponentsHandling === 'auto' &&
      (testPackagingCoverage === undefined || testPackagingCoverage === 'full'))
      ? recordStaticComponentsBaseline(dirty, engineHeadSha)
      : previousBaseline?.staticComponentsBaseline;

  const mozconfigHash = await hashEngineFile(engineDir, 'mozconfig');

  const baseline: BuildBaseline = {
    buildKind,
    engineHeadSha,
    builtAt: new Date().toISOString(),
    binaryName,
    ...(packageableFingerprints !== undefined ? { packageableFingerprints } : {}),
    ...(testInputFingerprints !== undefined ? { testInputFingerprints } : {}),
    ...(buildInputFingerprints !== undefined ? { buildInputFingerprints } : {}),
    ...(testPackagingCoverage !== undefined ? { testPackagingCoverage } : {}),
    ...(testCoverageRecords !== undefined ? { testCoverageRecords } : {}),
    ...(fullCoverageAnchor !== undefined ? { fullCoverageAnchor } : {}),
    ...(mozconfigHash !== undefined ? { mozconfigHash } : {}),
    ...(staticComponentsBaseline !== undefined ? { staticComponentsBaseline } : {}),
    ...(recordedBy !== undefined ? { recordedBy } : {}),
    recorder: baselineRecorder(),
    ...(controlBuild !== undefined ? { controlBuild } : {}),
  };
  await writeJson(getBuildBaselinePath(projectRoot), baseline);
}

/**
 * The hash of every dirty engine file (modified against HEAD or untracked), or
 * undefined when git cannot enumerate them. A path whose content could not be
 * read maps to undefined. The record kinds below are selections of this one
 * pass.
 *
 * The stale-build preflight (`checkStaleBuildForTest`) compares a live hash to
 * the baseline's entry: a match means the build already saw this exact content,
 * a differing or absent one means the file is genuinely stale.
 */
async function hashDirtyEngineFiles(
  engineDir: string
): Promise<ReadonlyMap<string, string | undefined> | undefined> {
  let paths: readonly string[];
  try {
    ({ paths } = await readEngineInventory(engineDir));
  } catch (error: unknown) {
    verbose(`Build baseline: dirty-file probe failed — ${toError(error).message}`);
    return undefined;
  }
  const entries = await mapWithConcurrency(paths, FINGERPRINT_IO_CONCURRENCY, async (relPath) => {
    try {
      return [relPath, sha256Hex(await readFile(join(engineDir, relPath)))] as const;
    } catch (fileError: unknown) {
      // A path git reported but absent on disk is normally a tracked deletion.
      // The tombstone lets the next stale check prove it was already built.
      if (getNodeErrorCode(fileError) === 'ENOENT') {
        return [relPath, DELETED_FILE_FINGERPRINT] as const;
      }
      verbose(`Build baseline: cannot fingerprint ${relPath} — ${toError(fileError).message}`);
      return [relPath, undefined] as const;
    }
  });
  return new Map(entries);
}

/**
 * The fingerprints of the dirty paths `includePath` accepts. Undefined when the
 * probe failed or one of those files was unreadable: an incomplete record cannot
 * prove anything unchanged, and a broken probe must never write `{}`, so the
 * field is omitted and consumers fall back to their path-only comparison.
 */
function selectFingerprints(
  dirty: ReadonlyMap<string, string | undefined> | undefined,
  includePath: (path: string) => boolean
): Record<string, string> | undefined {
  if (dirty === undefined) return undefined;
  const fingerprints: Record<string, string> = {};
  for (const [path, hash] of dirty) {
    if (!includePath(path)) continue;
    if (hash === undefined) return undefined;
    fingerprints[path] = hash;
  }
  return fingerprints;
}

/**
 * Content fingerprints of the dirty build-input manifests
 * ({@link isBuildInputPath}) this build consumed. Backend inputs (`moz.build` &
 * co) are always taken from the live tree: the auto-configure preflight
 * reconfigured against them before this build ran. `jar.mn` entries are taken
 * from the live tree only after a full build. A `faster` write carries the
 * previous record's `jar.mn` entries forward verbatim, because `mach build
 * faster` is the build the `jar.mn` escalation exists to bypass, and recording a
 * `jar.mn` it did not install would silence the next escalation.
 */
function recordBuildInputFingerprints(
  dirty: ReadonlyMap<string, string | undefined> | undefined,
  previousBaseline: BuildBaseline | undefined,
  buildKind: BaselineBuildKind
): Record<string, string> | undefined {
  const live = selectFingerprints(dirty, isBuildInputPath);
  if (live === undefined || buildKind === 'full') return live;
  const fingerprints: Record<string, string> = {};
  for (const [path, hash] of Object.entries(live)) {
    if (!isJarManifestPath(path)) fingerprints[path] = hash;
  }
  for (const [path, hash] of Object.entries(previousBaseline?.buildInputFingerprints ?? {})) {
    if (isJarManifestPath(path)) fingerprints[path] = hash;
  }
  return fingerprints;
}

/**
 * Anchor for the compiled StaticComponents table: the engine HEAD SHA of this
 * (full) build plus the fingerprints of the `components.conf` manifests dirty
 * right now. Undefined on a failed probe, which omits the field (the
 * static-components stale check then degrades to "fresh") rather than anchoring
 * to a garbage record.
 */
function recordStaticComponentsBaseline(
  dirty: ReadonlyMap<string, string | undefined> | undefined,
  engineHeadSha: string
): StaticComponentsBaseline | undefined {
  const fingerprints = selectFingerprints(dirty, isXpcomManifestPath);
  return fingerprints === undefined ? undefined : { engineHeadSha, fingerprints };
}
