// SPDX-License-Identifier: EUPL-1.2
/**
 * Decides which earlier packaging claims a scoped `fireforge test --build`
 * keeps. Retention is per staged path (see `coverage-records.ts`): an
 * earlier path stays covered while its own staging inputs are unchanged,
 * whatever moved elsewhere in the engine, and a full claim narrows to
 * per-path checks once something outside the new scope changed instead of
 * collapsing to this build's paths. `--extend-coverage` turns any drop into
 * a refusal before the build.
 *
 * Fingerprints must be complete: a legacy packageable-only record cannot
 * prove that a test fixture or manifest still matches its staged copy.
 */

import { toError } from '../utils/errors.js';
import { verbose } from '../utils/logger.js';
import type {
  BuildBaseline,
  CoverageAnchor,
  CoverageRecord,
  TestPackagingCoverage,
} from './build-baseline-types.js';
import {
  collectStagingInputs,
  createCoverageRecord,
  type EngineContentState,
  findChangedInputs,
  hashEngineFile,
  isUnderPath,
  narrowAnchor,
  normalizeRequestPath,
  readEngineContentState,
  refreshAnchor,
  widenWithRestagedManifests,
} from './coverage-records.js';

export { hashEngineFile } from './coverage-records.js';

/** Filename of the generated mozconfig, relative to the engine directory. */
const MOZCONFIG_FILENAME = 'mozconfig';

/** How many paths a notice or refusal names before truncating. */
const MAX_PATHS_REPORTED = 5;

/** What a dropped full claim is called in notices and refusals. */
export const FULL_CLAIM_LABEL = 'full coverage';

/** An earlier claim this build cannot keep, and why. */
export interface DroppedClaim {
  /** Request path, or {@link FULL_CLAIM_LABEL}. */
  path: string;
  /** Staging inputs whose content changed since the claim was staged. */
  changed: string[];
  /** Why the claim cannot be verified at all, when no input list explains it. */
  reason?: string;
}

/** What a scoped build keeps of the recorded coverage. */
export interface CoverageRetentionPlan {
  /** The previous claim was full and nothing outside this build's scope moved. */
  keepFull: boolean;
  /** Earlier per-path records kept, refreshed for this build's paths. */
  retained: Record<string, CoverageRecord>;
  /** Full-build anchor carried for dispatch-time per-path checks. */
  fullAnchor: CoverageAnchor | undefined;
  /** Changed inputs that narrowed a full claim to per-path checks. */
  narrowedBy: string[];
  /** Earlier claims this build cannot keep. */
  dropped: DroppedClaim[];
}

const UNVERIFIABLE = 'engine HEAD or the recorded anchor cannot be compared';
const NO_FINGERPRINTS = 'the record has no complete staging-input fingerprints';

/** The baseline-wide anchor a baseline's own fields describe, when complete. */
export function baselineAnchor(baseline: BuildBaseline): CoverageAnchor | undefined {
  if (baseline.testInputFingerprints === undefined || baseline.mozconfigHash === undefined) {
    return undefined;
  }
  return {
    engineHeadSha: baseline.engineHeadSha,
    mozconfigHash: baseline.mozconfigHash,
    fingerprints: baseline.testInputFingerprints,
  };
}

function emptyPlan(): CoverageRetentionPlan {
  return { keepFull: false, retained: {}, fullAnchor: undefined, narrowedBy: [], dropped: [] };
}

/** True when a request path in `requested` stages `path` afresh. */
function rebuiltBy(path: string, rebuilt: readonly string[]): boolean {
  const normalized = normalizeRequestPath(path);
  return rebuilt.some((request) => isUnderPath(normalized, request));
}

async function planFullClaim(
  state: EngineContentState,
  previous: BuildBaseline,
  requested: string[]
): Promise<CoverageRetentionPlan> {
  const plan = emptyPlan();
  const anchor = previous.fullCoverageAnchor ?? baselineAnchor(previous);
  if (anchor === undefined) {
    plan.dropped.push({ path: FULL_CLAIM_LABEL, changed: [], reason: NO_FINGERPRINTS });
    return plan;
  }
  const changed = await findChangedInputs(state, anchor, undefined, requested);
  const refreshed =
    changed === undefined ? undefined : await refreshAnchor(state, anchor, requested);
  if (changed === undefined || refreshed === undefined) {
    plan.dropped.push({ path: FULL_CLAIM_LABEL, changed: [], reason: UNVERIFIABLE });
    return plan;
  }
  plan.keepFull = changed.length === 0;
  plan.fullAnchor = refreshed;
  plan.narrowedBy = changed;
  return plan;
}

async function retainRecord(
  state: EngineContentState,
  previous: BuildBaseline,
  path: string,
  requested: string[]
): Promise<{ record: CoverageRecord } | DroppedClaim> {
  let record = previous.testCoverageRecords?.[path];
  if (record === undefined) {
    // A path recorded before per-path anchors existed: the baseline-wide
    // anchor, restricted to the path's own inputs, says the same thing.
    const anchor = baselineAnchor(previous);
    if (anchor === undefined) return { path, changed: [], reason: NO_FINGERPRINTS };
    const inputs = await collectStagingInputs(state.engineDir, path);
    record = await narrowAnchor(state, anchor, inputs);
    if (record === undefined) return { path, changed: [], reason: UNVERIFIABLE };
  }
  const changed = await findChangedInputs(state, record, record.inputs, requested);
  if (changed === undefined) return { path, changed: [], reason: UNVERIFIABLE };
  if (changed.length > 0) return { path, changed };
  const refreshed = await refreshAnchor(state, record, requested);
  return refreshed === undefined
    ? { path, changed: [], reason: UNVERIFIABLE }
    : { record: refreshed };
}

/**
 * Plans which earlier claims a scoped build over `requested` keeps. Runs
 * before the build lock, so a refusal costs neither build time nor the
 * lock. The mozconfig half runs later, via {@link applyMozconfigAnchor}.
 *
 * @param engineDir - Path to the engine directory
 * @param previous - Baseline recorded by the previous build
 * @param requested - Normalized request paths this build packages
 */
export async function planCoverageRetention(
  engineDir: string,
  previous: BuildBaseline | undefined,
  requested: string[]
): Promise<CoverageRetentionPlan> {
  if (previous === undefined) return emptyPlan();
  const coverage = previous.testPackagingCoverage ?? 'full';
  const rebuilt = await widenWithRestagedManifests(
    engineDir,
    requested.map(normalizeRequestPath).filter((path) => path !== '')
  );
  let state: EngineContentState;
  try {
    state = await readEngineContentState(engineDir);
  } catch (error: unknown) {
    verbose(`Coverage retention: engine state unreadable — ${toError(error).message}`);
    const paths = coverage === 'full' ? [FULL_CLAIM_LABEL] : coverage;
    return {
      ...emptyPlan(),
      dropped: paths.map((path) => ({ path, changed: [], reason: UNVERIFIABLE })),
    };
  }
  if (coverage === 'full') return planFullClaim(state, previous, rebuilt);

  const plan = emptyPlan();
  if (previous.fullCoverageAnchor !== undefined) {
    plan.fullAnchor = await refreshAnchor(state, previous.fullCoverageAnchor, rebuilt);
    if (plan.fullAnchor === undefined) {
      plan.dropped.push({ path: FULL_CLAIM_LABEL, changed: [], reason: UNVERIFIABLE });
    }
  }
  for (const path of coverage) {
    if (rebuiltBy(path, rebuilt)) continue;
    const outcome = await retainRecord(state, previous, path, rebuilt);
    if ('record' in outcome) plan.retained[path] = outcome.record;
    else plan.dropped.push(outcome);
  }
  return plan;
}

/**
 * Applies the mozconfig half of the anchor: a claim staged under a different
 * `engine/mozconfig` is dropped. Runs after `prepareBuildEnvironment`
 * regenerated the file this build configures with, and before mach.
 *
 * @param engineDir - Path to the engine directory
 * @param plan - Plan from {@link planCoverageRetention}
 */
export async function applyMozconfigAnchor(
  engineDir: string,
  plan: CoverageRetentionPlan
): Promise<CoverageRetentionPlan> {
  const live = await hashEngineFile(engineDir, MOZCONFIG_FILENAME);
  const reason = 'engine/mozconfig differs from the build that staged it';
  const next: CoverageRetentionPlan = { ...plan, retained: {}, dropped: [...plan.dropped] };
  for (const [path, record] of Object.entries(plan.retained)) {
    if (live !== undefined && record.mozconfigHash === live) next.retained[path] = record;
    else next.dropped.push({ path, changed: [], reason });
  }
  if (
    plan.fullAnchor !== undefined &&
    (live === undefined || plan.fullAnchor.mozconfigHash !== live)
  ) {
    next.fullAnchor = undefined;
    next.keepFull = false;
    next.narrowedBy = [];
    next.dropped.push({ path: FULL_CLAIM_LABEL, changed: [], reason });
  }
  return next;
}

/** Fields a scoped build writes onto its baseline. */
export interface RecordedCoverage {
  testPackagingCoverage: TestPackagingCoverage;
  testCoverageRecords?: Record<string, CoverageRecord>;
  fullCoverageAnchor?: CoverageAnchor;
}

/**
 * The coverage a green scoped build records: `'full'` when the plan kept a
 * full claim, otherwise this build's paths with fresh records plus every
 * retained earlier path, and the carried full anchor.
 *
 * @param engineDir - Path to the engine directory
 * @param plan - Plan after {@link applyMozconfigAnchor}
 * @param requested - Normalized request paths this build packaged
 */
export async function recordScopedCoverage(
  engineDir: string,
  plan: CoverageRetentionPlan,
  requested: string[]
): Promise<RecordedCoverage> {
  if (plan.keepFull) return { testPackagingCoverage: 'full' };
  const records: Record<string, CoverageRecord> = { ...plan.retained };
  try {
    const state = await readEngineContentState(engineDir);
    const mozconfigHash = await hashEngineFile(engineDir, MOZCONFIG_FILENAME);
    for (const path of requested) {
      const record =
        mozconfigHash === undefined
          ? undefined
          : await createCoverageRecord(state, path, mozconfigHash);
      if (record !== undefined) records[path] = record;
    }
  } catch (error: unknown) {
    verbose(`Coverage records: could not anchor this build's paths — ${toError(error).message}`);
  }
  const kept = Object.keys(plan.retained);
  const coverage =
    kept.length === 0 ? [...requested] : [...new Set([...kept, ...requested])].sort();
  return {
    testPackagingCoverage: coverage,
    ...(Object.keys(records).length > 0 ? { testCoverageRecords: records } : {}),
    ...(plan.fullAnchor !== undefined ? { fullCoverageAnchor: plan.fullAnchor } : {}),
  };
}

function capList(paths: readonly string[]): string {
  const head = paths.slice(0, MAX_PATHS_REPORTED).join(', ');
  const extra = paths.length - Math.min(paths.length, MAX_PATHS_REPORTED);
  return extra > 0 ? `${head}, … (+${extra} more)` : head;
}

/** Renders one dropped claim with its cause. */
export function describeDroppedClaim(claim: DroppedClaim): string {
  const cause =
    claim.changed.length > 0
      ? `staging inputs changed: ${capList(claim.changed)}`
      : (claim.reason ?? UNVERIFIABLE);
  return `${claim.path} (${cause})`;
}

/**
 * The notice a scoped build prints about earlier coverage, or undefined
 * when nothing was dropped or narrowed.
 */
export function formatCoverageRetentionNotice(plan: CoverageRetentionPlan): string | undefined {
  const lines: string[] = [];
  if (plan.dropped.length > 0) {
    const kept = Object.keys(plan.retained);
    lines.push(
      `Scoped build drops previous packaging coverage for ${plan.dropped.map(describeDroppedClaim).join('; ')}.` +
        (kept.length > 0 ? ` Kept: ${capList(kept)}.` : '') +
        ' Rebuild a dropped path (alone or with this one) before running it without --build.'
    );
  }
  if (!plan.keepFull && plan.fullAnchor !== undefined && plan.narrowedBy.length > 0) {
    lines.push(
      `Full packaging coverage is now checked per path: ${capList(plan.narrowedBy)} changed outside ` +
        "this build's scope, so a later run is refused only for paths whose own staging inputs include a changed file."
    );
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}

/**
 * The `--extend-coverage` refusal: the flag asks that no earlier claim be
 * dropped, and the plan would drop some.
 */
export function formatExtendCoverageRefusal(dropped: readonly DroppedClaim[]): string {
  return (
    `--extend-coverage refused: this build would drop earlier packaging coverage for ` +
    `${dropped.length} claim(s): ${dropped.map(describeDroppedClaim).join('; ')}. ` +
    'Extending would vouch for staging that obj-*/_tests/ no longer matches. Rebuild those paths ' +
    'together with this one, or drop the flag: without it the dropped claims are named and the ' +
    'rest of the coverage is kept.'
  );
}
