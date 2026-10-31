// SPDX-License-Identifier: EUPL-1.2
/**
 * `PatchMetadata.lintIgnore` entries and the waiver filter they drive.
 *
 * An entry is either a bare check ID, which suppresses that rule at any
 * size, or a ceiling `{ rule, max, reason }`, which suppresses a size rule
 * only while its measurement is at or below `max`. The bare form lets a
 * waived file grow without bound: nothing re-examines the waiver once it
 * is written, so a 950-line file waived at review time is still waived at
 * 2,000 lines. The ceiling makes growth past the reviewed size fire again,
 * and lets a gate say when the waiver is no longer needed at all.
 *
 * Its own module so every caller that turns a manifest list into a filter
 * (export, re-export, per-patch and aggregate lint, split, move-files)
 * shares one reading of an entry, and so `patch-lint.ts` only calls into it.
 */

import type {
  LintIgnoreCeiling,
  LintIgnoreEntry,
  PatchLintIssue,
  PatchSizeShare,
} from '../types/commands/index.js';

/**
 * The size rules whose findings carry a `measurement`, and therefore the
 * only rules a ceiling can bound. A ceiling on any other rule could never
 * suppress anything, so the manifest validator refuses it.
 */
export const LINT_IGNORE_CEILING_RULES: readonly string[] = [
  'file-too-large',
  'large-patch-lines',
  'large-patch-files',
];

/** The only rule whose findings carry a {@link PatchSizeShare}. */
const SHARE_RULE = 'large-patch-lines';
const SHARES: readonly PatchSizeShare[] = ['product', 'test'];

/**
 * The key a ceiling is stored under: the rule, plus `#<share>` for a
 * share-scoped ceiling, so one rule can carry a ceiling per share.
 */
function ceilingKey(rule: string, share: PatchSizeShare | undefined): string {
  return share === undefined ? rule : `${rule}#${share}`;
}

/**
 * A waiver filter: the bare check IDs as a set (so a plain `Set<string>`
 * still satisfies the type), plus the ceilings keyed by {@link ceilingKey}.
 *
 * Bare IDs and ceilings are kept apart on purpose. A caller that only knows
 * `has()` treats a ceiling-waived rule as not waived, which fails closed.
 */
export type LintIgnoreChecks = ReadonlySet<string> & {
  readonly ceilings?: ReadonlyMap<string, LintIgnoreCeiling>;
};

/** Narrows an entry to the ceiling form. */
export function isLintIgnoreCeiling(entry: LintIgnoreEntry): entry is LintIgnoreCeiling {
  return typeof entry !== 'string';
}

/** The check ID an entry names, whatever its form. */
export function lintIgnoreRule(entry: LintIgnoreEntry): string {
  return isLintIgnoreCeiling(entry) ? entry.rule : entry;
}

/**
 * One-word rendering for summaries and dry runs: `file-too-large<=1200`,
 * `large-patch-lines[test]<=900`.
 */
export function formatLintIgnoreEntry(entry: LintIgnoreEntry): string {
  if (!isLintIgnoreCeiling(entry)) return entry;
  const share = entry.share === undefined ? '' : `[${entry.share}]`;
  return `${entry.rule}${share}<=${String(entry.max)}`;
}

/** The identity an entry is upserted and deduplicated by. */
function entryKey(entry: LintIgnoreEntry): string {
  return isLintIgnoreCeiling(entry) ? ceilingKey(entry.rule, entry.share) : entry;
}

/** Renders a list for messages, `(empty)` when there is nothing to show. */
export function formatLintIgnoreList(entries: readonly LintIgnoreEntry[]): string {
  return entries.length > 0 ? entries.map(formatLintIgnoreEntry).join(', ') : '(empty)';
}

function sameEntry(a: LintIgnoreEntry, b: LintIgnoreEntry): boolean {
  if (!isLintIgnoreCeiling(a) || !isLintIgnoreCeiling(b)) return a === b;
  return (
    a.rule === b.rule &&
    a.max === b.max &&
    a.reason === b.reason &&
    a.share === b.share &&
    JSON.stringify(a.meta) === JSON.stringify(b.meta)
  );
}

/**
 * Validates a raw `lintIgnore` value from `patches.json`.
 *
 * Bare strings keep their historical leniency (any ID, duplicates collapse
 * later). A ceiling must name a measured size rule, carry a positive
 * integer `max` and a non-empty `reason`, and must be the only entry for
 * its rule: a bare ID beside a ceiling for the same rule would make the
 * ceiling dead, and two ceilings would leave the effective one ambiguous.
 * The one exception is `large-patch-lines`, which may carry one ceiling
 * per `share` instead of a single share-less one. `meta` must be a JSON
 * object and is kept verbatim.
 *
 * @param raw - The value under `lintIgnore`
 * @param label - Field label for error messages, e.g. `patches[3].lintIgnore`
 * @returns The validated entries
 * @throws Error naming the offending element
 */
export function parseLintIgnoreEntries(raw: unknown, label: string): LintIgnoreEntry[] {
  if (!Array.isArray(raw)) {
    throw new Error(`${label} must be an array`);
  }
  const entries: LintIgnoreEntry[] = [];
  const ceilingRules = new Set<string>();
  for (const [index, item] of raw.entries()) {
    const itemLabel = `${label}[${String(index)}]`;
    if (typeof item === 'string') {
      entries.push(item);
      continue;
    }
    entries.push(parseCeiling(item, itemLabel));
  }
  const sharedRules = new Set<string>();
  for (const entry of entries) {
    if (!isLintIgnoreCeiling(entry)) continue;
    const key = ceilingKey(entry.rule, entry.share);
    const clash =
      ceilingRules.has(key) ||
      entries.includes(entry.rule) ||
      (entry.share === undefined ? sharedRules.has(entry.rule) : ceilingRules.has(entry.rule));
    if (clash) {
      throw new Error(
        `${label} names "${entry.rule}" more than once; keep a single entry (bare or ceiling) ` +
          'per rule, or one ceiling per share'
      );
    }
    ceilingRules.add(key);
    if (entry.share !== undefined) sharedRules.add(entry.rule);
  }
  return entries;
}

function parseCeiling(item: unknown, label: string): LintIgnoreCeiling {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error(`${label} must be a check ID string or a { rule, max, reason } object`);
  }
  const record = item as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => !CEILING_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`${label} has unknown field(s): ${unknownKeys.join(', ')}`);
  }
  const { rule, max, reason, share, meta } = record;
  if (typeof rule !== 'string' || !LINT_IGNORE_CEILING_RULES.includes(rule)) {
    throw new Error(
      `${label}.rule must be one of the measured size rules: ${LINT_IGNORE_CEILING_RULES.join(', ')}`
    );
  }
  if (typeof max !== 'number' || !Number.isInteger(max) || max <= 0) {
    throw new Error(`${label}.max must be a positive integer`);
  }
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new Error(`${label}.reason must be a non-empty string`);
  }
  const ceiling: LintIgnoreCeiling = { rule, max, reason };
  if (share !== undefined) {
    if (rule !== SHARE_RULE || !SHARES.includes(share as PatchSizeShare)) {
      throw new Error(`${label}.share must be "product" or "test", and only on ${SHARE_RULE}`);
    }
    ceiling.share = share as PatchSizeShare;
  }
  if (meta !== undefined) {
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
      throw new Error(`${label}.meta must be a JSON object`);
    }
    ceiling.meta = meta as Record<string, unknown>;
  }
  return ceiling;
}

const CEILING_KEYS: ReadonlySet<string> = new Set(['rule', 'max', 'reason', 'share', 'meta']);

/**
 * Builds the waiver filter for a patch's entries.
 *
 * @param entries - `PatchMetadata.lintIgnore`, possibly merged with CLI flags
 * @returns The filter, or undefined when there is nothing to waive
 */
export function buildLintIgnoreChecks(
  entries: readonly LintIgnoreEntry[] | undefined
): LintIgnoreChecks | undefined {
  if (entries === undefined || entries.length === 0) return undefined;
  const plain = new Set<string>();
  const ceilings = new Map<string, LintIgnoreCeiling>();
  for (const entry of entries) {
    if (isLintIgnoreCeiling(entry)) ceilings.set(ceilingKey(entry.rule, entry.share), entry);
    else plain.add(entry);
  }
  return ceilings.size > 0 ? Object.assign(plain, { ceilings }) : plain;
}

/**
 * Canonical string form of a filter for the per-patch lint cache's waiver
 * comparison: bare IDs as themselves, ceilings as `rule<=max`.
 */
export function lintIgnoreCacheTokens(checks: LintIgnoreChecks | undefined): string[] {
  if (checks === undefined) return [];
  const ceilings = [...(checks.ceilings?.values() ?? [])].map(formatLintIgnoreEntry);
  return [...checks, ...ceilings];
}

/**
 * Unions CLI-flag check IDs into an existing list, the append-only
 * semantics `export` / `re-export --lint-ignore` have always had. A bare ID
 * whose rule already has an entry (bare or ceiling) is a no-op: widening a
 * reviewed ceiling to an unbounded waiver is `patch lint-ignore`'s job, where
 * it is confirmed explicitly. Ceilings deduplicate by rule and share, so a
 * rule's per-share ceilings all survive.
 *
 * @returns The merged list, or undefined when it is empty
 */
export function mergeLintIgnoreIds(
  existing: readonly LintIgnoreEntry[] | undefined,
  ids: readonly string[] | undefined
): LintIgnoreEntry[] | undefined {
  const merged: LintIgnoreEntry[] = [];
  const keys = new Set<string>();
  const rules = new Set<string>();
  for (const entry of [...(existing ?? []), ...(ids ?? [])]) {
    const blocked = isLintIgnoreCeiling(entry) ? keys.has(entryKey(entry)) : rules.has(entry);
    if (blocked) continue;
    keys.add(entryKey(entry));
    rules.add(lintIgnoreRule(entry));
    merged.push(entry);
  }
  return merged.length > 0 ? merged : undefined;
}

/**
 * Adds or replaces entries, the `patch lint-ignore --add` semantics: an
 * explicit `--add <rule>` turns a rule's ceilings into a bare waiver,
 * `--add <rule> --max <n>` sets or moves the rule's ceiling, and a
 * share-scoped ceiling replaces only its own share (plus any bare or
 * share-less entry for the rule, which it would contradict).
 *
 * @returns The new list, or undefined when it is empty
 */
export function upsertLintIgnoreEntries(
  existing: readonly LintIgnoreEntry[],
  additions: readonly LintIgnoreEntry[]
): LintIgnoreEntry[] | undefined {
  let next = [...existing];
  for (const addition of additions) {
    const rule = lintIgnoreRule(addition);
    const scoped = isLintIgnoreCeiling(addition) && addition.share !== undefined;
    const replaced = (entry: LintIgnoreEntry): boolean =>
      lintIgnoreRule(entry) === rule &&
      (!scoped ||
        !isLintIgnoreCeiling(entry) ||
        entry.share === undefined ||
        entryKey(entry) === entryKey(addition));
    const index = next.findIndex(replaced);
    const kept = next.filter((entry) => !replaced(entry));
    // The addition takes the first replaced entry's place, so a moved
    // ceiling keeps its position in the list.
    next =
      index === -1
        ? [...kept, addition]
        : [...kept.slice(0, index), addition, ...kept.slice(index)];
  }
  return mergeLintIgnoreIds(next, undefined);
}

/** Removes every entry naming one of `rules`. Undefined when nothing is left. */
export function removeLintIgnoreRules(
  existing: readonly LintIgnoreEntry[],
  rules: readonly string[]
): LintIgnoreEntry[] | undefined {
  const drop = new Set(rules);
  const remaining = existing.filter((entry) => !drop.has(lintIgnoreRule(entry)));
  return remaining.length > 0 ? remaining : undefined;
}

/** Entries present in `after` but not (identically) in `before`. */
export function addedLintIgnoreEntries(
  before: readonly LintIgnoreEntry[],
  after: readonly LintIgnoreEntry[]
): LintIgnoreEntry[] {
  return after.filter((entry) => !before.some((prior) => sameEntry(prior, entry)));
}

/**
 * Splits issues into the ones that still surface and the ones a waiver
 * drops.
 *
 * A bare ID drops every finding of its rule. A ceiling drops a finding only
 * when it carries a measurement at or below `max`. Past the ceiling the
 * finding surfaces at its own severity with the ceiling named, and a
 * finding with no measurement surfaces too (fail closed).
 */
export function partitionLintIgnoredIssues(
  issues: readonly PatchLintIssue[],
  checks: LintIgnoreChecks | undefined
): { kept: PatchLintIssue[]; suppressed: PatchLintIssue[] } {
  const kept: PatchLintIssue[] = [];
  const suppressed: PatchLintIssue[] = [];
  for (const issue of issues) {
    if (checks?.has(issue.check) === true) {
      suppressed.push(issue);
      continue;
    }
    const ceiling = ceilingFor(issue, checks);
    if (ceiling === undefined) {
      kept.push(issue);
      continue;
    }
    if (issue.measurement !== undefined && issue.measurement <= ceiling.max) {
      suppressed.push(issue);
      continue;
    }
    // A notice never gates, so a ceiling does not bound it: one past `max`
    // surfaces as the plain notice it is, not as an exceeded waiver.
    if (issue.severity === 'notice') {
      kept.push(issue);
      continue;
    }
    kept.push({ ...issue, message: `${issue.message} ${describeExceededCeiling(ceiling)}` });
  }
  return { kept, suppressed };
}

/** The ceiling that governs `issue`: its share's, else the rule's share-less one. */
function ceilingFor(
  issue: PatchLintIssue,
  checks: LintIgnoreChecks | undefined
): LintIgnoreCeiling | undefined {
  const ceilings = checks?.ceilings;
  if (ceilings === undefined) return undefined;
  if (issue.share !== undefined) {
    const scoped = ceilings.get(ceilingKey(issue.check, issue.share));
    if (scoped !== undefined) return scoped;
  }
  return ceilings.get(issue.check);
}

function describeExceededCeiling(ceiling: LintIgnoreCeiling): string {
  const share = ceiling.share === undefined ? '' : ` (${ceiling.share} share)`;
  return (
    `This exceeds the patch's lintIgnore ceiling for ${ceiling.rule}${share} ` +
    `(max ${String(ceiling.max)}: ${ceiling.reason}).`
  );
}

/** True when `checks` waives `issue` (see {@link partitionLintIgnoredIssues}). */
export function isLintIgnored(
  issue: PatchLintIssue,
  checks: LintIgnoreChecks | undefined
): boolean {
  return partitionLintIgnoredIssues([issue], checks).suppressed.length === 1;
}

/**
 * Drops issues that a patch owning `issue.file` (via `filesAffected`)
 * waives. Used where findings carry no patch scope of their own (aggregate
 * `lint`). Each owner keeps its own filter, so a ceiling stays bounded by
 * the patch that declared it instead of merging into a file-wide union; an
 * issue is dropped when any owner waives it.
 */
export function filterLintIgnoredByOwners(
  issues: PatchLintIssue[],
  owners: ReadonlyArray<
    { lintIgnore?: LintIgnoreEntry[]; filesAffected: readonly string[] } | null | undefined
  >
): PatchLintIssue[] {
  const byFile = new Map<string, LintIgnoreChecks[]>();
  for (const owner of owners) {
    const checks = buildLintIgnoreChecks(owner?.lintIgnore);
    if (!checks) continue;
    for (const file of owner?.filesAffected ?? []) {
      byFile.set(file, [...(byFile.get(file) ?? []), checks]);
    }
  }
  if (byFile.size === 0) return issues;
  return issues.filter(
    (issue) => !(byFile.get(issue.file) ?? []).some((checks) => isLintIgnored(issue, checks))
  );
}

/** Where a ceiling stands against the patch's current measurements. */
export type LintIgnoreCeilingState = 'within' | 'exceeded' | 'removable';

/** One ceiling's standing, as `lint --per-patch --report` records it. */
export interface LintIgnoreCeilingStatus {
  rule: string;
  max: number;
  reason: string;
  /** The share the ceiling bounds, when it is share-scoped. */
  share?: PatchSizeShare;
  /** The ceiling's `meta`, verbatim, when it has one. */
  meta?: Record<string, unknown>;
  /** Largest current measurement for the rule, null when none was taken. */
  measurement: number | null;
  /**
   * `exceeded`: a warning- or error-band finding measured past `max` and
   * surfaced. A notice never exceeds a ceiling: it gates nothing.
   * `removable`: the rule no longer reaches its own warning band, so the
   * waiver changes no gate and can be dropped.
   * `within`: the waiver is doing its job.
   */
  state: LintIgnoreCeilingState;
}

/**
 * One waiver's standing, bare or ceiling, as the report's
 * `lintIgnoreWaivers` records it. A bare waiver has `max: null`; its
 * `state` is `within` while the rule still finds something to suppress at
 * warning band or above, and `removable` otherwise (informational: a bare
 * waiver of a rule this lint does not run reads as removable too).
 */
export interface LintIgnoreWaiverStatus {
  kind: 'bare' | 'ceiling';
  rule: string;
  max: number | null;
  reason: string | null;
  share?: PatchSizeShare;
  meta?: Record<string, unknown>;
  measurement: number | null;
  state: LintIgnoreCeilingState;
}

/** Patch-level measurements a size rule falls back to when it did not fire. */
interface PatchMeasurements {
  lines: number;
  files: number;
}

function judgeWaiver(
  rule: string,
  max: number | null,
  share: PatchSizeShare | undefined,
  issues: readonly PatchLintIssue[],
  patchMeasurements: PatchMeasurements
): { measurement: number | null; state: LintIgnoreCeilingState } {
  const findings = issues.filter(
    (issue) => issue.check === rule && (share === undefined || issue.share === share)
  );
  const measured = findings
    .map((issue) => issue.measurement)
    .filter((value): value is number => value !== undefined);
  // A share-scoped ceiling has no patch-level fallback: the total counts
  // both shares, which is not what it bounds.
  const fallback =
    share !== undefined
      ? null
      : rule === 'large-patch-lines'
        ? patchMeasurements.lines
        : rule === 'large-patch-files'
          ? patchMeasurements.files
          : null;
  const measurement = measured.length > 0 ? Math.max(...measured) : fallback;
  const gating = findings.filter((issue) => issue.severity !== 'notice');
  const exceeded =
    max !== null &&
    gating.some((issue) => issue.measurement !== undefined && issue.measurement > max);
  const state: LintIgnoreCeilingState = exceeded
    ? 'exceeded'
    : gating.length > 0
      ? 'within'
      : 'removable';
  return { measurement, state };
}

/**
 * Evaluates each ceiling on a patch against the findings its lint produced
 * (both surfaced and suppressed).
 *
 * @param entries - The patch's `lintIgnore`
 * @param issues - Every finding of the patch's lint, surfaced and suppressed
 * @param patchMeasurements - Patch-level measurements used when a
 *   patch-size rule did not fire at all, so the report still shows the
 *   current number
 */
export function evaluateLintIgnoreCeilings(
  entries: readonly LintIgnoreEntry[] | undefined,
  issues: readonly PatchLintIssue[],
  patchMeasurements: PatchMeasurements
): LintIgnoreCeilingStatus[] {
  const statuses: LintIgnoreCeilingStatus[] = [];
  for (const entry of entries ?? []) {
    if (!isLintIgnoreCeiling(entry)) continue;
    statuses.push({
      rule: entry.rule,
      max: entry.max,
      reason: entry.reason,
      ...(entry.share !== undefined ? { share: entry.share } : {}),
      ...(entry.meta !== undefined ? { meta: entry.meta } : {}),
      ...judgeWaiver(entry.rule, entry.max, entry.share, issues, patchMeasurements),
    });
  }
  return statuses;
}

/**
 * Evaluates every waiver on a patch, bare IDs included, so a waiver audit
 * reads each one's current measurement from the report instead of
 * re-measuring bare waivers from `suppressedIssues`.
 *
 * @param entries - The patch's `lintIgnore`
 * @param issues - Every finding of the patch's lint, surfaced and suppressed
 * @param patchMeasurements - See {@link evaluateLintIgnoreCeilings}
 */
export function evaluateLintIgnoreWaivers(
  entries: readonly LintIgnoreEntry[] | undefined,
  issues: readonly PatchLintIssue[],
  patchMeasurements: PatchMeasurements
): LintIgnoreWaiverStatus[] {
  return (entries ?? []).map((entry): LintIgnoreWaiverStatus => {
    if (!isLintIgnoreCeiling(entry)) {
      return {
        kind: 'bare',
        rule: entry,
        max: null,
        reason: null,
        ...judgeWaiver(entry, null, undefined, issues, patchMeasurements),
      };
    }
    return {
      kind: 'ceiling',
      rule: entry.rule,
      max: entry.max,
      reason: entry.reason,
      ...(entry.share !== undefined ? { share: entry.share } : {}),
      ...(entry.meta !== undefined ? { meta: entry.meta } : {}),
      ...judgeWaiver(entry.rule, entry.max, entry.share, issues, patchMeasurements),
    };
  });
}

/**
 * Notice-severity findings for ceilings that are no longer needed, so the
 * waiver's removal is prompted by the tool that enforces it rather than
 * discovered by hand.
 */
export function removableCeilingIssues(
  patchFilename: string,
  statuses: readonly LintIgnoreCeilingStatus[]
): PatchLintIssue[] {
  return statuses
    .filter((status) => status.state === 'removable')
    .map((status) => {
      const now =
        status.measurement === null ? 'below its notice band' : `at ${String(status.measurement)}`;
      const share = status.share === undefined ? '' : `, ${status.share} share`;
      return {
        file: patchFilename,
        check: 'lint-ignore-removable',
        message:
          `lintIgnore ceiling for ${status.rule} (max ${String(status.max)}${share}) is no longer needed: ` +
          `the measurement is ${now}, under the rule's own warning threshold. ` +
          `Remove it with "fireforge patch lint-ignore ${patchFilename} --remove ${status.rule} --yes".`,
        severity: 'notice' as const,
      };
    });
}
