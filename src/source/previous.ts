// SPDX-License-Identifier: EUPL-1.2
/**
 * The previous format of a source-mode project's metadata, and its
 * conversion to the current one. This file is the only place that knows it:
 *
 * - override records carried `schemaVersion`, their own `path` and the
 *   archive digest `base.pin` beside the fields a record holds today;
 * - `waivers.json` held the lint waivers and size tiers of the patches the
 *   project was first cut from, each with the paths it covered;
 * - `policy.json` held a reviewed decision per `patchPolicy.scopeRules`
 *   entry: `retire` it, or `retain` it as a path scope;
 * - `cutover-map.json` and `legacy-manifest.json` authenticated the two;
 * - the merge driver was called `fireforge-authored`.
 *
 * Everything here is a pure function of file content. Nothing is guessed: a
 * file that is neither the current nor the previous format is a problem the
 * caller reports.
 */
import { hash } from '../kernel/hash.js';
import { isRecord, type JsonValue, omitKeys, parseJson } from '../kernel/json.js';
import { s } from '../kernel/schema.js';
import { MERGE_DRIVER } from './merge.js';
import { encodeRecord, overrideRecordSchema } from './records.js';

/** The merge driver's earlier name in `.gitattributes` and git configuration. */
export const PREVIOUS_MERGE_DRIVER = 'fireforge-authored';

/** Files of the metadata root that only the previous format read. */
export const PREVIOUS_METADATA_FILES = [
  'waivers.json',
  'policy.json',
  'cutover-map.json',
  'legacy-manifest.json',
] as const;

/** The outcome of converting one record file. */
export type RecordUpgrade =
  | { readonly state: 'current' }
  | { readonly state: 'converted'; readonly text: string }
  | { readonly state: 'invalid'; readonly problem: string };

/**
 * Converts an override record of the previous format to the current bytes.
 *
 * @param text - The record file's content
 * @param path - The engine path the file's location names
 */
export function upgradeRecord(text: string, path: string): RecordUpgrade {
  let value: JsonValue;
  try {
    value = parseJson(text);
  } catch {
    return { state: 'invalid', problem: 'is not JSON' };
  }
  if (overrideRecordSchema.validate(value).ok) return { state: 'current' };
  if (!isRecord(value) || !isRecord(value['base'])) {
    return { state: 'invalid', problem: 'is not an override record' };
  }
  const { schemaVersion, path: recorded, base, ...rest } = value;
  if (schemaVersion !== 1) {
    return { state: 'invalid', problem: `has schemaVersion ${JSON.stringify(schemaVersion)}` };
  }
  if (recorded !== path) {
    return {
      state: 'invalid',
      problem: `names path ${JSON.stringify(recorded)}, not the path of its own location`,
    };
  }
  const result = overrideRecordSchema.validate({ ...rest, base: omitKeys(base, 'pin') });
  if (!result.ok) {
    const [issue] = result.issues;
    return {
      state: 'invalid',
      problem: `"${issue?.path ?? ''}" ${issue?.message ?? 'is invalid'}`,
    };
  }
  return { state: 'converted', text: encodeRecord(result.value) };
}

/**
 * A source root's `.gitattributes` with the previous merge driver replaced
 * by the current one, or undefined when it does not name the previous one.
 *
 * @param text - The file's content
 */
export function upgradeAttributes(text: string): string | undefined {
  const pattern = new RegExp(`(^|\\s)merge=${PREVIOUS_MERGE_DRIVER}(?=\\s|$)`, 'gm');
  const next = text.replace(pattern, `$1merge=${MERGE_DRIVER}`);
  return next === text ? undefined : next;
}

const ceiling = s.object({
  rule: s.string({ min: 1 }),
  max: s.int({ min: 0 }),
  reason: s.string({ min: 1 }),
  share: s.enum(['product', 'test']).optional(),
  meta: s.record(s.unknown()).optional(),
});

const waiversSchema = s.object({
  schemaVersion: s.literal(1),
  exceptions: s.array(
    s.object({
      component: s.string({ min: 1 }),
      paths: s.array(s.string({ min: 1 })),
      checks: s.array(s.union(s.string({ min: 1 }), ceiling)),
      tier: s.literal('branding').optional(),
      provenance: s.string().optional(),
    })
  ),
});

/** One check of a previous waiver: a bare rule ID, or a ceiling. */
export type PreviousCheck =
  | string
  | {
      readonly rule: string;
      readonly max: number;
      readonly reason: string;
      readonly share?: 'product' | 'test';
      readonly meta?: Readonly<Record<string, unknown>>;
    };

/**
 * What the previous format waived for the files one patch had held. A check
 * applied to a finding on one of `paths`, or to a size finding about the
 * upstream changes of `component`.
 */
export interface PreviousWaiver {
  readonly component: string;
  readonly paths: readonly string[];
  readonly checks: readonly PreviousCheck[];
  readonly tier?: 'branding';
}

/**
 * Reads a `waivers.json`.
 *
 * @param text - The file's content
 * @param source - The file's path, for messages
 * @throws `migrate-metadata-invalid` (exit code 2) when it is not the previous format
 */
export function parsePreviousWaivers(text: string, source: string): PreviousWaiver[] {
  const { exceptions } = waiversSchema.parse(parseJson(text, { source }), {
    source,
    code: 'migrate-metadata-invalid',
  });
  return exceptions.map(({ component, paths, checks, tier }) => ({
    component,
    paths,
    checks,
    ...(tier === undefined ? {} : { tier }),
  }));
}

const policySchema = s.object({
  schemaVersion: s.literal(1),
  status: s.literal('approved'),
  adr: s.string().optional(),
  legacyScopeDigest: s.string().optional(),
  retireCreatedPatchBudgets: s.boolean().optional(),
  createdPatchBudgetReason: s.string().optional(),
  scopeRules: s.array(
    s.object({
      legacyRule: s.string({ min: 1 }),
      decision: s.enum(['retire', 'retain']),
      reason: s.string({ min: 1 }),
      select: s.array(s.string()).optional(),
      allow: s.array(s.string()).optional(),
    })
  ),
});

/** The reviewed decision on one `patchPolicy.scopeRules` entry. */
export interface ScopeDecision {
  readonly decision: 'retire' | 'retain';
  readonly reason: string;
}

/** JSON with sorted keys and no whitespace, the form the previous format hashed. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`;
}

/**
 * The decision a `policy.json` holds for each scope rule, by the rule's
 * index. A decision is bound to its rule by a digest of the rule and its
 * position, so a rule edited since the review has none.
 *
 * @param text - The file's content
 * @param source - The file's path, for messages
 * @param rules - `patchPolicy.scopeRules` as the previous format wrote them
 * @throws `migrate-metadata-invalid` (exit code 2) when it is not the previous format
 */
export function parseScopeDecisions(
  text: string,
  source: string,
  rules: readonly JsonValue[]
): (ScopeDecision | undefined)[] {
  const policy = policySchema.parse(parseJson(text, { source }), {
    source,
    code: 'migrate-metadata-invalid',
  });
  return rules.map((rule, index) => {
    const id = hash(canonical({ index, rule }));
    const found = policy.scopeRules.find((entry) => entry.legacyRule === id);
    return found === undefined ? undefined : { decision: found.decision, reason: found.reason };
  });
}
