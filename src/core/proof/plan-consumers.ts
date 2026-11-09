// SPDX-License-Identifier: EUPL-1.2
/**
 * A task's direct consumers: which captured tests read what changed, and the
 * declared sample that stands for them when more consume it than the limit
 * allows. A sample is deterministic from the change, so a rerun draws the same
 * tests until the changed paths do, and stratified so every lane and every
 * directory beside the change is represented.
 */
import { posix } from 'node:path';

import { GeneralError } from '../../errors/base.js';
import { escapeRegex } from '../../utils/regex.js';
import { digest } from '../authored/git.js';
import type { ChangedPath, PlanSample, ProofTier } from './types.js';

/** The text a test would have to contain to be a direct consumer of these files. */
export function consumerPattern(input: {
  changed: readonly ChangedPath[];
  touched: ReadonlyArray<{ content: string }>;
}): RegExp | undefined {
  const tokens = new Set<string>();
  for (const change of input.changed)
    if (change.route !== 'test' && change.route !== 'none') tokens.add(posix.basename(change.path));
  for (const file of input.touched)
    for (const match of file.content.matchAll(
      /(?:\bid\s*=\s*["']|customElements\.define\(\s*["']|getElementById\(\s*["'])([\w-]+)/g
    ))
      if (match[1]) tokens.add(match[1]);
  const usable = [...tokens].filter((token) => token.length >= 4);
  return usable.length === 0
    ? undefined
    : new RegExp(`(?<![\\w.-])(?:${usable.map(escapeRegex).join('|')})(?![\\w-])`);
}

/** A sample stands for consumers only at task tier: a gate runs every one through its lanes. */
export function assertSampleTier(input: { tier: ProofTier; sample?: number }): void {
  if (input.tier === 'gate' && input.sample !== undefined)
    throw new GeneralError(
      'proof-sample-gate: a sample never satisfies a gate, which runs every consumer through its declared lanes. Drop --sample, or run it at --tier task.'
    );
}

/** The plan's `sample` field, present only when a sample was drawn. */
export const sampleField = (sample: PlanSample | undefined): { sample?: PlanSample } =>
  sample === undefined ? {} : { sample };

/** The directory a test belongs to: above its `test/` or `tests/` directory, else its own. */
export function componentDirectory(path: string): string {
  const above = path.replace(/\/tests?\/.*$/, '');
  return above === path || above === '' ? posix.dirname(path) : above;
}

/**
 * Draws the sample: every consumer in a directory the change touched, one from
 * each lane, then one from each lane or directory in turn, in an order seeded by
 * the changed paths, until it holds `size`. The notes say what it left out.
 *
 * @param size - How many to draw; the sample grows past it to hold what it always holds
 * @param consumers - The consumers to draw from, none of them named with `--test`
 * @param changed - What the candidate changed, which seeds the order
 * @param lanes - The declared lanes and the tests each holds
 */
export function drawSample(
  size: number,
  consumers: readonly string[],
  changed: readonly ChangedPath[],
  lanes: ReadonlyArray<{ lane: { id: string }; files: readonly string[] }>
): { sample: PlanSample; notes: string[] } {
  const draw = {
    size,
    consumers,
    changed,
    laneOf: (path: string): string | undefined =>
      lanes.find(({ files }) => files.includes(path))?.lane.id,
  };
  const seed = digest({ sample: 1, changed: draw.changed.map((change) => change.path).sort() });
  const rank = new Map(draw.consumers.map((path) => [path, digest({ seed, path })]));
  const byRank = (a: string, b: string): number =>
    (rank.get(a) ?? '').localeCompare(rank.get(b) ?? '');
  const touched = new Set(
    draw.changed
      .filter((change) => change.route !== 'test' && change.route !== 'none')
      .map((change) => posix.dirname(change.path))
  );
  const chosen = new Set(draw.consumers.filter((path) => touched.has(componentDirectory(path))));
  const strata = new Map<string, string[]>();
  for (const path of draw.consumers) {
    const lane = draw.laneOf(path);
    const key = lane === undefined ? `dir:${componentDirectory(path)}` : `lane:${lane}`;
    strata.set(key, [...(strata.get(key) ?? []), path]);
  }
  const members = [...strata]
    .map(([key, paths]) => ({ key, order: digest({ seed, key }), paths: paths.sort(byRank) }))
    .sort((a, b) => a.order.localeCompare(b.order));
  // Every lane is represented whatever the size.
  for (const { key, paths } of members)
    if (key.startsWith('lane:') && !paths.some((path) => chosen.has(path)))
      chosen.add(paths[0] ?? '');
  const target = Math.max(draw.size, chosen.size);
  let drew = true;
  while (drew && chosen.size < target) {
    drew = false;
    for (const { paths } of members) {
      const next = paths.find((path) => !chosen.has(path));
      if (next === undefined || chosen.size >= target) continue;
      chosen.add(next);
      drew = true;
    }
  }
  const sample: PlanSample = {
    of: draw.consumers.length,
    requested: draw.size,
    seed,
    sampled: draw.consumers.filter((path) => chosen.has(path)),
    unsampled: draw.consumers.filter((path) => !chosen.has(path)),
  };
  const count = (value: number): string => String(value);
  return {
    sample,
    notes: [
      ...(sample.sampled.length > draw.size
        ? [
            `The sample holds ${count(sample.sampled.length)} rather than ${count(draw.size)}, to include every lane and every consumer beside what changed.`,
          ]
        : []),
      `Sampled ${count(sample.sampled.length)} of ${count(sample.of)} direct consumers; ${count(sample.unsampled.length)} did not run at this tier and are left to the gate.`,
    ],
  };
}
