// SPDX-License-Identifier: EUPL-1.2
/**
 * `PatchMetadata.lintIgnore` entries and the waiver filter they drive.
 *
 * An entry is either a bare check ID, which suppresses that rule at any
 * size, or a ceiling `{ rule, max, reason }`, which suppresses a size rule
 * only while its measurement is at or below `max`. The bare form let a
 * waived file grow without bound: nothing re-examined the waiver once it
 * was written, so a 950-line file waived at review time was still waived at
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

/**
 * A waiver filter: the bare check IDs as a set (so a plain `Set<string>`
 * still satisfies the type), plus the ceilings keyed by rule.
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

/** One-word rendering for summaries and dry runs: `file-too-large<=1200`. */
export function formatLintIgnoreEntry(entry: LintIgnoreEntry): string {
  return isLintIgnoreCeiling(entry) ? `${entry.rule}<=${String(entry.max)}` : entry;
}

/** Renders a list for messages, `(empty)` when there is nothing to show. */
export function formatLintIgnoreList(entries: readonly LintIgnoreEntry[]): string {
  return entries.length > 0 ? entries.map(formatLintIgnoreEntry).join(', ') : '(empty)';
}

function sameEntry(a: LintIgnoreEntry, b: LintIgnoreEntry): boolean {
  if (!isLintIgnoreCeiling(a) || !isLintIgnoreCeiling(b)) return a === b;
  return a.rule === b.rule && a.max === b.max && a.reason === b.reason;
}

/**
 * Validates a raw `lintIgnore` value from `patches.json`.
 *
 * Bare strings keep their historical leniency (any ID, duplicates collapse
 * later). A ceiling must name a measured size rule, carry a positive
 * integer `max` and a non-empty `reason`, and must be the only entry for
 * its rule: a bare ID beside a ceiling for the same rule would make the
 * ceiling dead, and two ceilings would leave the effective one ambiguous.
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
  for (const entry of entries) {
    if (!isLintIgnoreCeiling(entry)) continue;
    if (ceilingRules.has(entry.rule) || entries.includes(entry.rule)) {
      throw new Error(
        `${label} names "${entry.rule}" more than once; keep a single entry (bare or ceiling) per rule`
      );
    }
    ceilingRules.add(entry.rule);
  }
  return entries;
}

function parseCeiling(item: unknown, label: string): LintIgnoreCeiling {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error(`${label} must be a check ID string or a { rule, max, reason } object`);
  }
  const record = item as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter(
    (key) => key !== 'rule' && key !== 'max' && key !== 'reason'
  );
  if (unknownKeys.length > 0) {
    throw new Error(`${label} has unknown field(s): ${unknownKeys.join(', ')}`);
  }
  const { rule, max, reason } = record;
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
  return { rule, max, reason };
}

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
    if (isLintIgnoreCeiling(entry)) ceilings.set(entry.rule, entry);
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
 * it is confirmed explicitly.
 *
 * @returns The merged list, or undefined when it is empty
 */
export function mergeLintIgnoreIds(
  existing: readonly LintIgnoreEntry[] | undefined,
  ids: readonly string[] | undefined
): LintIgnoreEntry[] | undefined {
  const merged: LintIgnoreEntry[] = [];
  const rules = new Set<string>();
  for (const entry of [...(existing ?? []), ...(ids ?? [])]) {
    const rule = lintIgnoreRule(entry);
    if (rules.has(rule)) continue;
    rules.add(rule);
    merged.push(entry);
  }
  return merged.length > 0 ? merged : undefined;
}

/**
 * Adds or replaces entries by rule, the `patch lint-ignore --add` semantics:
 * an explicit `--add <rule>` turns a ceiling into a bare waiver, and
 * `--add <rule> --max <n>` sets or moves the ceiling.
 *
 * @returns The new list, or undefined when it is empty
 */
export function upsertLintIgnoreEntries(
  existing: readonly LintIgnoreEntry[],
  additions: readonly LintIgnoreEntry[]
): LintIgnoreEntry[] | undefined {
  const next = [...existing];
  for (const addition of additions) {
    const rule = lintIgnoreRule(addition);
    const index = next.findIndex((entry) => lintIgnoreRule(entry) === rule);
    if (index === -1) next.push(addition);
    else next[index] = addition;
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
    const ceiling = checks?.ceilings?.get(issue.check);
    if (ceiling === undefined) {
      kept.push(issue);
      continue;
    }
    if (issue.measurement !== undefined && issue.measurement <= ceiling.max) {
      suppressed.push(issue);
      continue;
    }
    kept.push({ ...issue, message: `${issue.message} ${describeExceededCeiling(ceiling)}` });
  }
  return { kept, suppressed };
}

function describeExceededCeiling(ceiling: LintIgnoreCeiling): string {
  return (
    `This exceeds the patch's lintIgnore ceiling for ${ceiling.rule} ` +
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
  /** Largest current measurement for the rule, null when none was taken. */
  measurement: number | null;
  /**
   * `exceeded`: a finding measured past `max` and surfaced.
   * `removable`: the rule no longer reaches its own warning band, so the
   * waiver changes no gate and can be dropped.
   * `within`: the waiver is doing its job.
   */
  state: LintIgnoreCeilingState;
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
  patchMeasurements: { lines: number; files: number }
): LintIgnoreCeilingStatus[] {
  const statuses: LintIgnoreCeilingStatus[] = [];
  for (const entry of entries ?? []) {
    if (!isLintIgnoreCeiling(entry)) continue;
    const findings = issues.filter((issue) => issue.check === entry.rule);
    const measured = findings
      .map((issue) => issue.measurement)
      .filter((value): value is number => value !== undefined);
    const fallback =
      entry.rule === 'large-patch-lines'
        ? patchMeasurements.lines
        : entry.rule === 'large-patch-files'
          ? patchMeasurements.files
          : null;
    const measurement = measured.length > 0 ? Math.max(...measured) : fallback;
    const gating = findings.some((issue) => issue.severity !== 'notice');
    const state: LintIgnoreCeilingState = measured.some((value) => value > entry.max)
      ? 'exceeded'
      : gating
        ? 'within'
        : 'removable';
    statuses.push({ rule: entry.rule, max: entry.max, reason: entry.reason, measurement, state });
  }
  return statuses;
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
      return {
        file: patchFilename,
        check: 'lint-ignore-removable',
        message:
          `lintIgnore ceiling for ${status.rule} (max ${String(status.max)}) is no longer needed: ` +
          `the measurement is ${now}, under the rule's own warning threshold. ` +
          `Remove it with "fireforge patch lint-ignore ${patchFilename} --remove ${status.rule}".`,
        severity: 'notice' as const,
      };
    });
}
