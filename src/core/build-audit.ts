// SPDX-License-Identifier: EUPL-1.2
/*
 * Post-build dist-tree audit.
 *
 * Purpose: catch the class of bug where a file under engine/ was edited
 * but never registered in moz.build, jar.mn, or package-manifest.in, so
 * the mach build reports success but the packaged bundle carries stale
 * or missing content. A fork-specific pref file that was never registered
 * for packaging is the canonical case.
 *
 * The audit is best-effort and warn-only:
 *   - It enumerates engine files changed since the previous build baseline
 *     (git-tracked diff + workdir modifications).
 *   - For each file whose path pattern implies packaging, it resolves
 *     the expected dist artifact under obj-star/dist/binary-name-star.
 *   - A warning fires when the expected artifact is missing OR when its
 *     mtime is older than the engine source (the build was reported
 *     successful but that file's path never flowed through packaging).
 *   - False positives are acceptable at this stage: fork-specific packaging
 *     tricks FireForge doesn't know about will surface as warnings an
 *     operator can investigate. The audit never fails the build.
 *
 * Routing rules:
 *   - Build inputs (jar.mn, moz.build, Makefile.in, moz.configure) are
 *     skipped; they are consumed, not packaged.
 *   - Test sources (anything under /test(s)/, browser_*.js, test_*.js)
 *     are looked up under _tests/, not dist/ — that's where mach copies
 *     them.
 *   - Files inside an `if CONFIG[...]:` block in moz.build that gates
 *     off on the current host are skipped (Windows stubinstaller CSS on
 *     a macOS build, etc.).
 *   - Same-basename collisions in dist/ are disambiguated by trailing-
 *     segment overlap so a branding override does not get matched
 *     against an unrelated upstream file with the same basename.
 */

import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { toError } from '../utils/errors.js';
import { pathExists } from '../utils/fs.js';
import { info, verbose, warn } from '../utils/logger.js';
import { normalizePathSlashes } from '../utils/paths.js';
import { detectAncestorDirsGate, detectPlatformGate } from './build-audit-platform.js';
import {
  collectSameBasenameCandidates,
  findRegisteredTarget,
  resolveArtifactByRegistration,
} from './build-audit-registration.js';
import {
  countTrailingSegmentMatches,
  GENERIC_PATH_SEGMENTS,
  isTestPath,
  resolveBestArtifact,
} from './build-audit-resolve.js';
import {
  AUDIT_SKIP_REASONS,
  type AuditSkipReason,
  isStorybookStoryPath,
  isUnselectedBrandingPath,
  matchUnpackagedDeclaration,
  resolveSelectedBranding,
  type UnpackagedDeclaration,
} from './build-audit-skip.js';
import { resolveArtifactByKnownTransform } from './build-audit-transforms.js';
import type { BuildBaseline } from './build-baseline-types.js';
import { collectChangedEnginePaths } from './engine-changes.js';
import { loadPatchesManifest } from './patch-manifest-io.js';
import { buildPatchClaims } from './status-classify.js';

/** Path extensions that are conventionally packaged into the Firefox bundle. */
const PACKAGEABLE_EXTENSIONS = [
  '.js',
  '.mjs',
  '.jsm',
  '.css',
  '.ftl',
  '.xhtml',
  '.xul',
  '.html',
  '.properties',
];

/** Path fragments whose contents are packaged regardless of extension. */
const PACKAGEABLE_PATH_FRAGMENTS = ['/app/profile/', '/chrome/', '/locales/'];

/** Directories that are build artifacts, not source — never audited. */
const IGNORE_PATH_FRAGMENTS = ['obj-', 'node_modules/', '.git/', '.cargo/', '.mozbuild/'];

/**
 * Basenames that are build-system inputs, not packaged artifacts. `jar.mn`
 * is consumed to produce chrome registrations; `moz.build` / `moz.configure`
 * / `Makefile.in` feed the build backend; none ship in the bundle. Auditing
 * them guarantees a false positive on every edit, and worse, an unrelated
 * upstream `moz.build` sitting at e.g. `MyBrowser.app/Contents/moz.build`
 * gets matched as a "stale artifact" of an entirely different file.
 */
const BUILD_INPUT_BASENAMES = new Set([
  'jar.mn',
  'moz.build',
  'moz.configure',
  'Makefile.in',
  'mozbuild.in',
]);

/**
 * True for the build-input manifests the build consumes but never packages
 * (`jar.mn`, `moz.build`, `moz.configure`, `Makefile.in`, `mozbuild.in`).
 * Excluded from the packaging audit and from `packageableFingerprints`;
 * fingerprinted separately as `buildInputFingerprints` so `build-prepare`
 * can tell "dirty against HEAD" from "changed since the last successful
 * build".
 *
 * @param sourcePath Engine-relative POSIX path.
 */
export function isBuildInputPath(sourcePath: string): boolean {
  return BUILD_INPUT_BASENAMES.has(basename(sourcePath));
}

/**
 * True for a chrome packaging manifest (`jar.mn`). Its install-manifest
 * destinations are the one build input whose change escalates a pre-test
 * `mach build faster` to a full build, and whose fingerprint is therefore
 * refreshed only by a full build.
 *
 * @param sourcePath Engine-relative POSIX path.
 */
export function isJarManifestPath(sourcePath: string): boolean {
  return sourcePath === 'jar.mn' || sourcePath.endsWith('/jar.mn');
}

/** Result of a single artifact lookup. */
export interface AuditEntry {
  /** Engine-relative source file path (POSIX separators). */
  source: string;
  /**
   * Resolved artifact path inside the dist tree, or undefined when no
   * candidate bundle location was found. An entry with an undefined path
   * and status "missing" means the source was packageable but nothing
   * that looked like its artifact showed up in the bundle.
   */
  artifact: string | undefined;
  /**
   * updated: an artifact exists and is at least as new as the source.
   * stale:   artifact exists but is older than the source (probable packaging drop).
   * missing: no artifact with a matching basename was found anywhere under dist/.
   * skipped: the file was not audited; `skipReason` says why.
   */
  status: 'updated' | 'stale' | 'missing' | 'skipped';
  /**
   * Why a `skipped` entry was skipped. Present only for `skipped`; the
   * reasons used to exist only as verbose log strings, so the summary line
   * could report `4 missing` on a run with zero real misses and nothing in
   * the counts distinguished a structural non-input from an unregistered
   * file an operator must act on.
   */
  skipReason?: AuditSkipReason;
}

/** Summary counts for the "Packaged:" end-of-build line. */
export interface AuditSummary {
  updated: number;
  stale: number;
  missing: number;
  skipped: number;
  /** Per-class skip counts, so the summary can name what it dismissed. */
  skippedByReason: Record<AuditSkipReason, number>;
  entries: AuditEntry[];
}

/** Zeroed per-class skip counters. */
function emptySkipCounts(): Record<AuditSkipReason, number> {
  return Object.fromEntries(AUDIT_SKIP_REASONS.map((reason) => [reason, 0])) as Record<
    AuditSkipReason,
    number
  >;
}

/**
 * Decides whether a source path should be packaged. Returns true for paths
 * whose extension or directory fragment matches a known-packaged pattern,
 * after excluding build inputs (`jar.mn`, `moz.build`, etc.) which are
 * consumed by the build but never themselves packaged.
 *
 * @param sourcePath Engine-relative POSIX path (for example browser/app/profile/pref.js).
 * @returns True when the path implies packaging.
 */
export function isPackageablePath(sourcePath: string): boolean {
  for (const fragment of IGNORE_PATH_FRAGMENTS) {
    if (sourcePath.includes(fragment)) return false;
  }
  if (isBuildInputPath(sourcePath)) return false;
  // `.inc.xhtml` fragments are consumed via `#include` from a registered
  // chrome document and resolved at packaging time — they never ship as a
  // standalone packaged artifact, so auditing them flags a wired
  // `*.inc.xhtml` as "missing packaged artifact" even though `register`
  // correctly refuses to register it. Mirror the carve-out the register
  // rules apply.
  if (sourcePath.endsWith('.inc.xhtml')) return false;
  for (const ext of PACKAGEABLE_EXTENSIONS) {
    if (sourcePath.endsWith(ext)) return true;
  }
  for (const fragment of PACKAGEABLE_PATH_FRAGMENTS) {
    if (sourcePath.includes(fragment)) return true;
  }
  return false;
}

/**
 * Decides whether a source path is an XPCOM static-component manifest —
 * i.e. a file whose registrations are baked into the compiled
 * StaticComponents table at FULL-build time rather than packaged into
 * `dist/`. This basename check is the single extension point for that
 * classification; parsing `moz.build` `XPCOM_MANIFESTS` entries to follow
 * renamed manifests is out of scope.
 *
 * @param sourcePath Engine-relative POSIX path.
 * @returns True when the path is a `components.conf` manifest.
 */
export function isXpcomManifestPath(sourcePath: string): boolean {
  return basename(normalizePathSlashes(sourcePath)) === 'components.conf';
}

/*
 * Finds the unique obj-star directory with a dist subtree, or undefined
 * when zero or multiple match. The ambiguous case is already rejected
 * by pre-flight in build.ts, so the auditor only has to handle
 * one-or-none.
 */
async function resolveDistRoot(engineDir: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await readdir(engineDir);
  } catch {
    // No readable engine directory means no objdir can be identified.
    return undefined;
  }
  const objDirs = entries.filter((e) => e.startsWith('obj-'));
  for (const objDir of objDirs) {
    const distPath = join(engineDir, objDir, 'dist');
    if (await pathExists(distPath)) {
      return distPath;
    }
  }
  return undefined;
}

/**
 * Resolves the `_tests/` tree under the active obj-* directory, used as
 * a secondary search root for sources that look like packaged tests.
 * Returns undefined when no obj dir exists yet.
 */
async function resolveTestsRoot(engineDir: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await readdir(engineDir);
  } catch {
    // No readable engine directory means no objdir can be identified.
    return undefined;
  }
  const objDirs = entries.filter((e) => e.startsWith('obj-'));
  for (const objDir of objDirs) {
    const testsPath = join(engineDir, objDir, '_tests');
    if (await pathExists(testsPath)) {
      return testsPath;
    }
  }
  return undefined;
}

/**
 * Marker file the `package-tests` make target writes after copying the
 * full test-source tree under `_tests/`. Its presence is the most reliable
 * signal that test packaging has actually run for the current obj-dir —
 * plain `mach build` populates a partial `_tests/` subtree and then stops,
 * so registered tests are absent even when registration is correct.
 */
const PACKAGED_TESTS_MARKER = 'all-tests.json';

/**
 * Returns true when the full test-package step has actually run for the
 * active obj-dir. Without this marker the `_tests/` walk produces false
 * positives for every correctly-registered mochitest / xpcshell source
 * on the common "built but tests not packaged" path.
 *
 * @param testsRoot Absolute path to the obj-*`/_tests/` tree, or undefined.
 */
async function hasPackagedTestsMarker(testsRoot: string | undefined): Promise<boolean> {
  if (!testsRoot) return false;
  return pathExists(join(testsRoot, PACKAGED_TESTS_MARKER));
}

/**
 * Resolves the search roots an individual source path should be looked
 * up under. Test-shaped paths get `_tests/`; everything else gets `dist/`.
 */
function searchRootsFor(source: string, distRoot: string, testsRoot: string | undefined): string[] {
  if (isTestPath(source)) {
    return testsRoot ? [testsRoot] : [];
  }
  return [distRoot];
}

interface AuditEvalContext {
  engineDir: string;
  distRoot: string;
  testsRoot: string | undefined;
  /** True when `_tests/all-tests.json` exists for the active obj dir. */
  testsPackaged: boolean;
  /**
   * Engine-relative branding path this objdir was configured with, or
   * undefined when the generated mozconfig could not be read. Undefined
   * keeps the pre-0.46.0 behaviour deliberately: a skip that cannot name
   * its evidence is a masked warning.
   */
  selectedBranding: string | undefined;
  /** `buildAudit.unpackaged` carve-outs from fireforge.json. */
  unpackaged: readonly UnpackagedDeclaration[];
}

/**
 * Minimum trailing-segment overlap required for a same-basename dist/
 * candidate to count as "the packaged artifact" of a source. The basename
 * always trail-matches (count 1), so a threshold of 2 requires the immediate
 * parent directory to agree too. Candidates sharing only the basename are
 * classified as missing — warning the operator to check registration —
 * rather than emitting a misleading stale comparison against an unrelated
 * file of the same name.
 *
 * Cross-tree re-rooting (e.g. `branding/<name>/content/foo.css` landing at
 * `chrome/<area>/content/branding/foo.css`) bypasses this floor:
 * `scoreCandidate` awards a non-generic-segment bonus that lifts confidence
 * regardless of trailing overlap. See `isConfidentMatch` below.
 */
const MIN_TRAILING_SEGMENT_OVERLAP = 2;

/**
 * Returns true when the chosen artifact is structurally related to the
 * source path — either its immediate parent directory trail-matches, or
 * a non-generic intermediate source segment appears in the candidate
 * path (the branding-re-root signal already used by the scorer).
 *
 * Used to avoid emitting `stale` warnings that point at an unrelated
 * same-basename file picked up by the basename walker — a class of
 * warning that is worse than `missing` because it reads as "your build
 * dropped this file" when in fact the match is spurious.
 */
function isConfidentMatch(source: string, candidate: string): boolean {
  if (countTrailingSegmentMatches(source, candidate) >= MIN_TRAILING_SEGMENT_OVERLAP) {
    return true;
  }
  // The candidate is an absolute path built by `join` over a dist/ walk, so on
  // Windows it arrives backslash-separated; a `/`-only split collapses it into
  // one segment and the non-generic-segment bonus can never fire.
  const sourceSegs = normalizePathSlashes(source).split('/').filter(Boolean);
  const candSegs = normalizePathSlashes(candidate).split('/').filter(Boolean);
  const generic = GENERIC_PATH_SEGMENTS;
  // Skip the basename itself (which trail-matches by definition).
  for (let i = 0; i < sourceSegs.length - 1; i += 1) {
    const seg = sourceSegs[i];
    if (!seg || seg.length <= 2 || generic.has(seg)) continue;
    if (candSegs.includes(seg)) return true;
  }
  return false;
}

/**
 * A classified entry plus the operator-facing line it produces, if any.
 * `warning` names something to act on; `notice` records something the audit
 * dismissed on the operator's own instructions, which must be visible
 * rather than silent.
 */
type AuditResult = AuditEntry & { warning?: string; notice?: string };

/**
 * Applies a `buildAudit.unpackaged` carve-out to a classified result.
 *
 * Two behaviours, both mirroring the `--expect-unmanaged` model:
 *
 *  - An admitted path is LISTED, not silenced. A carve-out nobody can see
 *    is how one quietly widens, so the run says which paths it admitted and
 *    on what stated reason.
 *  - An admitted path that DOES resolve to a packaged artifact is a STALE
 *    carve-out: the declaration asserts a fact about the tree that is no
 *    longer true, and suppressing on it would hide a real packaging change.
 *    That is reported as a warning, not accepted.
 *
 * A declaration matching nothing that changed this run says nothing —
 * unlike `--expect-unmanaged`, whose unseen entries are reported. The
 * difference is deliberate: that is a per-invocation flag list, where an
 * unmet entry is probably a typo in the command just typed. This is a
 * standing config list checked against only the files that happened to
 * change, so "not met" is the normal case and reporting it would put a
 * warning on every build.
 */
function applyUnpackagedCarveOut(result: AuditResult, ctx: AuditEvalContext): AuditResult {
  // Already skipped for a more specific structural reason — the carve-out
  // is redundant there and reporting it would be noise.
  if (result.status === 'skipped') return result;
  const declaration = matchUnpackagedDeclaration(result.source, ctx.unpackaged);
  if (declaration === undefined) return result;

  if (result.artifact !== undefined) {
    return {
      source: result.source,
      artifact: result.artifact,
      status: 'skipped',
      skipReason: 'declared-unpackaged',
      warning:
        `Audit: engine/${result.source} is declared unpackaged in fireforge.json ` +
        `("${declaration.reason}") but a packaged artifact exists at ${result.artifact}. ` +
        'The declaration is stale — remove it, or correct its path.',
    };
  }

  return {
    source: result.source,
    artifact: undefined,
    status: 'skipped',
    skipReason: 'declared-unpackaged',
    notice:
      `Audit: engine/${result.source} admitted as unpackaged by ` +
      `buildAudit.unpackaged "${declaration.path}" — ${declaration.reason}`,
  };
}

/**
 * Audits one engine source path and returns its entry. Pure orchestration
 * helper kept separate so `auditBuildArtifacts` stays under the per-function
 * line budget.
 */
async function auditSinglePath(source: string, ctx: AuditEvalContext): Promise<AuditResult> {
  if (!isPackageablePath(source)) {
    return { source, artifact: undefined, status: 'skipped', skipReason: 'not-packageable' };
  }

  if (isStorybookStoryPath(source)) {
    verbose(`Audit: skipping engine/${source} — Storybook story, never packaged.`);
    return { source, artifact: undefined, status: 'skipped', skipReason: 'storybook-story' };
  }

  if (isUnselectedBrandingPath(source, ctx.selectedBranding)) {
    verbose(
      `Audit: skipping engine/${source} — branding tree is not the selected ${ctx.selectedBranding ?? '?'}, so it is not an input to this objdir.`
    );
    return { source, artifact: undefined, status: 'skipped', skipReason: 'branding-not-selected' };
  }

  const gate = await detectPlatformGate(ctx.engineDir, source);
  if (gate.gatedOff) {
    verbose(`Audit: skipping engine/${source} — gated off by "${gate.gateExpression ?? '?'}".`);
    return { source, artifact: undefined, status: 'skipped', skipReason: 'platform-gated' };
  }

  const ancestorGate = await detectAncestorDirsGate(ctx.engineDir, source);
  if (ancestorGate.gatedOff) {
    verbose(
      `Audit: skipping engine/${source} — its directory is reached through a DIRS entry in engine/${ancestorGate.gateFile ?? '?'} gated by "${ancestorGate.gateExpression ?? '?'}".`
    );
    return {
      source,
      artifact: undefined,
      status: 'skipped',
      skipReason: 'platform-gated-ancestor',
    };
  }

  // Tests only end up under `_tests/` after `mach package-tests` (or a
  // test-run that invokes the target) has executed. A plain `mach build`
  // populates a partial subtree and stops, so every correctly-registered
  // mochitest / xpcshell source appears "missing" on that common path.
  // Skip audit for test sources when no packaged-tests marker is present.
  if (isTestPath(source) && !ctx.testsPackaged) {
    verbose(
      `Audit: skipping engine/${source} — _tests/${PACKAGED_TESTS_MARKER} not present; full test packaging has not run for this build.`
    );
    return { source, artifact: undefined, status: 'skipped', skipReason: 'tests-not-packaged' };
  }

  const sourcePath = join(ctx.engineDir, source);
  let sourceMtime: number;
  try {
    const sourceStat = await stat(sourcePath);
    sourceMtime = sourceStat.mtimeMs;
  } catch {
    // Deletion that didn't propagate — distinct class of bug, not audited yet.
    return { source, artifact: undefined, status: 'skipped', skipReason: 'source-unreadable' };
  }

  const roots = searchRootsFor(source, ctx.distRoot, ctx.testsRoot);

  // Registration-aware resolution first: a `jar.mn` entry whose `(source)`
  // references this file is authoritative over the basename-similarity
  // heuristic, which cannot distinguish a fork's `content/foo.js` from an
  // unrelated pref file of the same basename elsewhere in the tree.
  const registered = await resolveArtifactByRegistration(ctx.engineDir, source, roots);
  if (registered) {
    return evaluateArtifactMtime(source, registered.artifact, sourceMtime, { registered: true });
  }

  // Registration exists but no matching dist entry: explicit miss,
  // distinct from an unregistered source. This surfaces in the warning so
  // the operator knows the jar.mn entry is intact and packaging is the
  // bug, not the source registration.
  const registrationMissed = await reportRegistrationMiss(ctx.engineDir, source, roots);
  if (registrationMissed) return registrationMissed;

  // Known-transform resolution comes before the similarity heuristic so a
  // source under `browser/base/content/` (or another prefix whose chrome
  // target is stable across forks) is matched against its expected
  // `chrome/...` suffix rather than whichever same-basename candidate the
  // directory walk happened to hit first. Every intermediate segment of such
  // a source is in the scorer's generic list, so `resolveBestArtifact` picks
  // arbitrarily and `isConfidentMatch` then rejects every candidate,
  // classifying a correctly-packaged file as "missing".
  const byTransform = await resolveArtifactByKnownTransform(source, roots);
  if (byTransform) {
    return evaluateArtifactMtime(source, byTransform, sourceMtime, { registered: true });
  }

  const artifact = await resolveBestArtifact(source, roots);
  if (!artifact) {
    const where = isTestPath(source) ? '_tests/' : 'dist/';
    return {
      source,
      artifact: undefined,
      status: 'missing',
      warning: `Audit: engine/${source} was touched but no packaged artifact with basename "${basename(source)}" was found under ${where}. Missing moz.build / jar.mn / package-manifest.in registration?`,
    };
  }

  return evaluateArtifactMtime(source, artifact, sourceMtime, { registered: false, roots });
}

/**
 * Short-circuits the audit for sources that are registered in a jar.mn
 * but whose target path is absent from every search root. Returns the
 * miss entry when the registration lookup saw a `(source)` claim but
 * no dist candidate endswith the target; undefined otherwise.
 */
async function reportRegistrationMiss(
  engineDir: string,
  source: string,
  roots: readonly string[]
): Promise<AuditResult | undefined> {
  const hit = await findRegisteredTarget(engineDir, source);
  if (!hit) return undefined;
  const where = isTestPath(source) ? '_tests/' : 'dist/';
  // Name every same-basename hit so the operator sees what did land in
  // dist, rather than guessing from a single "nearest" pick.
  const candidates = await collectSameBasenameCandidates(source, roots);
  const nearHits = describeCandidates(candidates);
  const manifest = relativeManifestPath(engineDir, hit.jarManifest);
  return {
    source,
    artifact: undefined,
    status: 'missing',
    warning:
      `Audit: engine/${source} is registered in ${manifest} as ` +
      `"${hit.target}  (${hit.source})" but no packaged artifact ending in "/${hit.target}" ` +
      `was found under ${where}. Build reported success but the file's path did not ` +
      `flow through packaging${nearHits ? ` — same-basename hits: ${nearHits}` : ''}.`,
  };
}

/**
 * Renders packaged-artifact mtime classification (updated / stale / missing-
 * via-disappearance) for a resolved candidate. Shared by the registration-
 * anchored path (confident by construction) and the heuristic fallback
 * (which still applies the structural-relatedness check before claiming
 * `stale`).
 */
async function evaluateArtifactMtime(
  source: string,
  artifact: string,
  sourceMtime: number,
  mode: { registered: true } | { registered: false; roots: readonly string[] }
): Promise<AuditResult> {
  let artifactMtime: number;
  try {
    const artifactStat = await stat(artifact);
    artifactMtime = artifactStat.mtimeMs;
  } catch {
    return {
      source,
      artifact,
      status: 'missing',
      warning: `Audit: engine/${source} has no readable packaged artifact at ${artifact} (disappeared during audit).`,
    };
  }

  if (artifactMtime + 1 < sourceMtime) {
    if (!mode.registered && !isConfidentMatch(source, artifact)) {
      const where = isTestPath(source) ? '_tests/' : 'dist/';
      const candidates = await collectSameBasenameCandidates(source, mode.roots);
      const nearHits = describeCandidates(candidates);
      return {
        source,
        artifact: undefined,
        status: 'missing',
        warning:
          `Audit: engine/${source} was touched but no related packaged artifact with ` +
          `basename "${basename(source)}" was found under ${where}` +
          (nearHits ? `. Same-basename hits in unrelated subtrees: ${nearHits}` : '') +
          `. Missing moz.build / jar.mn / package-manifest.in registration?`,
      };
    }
    return {
      source,
      artifact,
      status: 'stale',
      warning: `Audit: engine/${source} is newer than its packaged artifact ${artifact}. Build reported success but the file's path may not flow through packaging — check moz.build / jar.mn entries.`,
    };
  }

  return { source, artifact, status: 'updated' };
}

/** Cap on candidate list rendering before truncating with `(+N more)`. */
const CANDIDATE_LIST_LIMIT = 5;

/**
 * Renders a comma-separated list of same-basename hits for inclusion in a
 * warning, truncated at {@link CANDIDATE_LIST_LIMIT} with a `(+N more)`
 * tail. Returns the empty string when no candidates are supplied so
 * callers can omit the parenthetical entirely rather than render a stub.
 */
function describeCandidates(candidates: readonly string[]): string {
  if (candidates.length === 0) return '';
  const head = candidates.slice(0, CANDIDATE_LIST_LIMIT).join(', ');
  if (candidates.length <= CANDIDATE_LIST_LIMIT) return head;
  return `${head}, … (+${candidates.length - CANDIDATE_LIST_LIMIT} more)`;
}

/**
 * Formats a manifest path relative to the engine root when it lives
 * underneath, falling back to the absolute path otherwise. Keeps warning
 * text short and anchored to `engine/…` when the manifest is in-tree.
 */
function relativeManifestPath(engineDir: string, manifest: string): string {
  const root = engineDir.replace(/[/\\]+$/, '');
  if (manifest.startsWith(`${root}/`)) {
    return `engine/${manifest.slice(root.length + 1)}`;
  }
  return manifest;
}

/**
 * Path → owning patch filenames, from the patches manifest's
 * `filesAffected`. Best-effort: a project with no queue (or an unreadable
 * manifest) yields an empty map and the notices render exactly as before.
 */
async function resolveAuditOwnership(projectRoot: string): Promise<Map<string, string[]>> {
  try {
    const patchesDir = join(projectRoot, 'patches');
    const manifest = await loadPatchesManifest(patchesDir);
    if (!manifest) return new Map();
    return buildPatchClaims(manifest.patches);
  } catch (error: unknown) {
    verbose(`Audit: ownership lookup unavailable (${toError(error).message}).`);
    return new Map();
  }
}

/**
 * Renders the ownership suffix for one audit notice: the owning patch, or
 * an explicit `unmanaged` mark. An empty map (no queue, unreadable
 * manifest) renders nothing rather than claiming everything is unmanaged —
 * "unmanaged" must mean "checked and unowned", never "could not check".
 */
function describeOwnership(ownersByPath: ReadonlyMap<string, string[]>, source: string): string {
  if (ownersByPath.size === 0) return '';
  const owners = ownersByPath.get(source);
  if (owners === undefined || owners.length === 0) {
    return ' Ownership: unmanaged (no patch claims this path).';
  }
  return ` Ownership: ${owners.join(', ')}.`;
}

/**
 * Runs the post-build audit. Emits per-file warnings for missing or
 * stale artifacts and a summary info line at the end. Always returns
 * the summary; never throws on audit failure (the audit itself must
 * never fail a successful build).
 * @param projectRoot Root of the project (reserved for future fork-specific rules).
 * @param engineDir Path to the engine directory.
 * @param baseline Optional previous-build baseline marker.
 * @returns Summary of artifact status counts.
 */
export async function auditBuildArtifacts(
  projectRoot: string,
  engineDir: string,
  baseline: BuildBaseline | undefined,
  options: { unpackaged?: readonly UnpackagedDeclaration[] } = {}
): Promise<AuditSummary> {
  const summary: AuditSummary = {
    updated: 0,
    stale: 0,
    missing: 0,
    skipped: 0,
    skippedByReason: emptySkipCounts(),
    entries: [],
  };

  const distRoot = await resolveDistRoot(engineDir);
  if (!distRoot) {
    verbose('Audit skipped: no dist tree found under obj-*/dist/.');
    return summary;
  }
  const testsRoot = await resolveTestsRoot(engineDir);
  const testsPackaged = await hasPackagedTestsMarker(testsRoot);

  const changed = await collectChangedEnginePaths(engineDir, baseline, 'Audit');
  if (changed.length === 0) {
    return summary;
  }

  // Ownership, resolved once for the whole audit. The notices key on "was
  // touched", which on a shared checkout means any concurrent session's
  // dirty files — so an operator gets a registration-shaped warning about a
  // file they never edited and has to census ownership by hand to dismiss
  // it. FireForge already resolves this for `status --ownership`; carrying
  // it here turns a three-line mystery into three dismissible lines.
  const ownersByPath = await resolveAuditOwnership(projectRoot);

  const ctx: AuditEvalContext = {
    engineDir,
    distRoot,
    testsRoot,
    testsPackaged,
    selectedBranding: await resolveSelectedBranding(engineDir),
    unpackaged: options.unpackaged ?? [],
  };
  for (const source of changed) {
    const result = applyUnpackagedCarveOut(await auditSinglePath(source, ctx), ctx);
    summary[result.status] += 1;
    if (result.status === 'skipped' && result.skipReason !== undefined) {
      summary.skippedByReason[result.skipReason] += 1;
    }
    summary.entries.push({
      source: result.source,
      artifact: result.artifact,
      status: result.status,
      ...(result.skipReason === undefined ? {} : { skipReason: result.skipReason }),
    });
    if (result.warning) warn(`${result.warning}${describeOwnership(ownersByPath, result.source)}`);
    if (result.notice) info(result.notice);
  }

  info(
    `Packaged: ${summary.updated} updated, ${summary.stale} stale, ${summary.missing} missing, ` +
      `${summary.skipped} skipped${describeSkipBreakdown(summary)}`
  );

  return summary;
}

/**
 * Renders the per-class skip breakdown appended to the `Packaged:` line.
 *
 * Without it the summary reported one undifferentiated `skipped` count, so
 * a run that dismissed four unselected-branding files and one
 * ancestor-gated directory looked identical to one that dismissed five
 * unregistered sources — and the four false `missing` entries downstream
 * reported had no counterpart in the counts an operator could check.
 */
function describeSkipBreakdown(summary: AuditSummary): string {
  const parts = AUDIT_SKIP_REASONS.filter((reason) => summary.skippedByReason[reason] > 0).map(
    (reason) => `${reason} ${String(summary.skippedByReason[reason])}`
  );
  return parts.length === 0 ? '' : ` (${parts.join(', ')})`;
}
