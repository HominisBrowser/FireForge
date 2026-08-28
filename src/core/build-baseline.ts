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
 * on successful build completion; a failed build does not update it, so a
 * subsequent run still audits against the last known-good tree.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { mapWithConcurrency } from '../utils/concurrency.js';
import { getNodeErrorCode, toError } from '../utils/errors.js';
import { pathExists, readJson, writeJson } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';
import {
  isBuildInputPath,
  isJarManifestPath,
  isPackageablePath,
  isXpcomManifestPath,
} from './build-audit.js';
import {
  type BuildBaseline,
  DELETED_FILE_FINGERPRINT,
  type StaticComponentsBaseline,
  type TestPackagingCoverage,
} from './build-baseline-types.js';
import { FIREFORGE_DIR } from './config-paths.js';
import { hashEngineFile } from './coverage-extend.js';
import { getHead, hasChanges, isMissingHeadError } from './git.js';
import { git } from './git-base.js';
import { getUntrackedFiles } from './git-status.js';

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
 * are `'faster'`; `fireforge build` and an escalated `test --build` are
 * `'full'`.
 */
export type BaselineBuildKind = 'full' | 'faster';

/** Name of the last-build marker file under `.fireforge/`. */
export const BUILD_BASELINE_FILENAME = 'last-build.json';

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
 * previous successful build has been recorded — callers must tolerate that
 * path (first build, cleaned workspace).
 * @param projectRoot - Root directory of the project
 */
export async function readBuildBaseline(projectRoot: string): Promise<BuildBaseline | undefined> {
  const path = getBuildBaselinePath(projectRoot);
  if (!(await pathExists(path))) {
    return undefined;
  }
  try {
    return await readJson<BuildBaseline>(path);
  } catch {
    // A corrupt marker is equivalent to no marker — the audit/auto-configure
    // will treat it as "first build" rather than block on the inconsistency.
    return undefined;
  }
}

/**
 * Records a successful build by writing a fresh baseline marker. Captures
 * engine HEAD SHA (or an empty string when the engine has no HEAD yet) and
 * the current binaryName. Caller is responsible for only invoking this
 * after the build exit code was zero.
 *
 * @param projectRoot - Root directory of the project
 * @param engineDir - Path to the engine directory
 * @param binaryName - Current `binaryName` from fireforge.json
 * @param testPackagingCoverage - Coverage claim of the packaged test
 *   runtime this build produced (`'full'`, or the scoped request paths of
 *   a `test --build` invocation). Omitted → field left off the marker.
 * @param previousBaseline - The baseline this write replaces, when the
 *   caller has it. A scoped (non-`'full'`) write carries its
 *   `staticComponentsBaseline` forward verbatim — `mach build faster`
 *   does not rebake `components.conf` registrations, so the last FULL
 *   build stays the honest anchor for the compiled StaticComponents table.
 * @param recordedBy - Invocation shape that produced this baseline.
 * @param staticComponentsHandling - `'auto'` (default) refreshes the
 *   static-components anchor whenever the coverage claim is `'full'` or
 *   absent. `'refresh'` records it even for a scoped coverage claim whose
 *   implementation escalated to a full build. `'carry-forward'` always
 *   keeps the previous anchor: needed by `--extend-coverage`, whose union
 *   can EVALUATE to `'full'` while the build that produced it was still a
 *   scoped `mach build faster` that did not rebake the compiled table.
 * @param buildKind - Which mach build produced this baseline (default
 *   `'full'`). A `'faster'` write carries the previous record's `jar.mn`
 *   fingerprints forward instead of refreshing them — see
 *   {@link BuildBaseline.buildInputFingerprints}. Every caller that ran
 *   `mach build faster` MUST say so, or the next pre-test build skips an
 *   escalation no full build has honoured.
 */
export async function writeBuildBaseline(
  projectRoot: string,
  engineDir: string,
  binaryName: string,
  testPackagingCoverage?: TestPackagingCoverage,
  previousBaseline?: BuildBaseline,
  recordedBy?: string,
  staticComponentsHandling: 'auto' | 'refresh' | 'carry-forward' = 'auto',
  buildKind: BaselineBuildKind = 'full'
): Promise<void> {
  let engineHeadSha = '';
  try {
    engineHeadSha = await getHead(engineDir);
  } catch (error: unknown) {
    // Engine may be an unborn branch (freshly cloned + reset, or mid-import)
    // — record an empty SHA and let downstream fall back to "no prior state"
    // behavior. Any other git failure is bubbled up; we don't want to
    // silently write a garbage marker.
    if (!isMissingHeadError(error)) {
      throw error;
    }
  }

  const packageableFingerprints = await collectPackageableFingerprints(engineDir);
  const buildInputFingerprints = await collectBuildInputFingerprints(
    engineDir,
    previousBaseline,
    buildKind
  );

  // A full-coverage write (and the legacy no-claim `fireforge build` shape)
  // just recompiled the StaticComponents table, so it anchors the table to
  // the current engine state. A scoped write did not — carry the previous
  // anchor forward verbatim.
  const staticComponentsBaseline =
    staticComponentsHandling === 'refresh' ||
    (staticComponentsHandling === 'auto' &&
      (testPackagingCoverage === undefined || testPackagingCoverage === 'full'))
      ? await collectStaticComponentsBaseline(engineDir, engineHeadSha)
      : previousBaseline?.staticComponentsBaseline;

  const mozconfigHash = await hashEngineFile(engineDir, 'mozconfig');

  const baseline: BuildBaseline = {
    engineHeadSha,
    builtAt: new Date().toISOString(),
    binaryName,
    ...(packageableFingerprints !== undefined ? { packageableFingerprints } : {}),
    ...(buildInputFingerprints !== undefined ? { buildInputFingerprints } : {}),
    ...(testPackagingCoverage !== undefined ? { testPackagingCoverage } : {}),
    ...(mozconfigHash !== undefined ? { mozconfigHash } : {}),
    ...(staticComponentsBaseline !== undefined ? { staticComponentsBaseline } : {}),
    ...(recordedBy !== undefined ? { recordedBy } : {}),
  };
  await writeJson(getBuildBaselinePath(projectRoot), baseline);
}

/**
 * Reads the current engine workdir and computes a SHA-256 fingerprint for
 * every packageable path that is either modified against HEAD or untracked.
 * The stale-build preflight (`checkStaleBuildForTest`) compares the live
 * fingerprint for each packageable-dirty file to the baseline's entry: a
 * matching hash means the build already saw this exact content, a differing
 * or new one means the file is genuinely stale.
 *
 * Returns `undefined` on any git failure so a broken probe never corrupts
 * the on-disk baseline with `{}`; the stale-check then falls back to a
 * path-only comparison.
 */
async function collectPackageableFingerprints(
  engineDir: string
): Promise<Record<string, string> | undefined> {
  return collectDirtyFingerprints(engineDir, isPackageablePath, 'packageable fingerprint');
}

/**
 * Content fingerprints of the dirty build-input manifests
 * ({@link isBuildInputPath}) this build consumed. Backend inputs
 * (`moz.build` & co) are always taken from the live tree: the
 * auto-configure preflight reconfigured against them before this build
 * ran. `jar.mn` entries are taken from the live tree only after a FULL
 * build; a `faster` write carries the previous record's `jar.mn` entries
 * forward verbatim, because `mach build faster` is exactly the build the
 * `jar.mn` escalation exists to bypass, and recording a `jar.mn` it did
 * not install would silence the next escalation. Returns `undefined` on
 * probe failure so the field is omitted rather than written as `{}`.
 */
async function collectBuildInputFingerprints(
  engineDir: string,
  previousBaseline: BuildBaseline | undefined,
  buildKind: BaselineBuildKind
): Promise<Record<string, string> | undefined> {
  const live = await collectDirtyFingerprints(
    engineDir,
    isBuildInputPath,
    'build-input fingerprint'
  );
  if (live === undefined || buildKind === 'full') {
    return live;
  }
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
 * Anchor for the compiled StaticComponents table: the engine HEAD SHA of
 * this (full) build plus content fingerprints of the `components.conf`
 * manifests dirty right now — the same dirty-path probe family as
 * {@link collectPackageableFingerprints}, filtered to XPCOM manifests.
 * Returns `undefined` on probe failure so a broken probe omits the field
 * (the static-components stale check then degrades to "fresh") rather than
 * anchoring to a garbage record.
 */
async function collectStaticComponentsBaseline(
  engineDir: string,
  engineHeadSha: string
): Promise<StaticComponentsBaseline | undefined> {
  const fingerprints = await collectDirtyFingerprints(
    engineDir,
    isXpcomManifestPath,
    'static-components fingerprint'
  );
  if (fingerprints === undefined) {
    return undefined;
  }
  return { engineHeadSha, fingerprints };
}

/**
 * Shared dirty-path fingerprint probe backing
 * {@link collectPackageableFingerprints} and
 * {@link collectStaticComponentsBaseline}: enumerates engine workdir
 * modifications (tracked and untracked), keeps the paths `includePath`
 * accepts, and hashes each. Returns `undefined` on any git failure so a
 * broken probe never corrupts the on-disk baseline with `{}`.
 */
async function collectDirtyFingerprints(
  engineDir: string,
  includePath: (path: string) => boolean,
  contextLabel: string
): Promise<Record<string, string> | undefined> {
  try {
    const dirtyPaths = new Set<string>();
    if (await hasChanges(engineDir)) {
      const worktreeDiff = await git(['diff', '--name-only', 'HEAD'], engineDir);
      for (const line of worktreeDiff.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) dirtyPaths.add(trimmed);
      }
      for (const untracked of await getUntrackedFiles(engineDir)) {
        dirtyPaths.add(untracked);
      }
    }

    const included = [...dirtyPaths].filter(includePath);
    if (included.length === 0) {
      return {};
    }

    const entries = await mapWithConcurrency(
      included,
      FINGERPRINT_IO_CONCURRENCY,
      async (relPath) => {
        try {
          const buffer = await readFile(join(engineDir, relPath));
          return [relPath, createHash('sha256').update(buffer).digest('hex')] as const;
        } catch (fileError: unknown) {
          if (getNodeErrorCode(fileError) === 'ENOENT') {
            // A path reported by git but absent on disk is normally a tracked
            // deletion, not a failed fingerprint. Recording the tombstone lets
            // the next stale check prove that deletion was already built.
            return [relPath, DELETED_FILE_FINGERPRINT] as const;
          }
          // A file that disappeared between status probe and hash is
          // expected in concurrent scenarios; non-ENOENT failures remain
          // untrusted and are skipped without failing the whole baseline write.
          verbose(
            `Build baseline: skipping ${contextLabel} for ${relPath} — ${toError(fileError).message}`
          );
          return undefined;
        }
      }
    );
    const fingerprints: Record<string, string> = {};
    for (const entry of entries) {
      if (entry !== undefined) fingerprints[entry[0]] = entry[1];
    }
    return fingerprints;
  } catch (error: unknown) {
    verbose(`Build baseline: ${contextLabel} probe failed — ${toError(error).message}`);
    return undefined;
  }
}
