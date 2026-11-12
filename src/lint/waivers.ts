// SPDX-License-Identifier: EUPL-1.2
/**
 * Suppression: a group's `lintIgnore` entries waive findings on its work.
 *
 * A bare rule ID waives the rule's findings at any size. A ceiling
 * `{ rule, max, reason, share? }` waives a measured finding only while its
 * measurement stays at or below `max`, so growth past the reviewed size
 * surfaces again; a finding without a measurement surfaces (fail closed),
 * and a notice past the ceiling surfaces as the plain notice it is. A
 * finding is judged against the group it is attributed to and every group
 * with a step on its path.
 */
import type { ChangeSet, LintIgnoreEntry } from '../project/index.js';
import type { Finding, SizeShare } from './rule.js';

type Ceiling = Exclude<LintIgnoreEntry, string>;

/** Where a waiver stands against the current findings. */
export type WaiverState = 'within' | 'exceeded' | 'removable';

/** One waiver of one group and its standing. */
export interface WaiverStatus {
  readonly group: string;
  readonly rule: string;
  /** The ceiling, or null for a bare waiver. */
  readonly max: number | null;
  readonly reason: string | null;
  readonly share?: SizeShare;
  /** The largest measurement among the rule's findings, or null when none was taken. */
  readonly measurement: number | null;
  /**
   * `exceeded`: a warning or error measured past the ceiling surfaced.
   * `removable`: the rule finds nothing at warning or error on the group,
   * so the waiver changes no outcome. `within`: it is doing its job.
   */
  readonly state: WaiverState;
}

/** The outcome of {@link applyWaivers}. */
export interface WaiverOutcome {
  readonly kept: Finding[];
  readonly suppressed: Finding[];
  readonly waivers: WaiverStatus[];
}

function ceilingOf(entries: readonly LintIgnoreEntry[], finding: Finding): Ceiling | undefined {
  const ceilings = entries.filter(
    (entry): entry is Ceiling => typeof entry !== 'string' && entry.rule === finding.rule
  );
  return (
    ceilings.find((entry) => entry.share !== undefined && entry.share === finding.share) ??
    ceilings.find((entry) => entry.share === undefined)
  );
}

function exceededText(ceiling: Ceiling): string {
  const share = ceiling.share === undefined ? '' : ` (${ceiling.share} share)`;
  return `This exceeds the lintIgnore ceiling for ${ceiling.rule}${share} (max ${ceiling.max}: ${ceiling.reason}).`;
}

/** The groups whose waivers apply to a finding. */
function governingGroups(changes: ChangeSet, finding: Finding): string[] {
  const groups = new Set<string>();
  if (finding.group !== undefined) groups.add(finding.group);
  if (finding.path !== undefined) {
    for (const step of changes.at(finding.path))
      if (step.group !== undefined) groups.add(step.group);
  }
  return [...groups];
}

function judge(changes: ChangeSet, finding: Finding): { suppressed: boolean; finding: Finding } {
  let exceeded: Ceiling | undefined;
  for (const id of governingGroups(changes, finding)) {
    const entries = changes.group(id)?.lintIgnore ?? [];
    if (entries.includes(finding.rule)) return { suppressed: true, finding };
    const ceiling = ceilingOf(entries, finding);
    if (ceiling === undefined) continue;
    if (finding.measurement !== undefined && finding.measurement <= ceiling.max) {
      return { suppressed: true, finding };
    }
    exceeded ??= ceiling;
  }
  if (exceeded === undefined || finding.severity === 'notice')
    return { suppressed: false, finding };
  return {
    suppressed: false,
    finding: { ...finding, message: `${finding.message} ${exceededText(exceeded)}` },
  };
}

function status(group: string, entry: LintIgnoreEntry, findings: readonly Finding[]): WaiverStatus {
  const rule = typeof entry === 'string' ? entry : entry.rule;
  const share = typeof entry === 'string' ? undefined : entry.share;
  const max = typeof entry === 'string' ? null : entry.max;
  const relevant = findings.filter(
    (finding) => finding.rule === rule && (share === undefined || finding.share === share)
  );
  const measured = relevant.flatMap((finding) =>
    finding.measurement === undefined ? [] : [finding.measurement]
  );
  const gating = relevant.filter((finding) => finding.severity !== 'notice');
  const exceeded =
    max !== null &&
    gating.some((finding) => finding.measurement !== undefined && finding.measurement > max);
  return {
    group,
    rule,
    max,
    reason: typeof entry === 'string' ? null : entry.reason,
    ...(share === undefined ? {} : { share }),
    measurement: measured.length > 0 ? Math.max(...measured) : null,
    state: exceeded ? 'exceeded' : gating.length > 0 ? 'within' : 'removable',
  };
}

/**
 * Splits findings into those that surface and those a waiver drops, and
 * judges every waiver of every group against them. A ceiling that no
 * longer changes an outcome adds a `lint-ignore-removable` notice.
 *
 * @param changes - The owned changes, whose groups carry the waivers
 * @param findings - Every finding of the run
 */
export function applyWaivers(changes: ChangeSet, findings: readonly Finding[]): WaiverOutcome {
  const kept: Finding[] = [];
  const suppressed: Finding[] = [];
  for (const finding of findings) {
    const outcome = judge(changes, finding);
    (outcome.suppressed ? suppressed : kept).push(outcome.finding);
  }
  const waivers = changes.groups.flatMap((group) => {
    const own = findings.filter((finding) => governingGroups(changes, finding).includes(group.id));
    return (group.lintIgnore ?? []).map((entry) => status(group.id, entry, own));
  });
  for (const waiver of waivers) {
    if (waiver.max === null || waiver.state !== 'removable') continue;
    kept.push({
      rule: 'lint-ignore-removable',
      severity: 'notice',
      group: waiver.group,
      message:
        `The lintIgnore ceiling for ${waiver.rule} (max ${waiver.max}${waiver.share === undefined ? '' : `, ${waiver.share} share`}) ` +
        `is no longer needed: the rule reports nothing at warning or error on ${waiver.group}. Remove it.`,
    });
  }
  return { kept, suppressed, waivers };
}
