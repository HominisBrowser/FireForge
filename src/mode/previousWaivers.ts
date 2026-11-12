// SPDX-License-Identifier: EUPL-1.2
/**
 * Placing the waivers of the previous format on groups. A previous waiver
 * named the paths one patch had held; a current one names a group, so each
 * check goes to the groups that hold exactly those paths:
 *
 * - A size check measured the upstream changes of the waiver's component,
 *   which is a group by the same name.
 * - Any other check applied per path. Upstream paths are in their
 *   component's group. Created paths are reached through the declared
 *   `exportQueue.groups` they fill completely; the rest get a group of their
 *   own, named after the component, so the waiver reaches them and no other
 *   file. Files a Furnace component deploys are in that component's group,
 *   which no configuration can split.
 *
 * A check is never placed where it would reach a file the previous waiver
 * did not cover: it is a blocker, or, where only a person can decide to
 * waive the wider group, it is left out and reported.
 */
import { LINT_RULE_IDS, type LintRuleId, type UpgradeNote } from '../config/index.js';
import { isRecord, type JsonObject, type JsonValue } from '../kernel/json.js';
import { exportedPatchName, type PreviousWaiver, type SourceStatus } from '../source/index.js';

/** One `patchLint.waivers` entry. */
type ConfigWaiver = {
  group: string;
  rule: string;
  max?: number;
  reason: string;
  share?: 'product' | 'test';
};

/** Where the previous waivers go, and what could not be placed. */
export type WaiverPlacement = {
  waivers: ConfigWaiver[];
  componentTiers: Record<string, 'branding'>;
  /** New `exportQueue.groups` entries, which go before the declared ones. */
  groups: { name: string; paths: string[] }[];
  converted: UpgradeNote[];
  removed: UpgradeNote[];
  /** Checks left out because placing them needs a decision; lint reports what they covered. */
  manual: UpgradeNote[];
  blockers: UpgradeNote[];
};

/** Rules that measure a whole group rather than judge one path. */
const SIZE_RULES = new Set(['large-patch-lines', 'large-patch-files']);

/** The owned paths as the placement reads them. */
type Owned = {
  entries: ReadonlyMap<string, { path: string; kind: string; group: string }>;
  members: ReadonlyMap<string, readonly string[]>;
  components: ReadonlySet<string>;
  /** `exportQueue.groups` names, whose membership globs fix. */
  declared: ReadonlySet<string>;
  /** Groups of the files Furnace components deploy. */
  furnace: ReadonlySet<string>;
  /** Every group ID in use, the new ones included. */
  taken: Set<string>;
};

/**
 * The groups a per-path check of one waiver lands on, or the reason it
 * cannot be placed. Creates the waiver's own group of created files when it
 * needs one.
 */
function perPathGroups(
  waiver: PreviousWaiver,
  owned: Owned,
  plan: WaiverPlacement
): { groups: string[]; partial: string[] } | { blocker: string } {
  const covered = new Set(waiver.paths);
  const inside = (group: string): boolean =>
    (owned.members.get(group) ?? []).every((path) => covered.has(path));
  const live = waiver.paths.flatMap((path) => owned.entries.get(path) ?? []);
  const upstream = new Set(
    live.filter((entry) => entry.kind !== 'create').map((entry) => entry.group)
  );
  const widened = [...upstream].filter((group) => !inside(group));
  if (widened.length > 0) {
    return {
      blocker: `covers some upstream paths of component ${widened.join(', ')} and not others; a waiver names a whole group`,
    };
  }
  const whole = new Set<string>();
  const partial = new Set<string>();
  const loose: string[] = [];
  for (const entry of live.filter((candidate) => candidate.kind === 'create')) {
    const fixed = owned.declared.has(entry.group) || owned.furnace.has(entry.group);
    if (fixed && inside(entry.group)) whole.add(entry.group);
    else if (owned.furnace.has(entry.group)) partial.add(entry.group);
    else loose.push(entry.path);
  }
  if (loose.length === 0) return { groups: [...upstream, ...whole], partial: [...partial] };
  const name = exportedPatchName(waiver.component);
  if (!plan.groups.some((group) => group.name === name)) {
    const unsafe = loose.find((path) => /[*?]/.test(path));
    if (unsafe !== undefined)
      return { blocker: `covers ${unsafe}, which a glob cannot name literally` };
    if (owned.taken.has(name)) {
      return {
        blocker: `needs a group "${name}" for the created files it covers, and that ID is taken; declare an exportQueue.groups entry holding exactly those files`,
      };
    }
    owned.taken.add(name);
    plan.groups.push({ name, paths: [...loose].sort() });
    plan.converted.push({
      key: `waivers.json ${waiver.component}`,
      message: `its ${loose.length} created file(s) are now exportQueue group "${name}", which its waivers name`,
    });
  }
  return { groups: [...upstream, ...whole, name], partial: [...partial] };
}

function placeWaiver(waiver: PreviousWaiver, owned: Owned, plan: WaiverPlacement): void {
  const at = `waivers.json ${waiver.component}`;
  const isComponent = owned.components.has(waiver.component);
  const add = (entry: ConfigWaiver): void => {
    const same = (other: ConfigWaiver): boolean =>
      other.group === entry.group && other.rule === entry.rule && other.share === entry.share;
    if (!plan.waivers.some(same)) plan.waivers.push(entry);
  };
  if (waiver.tier !== undefined && isComponent) {
    plan.componentTiers[waiver.component] = waiver.tier;
    plan.converted.push({ key: `${at} tier`, message: 'is now exportQueue.componentTiers' });
  } else if (waiver.tier !== undefined) {
    plan.removed.push({
      key: `${at} tier`,
      message: 'the tier bounded the upstream changes of the component, which has none',
    });
  }
  for (const [index, check] of waiver.checks.entries()) {
    const key = `${at} checks[${index}]`;
    const rule = typeof check === 'string' ? check : check.rule;
    if (!LINT_RULE_IDS.includes(rule as LintRuleId)) {
      plan.blockers.push({ key, message: `waives "${rule}", which is not a lint rule` });
      continue;
    }
    const entry = (group: string): ConfigWaiver =>
      typeof check === 'string'
        ? { group, rule, reason: `Carried over from ${waiver.component}` }
        : {
            group,
            rule,
            max: check.max,
            reason: check.reason,
            ...(check.share === undefined ? {} : { share: check.share }),
          };
    if (typeof check !== 'string' && check.meta !== undefined) {
      plan.removed.push({
        key: `${key}.meta`,
        message: `a waiver holds no notes besides its reason; it held ${JSON.stringify(check.meta)}`,
      });
    }
    if (SIZE_RULES.has(rule)) {
      if (isComponent) add(entry(waiver.component));
      else {
        plan.removed.push({
          key,
          message: `"${rule}" bounded the upstream changes of the component, which has none`,
        });
      }
      continue;
    }
    const placed = perPathGroups(waiver, owned, plan);
    if ('blocker' in placed) {
      plan.blockers.push({ key, message: placed.blocker });
      continue;
    }
    if (placed.groups.length + placed.partial.length === 0) {
      plan.removed.push({ key, message: `"${rule}" covered paths the project no longer owns` });
    }
    for (const group of placed.groups) add(entry(group));
    for (const group of placed.partial) {
      plan.manual.push({
        key,
        message:
          `"${rule}" covered some files of Furnace component ${group} and not others; a waiver names a whole group. ` +
          `It was not carried over: add ${JSON.stringify(entry(group))} to patchLint.waivers to waive the whole component, or fix what lint reports`,
      });
    }
  }
}

/**
 * Places every previous waiver on the groups of the project's owned paths.
 *
 * @param previous - The waivers of the previous format
 * @param status - The owned paths and their groups
 * @param declared - The names of the declared `exportQueue.groups`
 * @param components - The files each Furnace component deploys
 */
export function placeWaivers(
  previous: readonly PreviousWaiver[],
  status: SourceStatus,
  declared: ReadonlySet<string>,
  components: readonly { id: string; paths: readonly string[] }[] = []
): WaiverPlacement {
  const plan: WaiverPlacement = {
    waivers: [],
    componentTiers: {},
    groups: [],
    converted: [],
    removed: [],
    manual: [],
    blockers: [],
  };
  const deployed = components.flatMap((component) =>
    component.paths.map((path) => ({ path, kind: 'create', group: component.id }))
  );
  // A path the source root owns stays the source root's.
  const entries = new Map([...deployed, ...status.owned].map((entry) => [entry.path, entry]));
  const members = new Map<string, string[]>();
  for (const entry of entries.values()) {
    members.set(entry.group, [...(members.get(entry.group) ?? []), entry.path]);
  }
  const owned: Owned = {
    entries,
    members,
    components: new Set(
      status.groups.filter((group) => group.kind === 'component').map((group) => group.id)
    ),
    declared,
    furnace: new Set(components.map((component) => component.id)),
    taken: new Set([...status.groups, ...components].map((group) => group.id)),
  };
  for (const waiver of previous) placeWaiver(waiver, owned, plan);
  return plan;
}

/**
 * A `fireforge.json` document with a placement merged into `patchLint` and
 * `exportQueue`.
 *
 * @param document - The document in the current format
 * @param plan - From {@link placeWaivers}
 */
export function withWaivers(document: JsonObject, plan: WaiverPlacement): JsonObject {
  const object = (value: JsonValue | undefined): JsonObject => (isRecord(value) ? value : {});
  const list = (value: JsonValue | undefined): JsonValue[] => (Array.isArray(value) ? value : []);
  const lint = object(document['patchLint']);
  const queue = object(document['exportQueue']);
  const tiers = { ...object(queue['componentTiers']), ...plan.componentTiers };
  const exportQueue: JsonObject = {
    ...queue,
    ...(plan.groups.length === 0 ? {} : { groups: [...plan.groups, ...list(queue['groups'])] }),
    ...(Object.keys(tiers).length === 0 ? {} : { componentTiers: tiers }),
  };
  return {
    ...document,
    ...(plan.waivers.length === 0
      ? {}
      : { patchLint: { ...lint, waivers: [...list(lint['waivers']), ...plan.waivers] } }),
    ...(Object.keys(exportQueue).length === 0 ? {} : { exportQueue }),
  };
}
