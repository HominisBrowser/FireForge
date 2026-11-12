// SPDX-License-Identifier: EUPL-1.2
/**
 * The patch queue manifest, `patches/patches.json`: the one source of truth
 * for which patches exist, in which order, and what is known about each.
 *
 * A patch is identified by its `name` (lowercase words joined by hyphens,
 * the first word its category) and ordered by its `order` number. Nothing
 * else is stored that can be derived: the filename is
 * `<order, zero-padded to three digits>-<name>.patch`, the category is the
 * name's first word, and the files a patch touches are read from its body.
 *
 * The Firefox version a patch was last verified against is stored once for
 * the queue (the stamp most patches share) and on a row only where that row
 * differs, so restamping the whole queue after a rebase changes one line.
 *
 * Manifests of the earlier format (`"version": 1`, with `filename`,
 * `category`, `filesAffected` and per-row source fields) are read by
 * {@link parseManifest} and converted in memory; the next write of the queue
 * stores the current format.
 */
import { FIREFOX_PRODUCTS, type FirefoxProduct } from '../config/index.js';
import { ExitCode, FireForgeError } from '../kernel/errors.js';
import { isRecord, stringifyJson } from '../kernel/json.js';
import { type Infer, s } from '../kernel/schema.js';

/** The manifest's file name inside the queue directory. */
export const MANIFEST_FILE = 'patches.json';

const NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const patchName = s.string({
  pattern: NAME_PATTERN,
  format: 'lowercase words joined by hyphens, the first word the category, such as "ui-sidebar"',
});

/** The schema of a {@link FirefoxStamp}. */
export const firefoxStamp = s.object({
  product: s.enum(FIREFOX_PRODUCTS),
  version: s.string({ min: 1 }),
});

const lintCeiling = s.object({
  rule: s.string({ min: 1 }).describe('Size rule the waiver applies to'),
  max: s.int({ min: 0 }).describe('Largest measurement the waiver still suppresses'),
  reason: s.string({ min: 1 }).describe('Why the waiver exists'),
  share: s.enum(['test', 'product']).optional(),
  meta: s.record(s.unknown()).optional(),
});

const lintIgnoreEntry = s.union(s.string({ min: 1 }), lintCeiling);

const enginePath = s.string({ min: 1 });

const stagedDependency = s.object({
  file: enginePath.describe('File in this patch that imports or registers a later-created file'),
  creates: enginePath.describe('The file a later patch creates'),
  reason: s.string().optional(),
});

const patchRow = s.object({
  order: s.int({ min: 1 }).describe('Position in the apply order; gaps are allowed'),
  name: patchName,
  description: s.string().optional(),
  firefox: firefoxStamp.describe('Stamp when it differs from the queue stamp').optional(),
  tier: s.literal('branding').optional(),
  lintIgnore: s.array(lintIgnoreEntry).optional(),
  stagedDependencies: s.array(stagedDependency).optional(),
});

const retiredSlot = s.object({
  order: s.int({ min: 1 }),
  name: patchName,
  reason: s.string().optional(),
});

const queueSource = s.object({ snapshot: s.string({ min: 1 }) });

const manifestSchema = s.object({
  version: s.literal(2),
  source: queueSource.optional(),
  firefox: firefoxStamp.optional(),
  patches: s.array(patchRow),
  retired: s.array(retiredSlot).optional(),
});

/** The Firefox release a patch was last verified against. */
export type FirefoxStamp = Infer<typeof firefoxStamp>;

/** A `lintIgnore` entry: a bare rule ID, or a size waiver with a ceiling. */
export type LintIgnoreEntry = Infer<typeof lintIgnoreEntry>;

/**
 * A declared forward reference: `file`, in this patch, imports or registers
 * `creates`, which a later patch creates. Lint matches it against the
 * forward references it finds.
 */
export type StagedDependency = Infer<typeof stagedDependency>;

/** An order number a retired patch held, kept occupied for the gap check. */
export type RetiredSlot = Infer<typeof retiredSlot>;

/** Where a generated queue came from. */
export type QueueSource = Infer<typeof queueSource>;

/** What the manifest records about one patch. */
export interface PatchEntry {
  order: number;
  /** Unique identity; its first word is the category. */
  name: string;
  description: string;
  firefox: FirefoxStamp;
  tier?: 'branding';
  lintIgnore?: LintIgnoreEntry[];
  stagedDependencies?: StagedDependency[];
}

/** A manifest in memory: rows sorted by order, every row with its stamp. */
export interface Manifest {
  source?: QueueSource;
  patches: PatchEntry[];
  retired: RetiredSlot[];
}

/**
 * The category of a patch: the first word of its name.
 *
 * @param name - The patch name
 */
export function categoryOf(name: string): string {
  return name.split('-', 1)[0] ?? name;
}

/**
 * The file a patch is stored in: `<order>-<name>.patch`, the order padded to
 * at least three digits.
 *
 * @param entry - The patch's order and name
 */
export function patchFilename(entry: { order: number; name: string }): string {
  return `${String(entry.order).padStart(3, '0')}-${entry.name}.patch`;
}

/**
 * Whether a string is a valid patch name.
 *
 * @param name - The candidate
 */
export function isPatchName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

function invalid(source: string, message: string): FireForgeError {
  return new FireForgeError('queue-manifest-invalid', `${source}: ${message}`, {
    exitCode: ExitCode.PATCH_ERROR,
    hint: 'Repair the manifest by hand; "git diff patches/patches.json" shows what changed.',
  });
}

/**
 * Whether two stamps name the same release (two absent stamps do).
 *
 * @param a - A stamp
 * @param b - Another stamp
 */
export function sameStamp(a: FirefoxStamp | undefined, b: FirefoxStamp | undefined): boolean {
  return a?.product === b?.product && a?.version === b?.version;
}

/**
 * What is wrong with a manifest beyond its schema: duplicate orders or
 * names, retired slots that collide with live patches.
 *
 * @param manifest - The manifest
 * @returns One sentence per problem; empty when consistent
 */
export function manifestProblems(manifest: Manifest): string[] {
  const problems: string[] = [];
  const orders = new Map<number, string>();
  const names = new Set<string>();
  for (const entry of manifest.patches) {
    const other = orders.get(entry.order);
    if (other !== undefined) problems.push(`${entry.name} and ${other} share order ${entry.order}`);
    orders.set(entry.order, entry.name);
    if (names.has(entry.name)) problems.push(`two patches are named ${entry.name}`);
    names.add(entry.name);
    if (!isPatchName(entry.name)) problems.push(`"${entry.name}" is not a valid patch name`);
  }
  for (const slot of manifest.retired) {
    const holder = orders.get(slot.order);
    if (holder !== undefined)
      problems.push(`retired order ${slot.order} is held by live patch ${holder}`);
  }
  return problems;
}

/** Sorts rows by order and validates them; throws on any problem. */
function finish(manifest: Manifest, source: string): Manifest {
  manifest.patches.sort((a, b) => a.order - b.order);
  manifest.retired.sort((a, b) => a.order - b.order);
  const problems = manifestProblems(manifest);
  if (problems.length > 0) throw invalid(source, problems.join('; '));
  return manifest;
}

function fromCurrent(raw: unknown, source: string): Manifest {
  const document = manifestSchema.parse(raw, {
    source,
    code: 'queue-manifest-invalid',
    exitCode: ExitCode.PATCH_ERROR,
  });
  const patches = document.patches.map((row): PatchEntry => {
    const firefox = row.firefox ?? document.firefox;
    if (firefox === undefined) {
      throw invalid(source, `patch ${row.name} has no Firefox stamp and the queue sets none`);
    }
    return {
      order: row.order,
      name: row.name,
      description: row.description ?? '',
      firefox,
      ...(row.tier === undefined ? {} : { tier: row.tier }),
      ...(row.lintIgnore === undefined ? {} : { lintIgnore: row.lintIgnore }),
      ...(row.stagedDependencies === undefined
        ? {}
        : { stagedDependencies: row.stagedDependencies }),
    };
  });
  return finish(
    {
      ...(document.source === undefined ? {} : { source: document.source }),
      patches,
      retired: document.retired ?? [],
    },
    source
  );
}

const rowV1 = s.object(
  {
    filename: s.string({ pattern: /^\d+-.+\.patch$/, format: 'a patch filename' }),
    order: s.int({ min: 1 }),
    category: s.string({ min: 1 }),
    name: s.string({ min: 1 }),
    description: s.string().optional(),
    sourceProduct: s.enum(FIREFOX_PRODUCTS).optional(),
    sourceVersion: s.string({ min: 1 }).optional(),
    sourceEsrVersion: s.string({ min: 1 }).optional(),
    tier: s.literal('branding').optional(),
    lintIgnore: s.array(lintIgnoreEntry).optional(),
    stagedDependencies: s.unknown().optional(),
  },
  { unknownKeys: 'keep' }
);

const manifestV1 = s.object(
  {
    version: s.literal(1),
    source: queueSource.optional(),
    patches: s.array(rowV1),
    retired: s
      .array(
        s.object(
          {
            order: s.int({ min: 1 }),
            filename: s.string({ min: 1 }),
            reason: s.string().optional(),
          },
          { unknownKeys: 'keep' }
        )
      )
      .optional(),
  },
  { unknownKeys: 'keep' }
);

/** The name a version-1 filename encodes: the filename without its order prefix and extension. */
function stemOf(filename: string): string {
  return filename.replace(/^\d+-/, '').replace(/\.patch$/, '');
}

function productOf(version: string): FirefoxProduct {
  if (/esr$/i.test(version)) return 'firefox-esr';
  return /b\d+$/.test(version) ? 'firefox-beta' : 'firefox';
}

/**
 * Flattens version-1 `forwardImports` and `registrations` declarations into
 * `{ file, creates, reason }`, the pair lint matches; the import specifier,
 * the registration line and the owner are not kept.
 */
function dependenciesV1(raw: unknown, source: string): StagedDependency[] | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw invalid(source, 'stagedDependencies must be an object');
  const declared: StagedDependency[] = [];
  for (const list of [raw['forwardImports'], raw['registrations']]) {
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw invalid(source, 'stagedDependencies lists must be arrays');
    for (const item of list as unknown[]) {
      const entry = isRecord(item) ? item : {};
      const parsed = stagedDependency.parse(
        {
          file: entry['file'],
          creates: entry['creates'],
          ...(typeof entry['reason'] === 'string' ? { reason: entry['reason'] } : {}),
        },
        { source, code: 'queue-manifest-invalid', exitCode: ExitCode.PATCH_ERROR }
      );
      if (!declared.some((d) => d.file === parsed.file && d.creates === parsed.creates)) {
        declared.push(parsed);
      }
    }
  }
  return declared.length === 0 ? undefined : declared;
}

function fromV1(raw: unknown, source: string): { manifest: Manifest; files: string[] } {
  const document = manifestV1.parse(raw, {
    source,
    code: 'queue-manifest-invalid',
    exitCode: ExitCode.PATCH_ERROR,
  });
  const rows = [...document.patches].sort((a, b) => a.order - b.order);
  const patches = rows.map((row): PatchEntry => {
    const name = stemOf(row.filename);
    if (categoryOf(name) !== row.category) {
      throw invalid(
        source,
        `${row.filename} has category "${row.category}", which its name "${name}" does not begin with; ` +
          'a category is the first word of the name'
      );
    }
    const version = row.sourceVersion ?? row.sourceEsrVersion;
    if (version === undefined) throw invalid(source, `${row.filename} records no source version`);
    const dependencies = dependenciesV1(row.stagedDependencies, source);
    return {
      order: row.order,
      name,
      description: row.description ?? '',
      firefox: { product: row.sourceProduct ?? productOf(version), version },
      ...(row.tier === undefined ? {} : { tier: row.tier }),
      ...(row.lintIgnore === undefined ? {} : { lintIgnore: row.lintIgnore }),
      ...(dependencies === undefined ? {} : { stagedDependencies: dependencies }),
    };
  });
  const retired = (document.retired ?? []).map((slot) => ({
    order: slot.order,
    name: stemOf(slot.filename),
    ...(slot.reason === undefined ? {} : { reason: slot.reason }),
  }));
  const manifest = finish(
    {
      ...(document.source === undefined ? {} : { source: document.source }),
      patches,
      retired,
    },
    source
  );
  return { manifest, files: rows.map((row) => row.filename) };
}

/** A parsed manifest, and where its patch bodies are stored now. */
export interface ParsedManifest {
  manifest: Manifest;
  /** The file holding each row's body, in row order: the derived filename, except for a version-1 manifest. */
  files: string[];
}

/**
 * Validates a manifest document of either format.
 *
 * @param raw - The parsed JSON
 * @param source - The file, for messages
 * @throws `queue-manifest-invalid` (exit code 6)
 */
export function parseManifest(raw: unknown, source: string): ParsedManifest {
  if (isRecord(raw) && raw['version'] === 1) return fromV1(raw, source);
  const manifest = fromCurrent(raw, source);
  return { manifest, files: manifest.patches.map(patchFilename) };
}

/** The stamp most patches share, earliest order winning a tie. */
function commonStamp(patches: readonly PatchEntry[]): FirefoxStamp | undefined {
  const counts = new Map<string, { stamp: FirefoxStamp; count: number }>();
  for (const { firefox } of patches) {
    const key = `${firefox.product} ${firefox.version}`;
    const seen = counts.get(key) ?? { stamp: firefox, count: 0 };
    seen.count += 1;
    counts.set(key, seen);
  }
  let best: { stamp: FirefoxStamp; count: number } | undefined;
  for (const candidate of counts.values()) {
    if (best === undefined || candidate.count > best.count) best = candidate;
  }
  return best?.stamp;
}

/**
 * Serialises a manifest canonically: keys in a fixed order, rows sorted by
 * order, the common stamp hoisted to the queue. Equal manifests give equal
 * bytes.
 *
 * @param manifest - The manifest
 */
export function formatManifest(manifest: Manifest): string {
  const patches = [...manifest.patches].sort((a, b) => a.order - b.order);
  const stamp = commonStamp(patches);
  const rows = patches.map((entry) => ({
    order: entry.order,
    name: entry.name,
    ...(entry.description === '' ? {} : { description: entry.description }),
    ...(sameStamp(entry.firefox, stamp) ? {} : { firefox: entry.firefox }),
    ...(entry.tier === undefined ? {} : { tier: entry.tier }),
    ...(entry.lintIgnore === undefined ? {} : { lintIgnore: entry.lintIgnore }),
    ...(entry.stagedDependencies === undefined
      ? {}
      : { stagedDependencies: entry.stagedDependencies }),
  }));
  const retired = [...manifest.retired].sort((a, b) => a.order - b.order);
  return stringifyJson({
    version: 2,
    ...(manifest.source === undefined ? {} : { source: manifest.source }),
    ...(stamp === undefined ? {} : { firefox: stamp }),
    patches: rows,
    ...(retired.length === 0 ? {} : { retired }),
  });
}
