// SPDX-License-Identifier: EUPL-1.2
/** What prove reads from its command line, and what it says about the commits in its range. */
import type { Command } from 'commander';

import type { AuthoredSnapshot } from '../core/authored/types.js';
import {
  attributeReds,
  type ProofRange,
  proofRange,
  rangeWarning,
} from '../core/proof/attribution.js';
import type { ProofStatus } from '../core/proof/evidence.js';
import type { ProofPlan, ProofTier } from '../core/proof/types.js';
import { InvalidArgumentError } from '../errors/base.js';
import type { ReportAttribution } from './prove-report.js';

export type { ProofRange } from '../core/proof/attribution.js';

/** The tier `--tier` names. */
export function tierOf(value: string): ProofTier {
  if (value !== 'task' && value !== 'gate')
    throw new InvalidArgumentError(`--tier must be task or gate, not ${value}`, '--tier');
  return value;
}

/** The build recipe `--mode` names, if it names one. */
export function modeOf(value: string | undefined): ProofPlan['mode'] {
  if (value === undefined) return undefined;
  if (value !== 'dev' && value !== 'debug' && value !== 'release')
    throw new InvalidArgumentError(`--mode must be dev, debug or release, not ${value}`, '--mode');
  return value;
}

/** The control `--control`, `--control-test` and `--expect` name together, if they name one. */
export function controlOf(options: {
  control?: string;
  controlTest?: string;
  expect?: string[];
}): { diff: string; test: string; assertions: string[] } | undefined {
  const { control, controlTest, expect } = options;
  if (control === undefined && controlTest === undefined && expect === undefined) return undefined;
  if (control === undefined || controlTest === undefined || !expect?.length)
    throw new InvalidArgumentError(
      '--control, --control-test and --expect go together: a mutation, the test it reddens and the assertions that have to fail',
      '--control'
    );
  return { diff: control, test: controlTest, assertions: expect };
}

/** A task's declared sample, as the command line gives it. */
export interface SampleOptions {
  /** How many consumers over the limit a recorded sample runs. */
  sample?: string;
}

export const sampleOptions = (command: Command): Command =>
  command.option(
    '--sample <n>',
    'At task tier, run a recorded sample of n consumers when more than the limit consume the change'
  );

/** The sample a plan takes, if the command line declares one. */
export function sampleRequest(options: SampleOptions): { sample?: number } {
  const { sample } = options;
  if (sample === undefined) return {};
  if (!/^[1-9]\d*$/.test(sample))
    throw new InvalidArgumentError(
      `--sample must be a positive whole number, not ${sample}`,
      '--sample'
    );
  return { sample: Number(sample) };
}

interface RangeContext {
  namespace: string;
  root: string;
  snapshot: AuthoredSnapshot;
  plan: ProofPlan;
  range: ProofRange | undefined;
}

/** The plan's range, with a gate's warning about commits that are not this change's, up front. */
export async function announceRange(
  root: string,
  snapshot: AuthoredSnapshot,
  plan: ProofPlan
): Promise<ProofRange | undefined> {
  const range = await proofRange(root, plan, snapshot.config.proof).catch(() => undefined);
  const warning = range === undefined ? undefined : rangeWarning(plan, range);
  if (warning !== undefined) process.stderr.write(`${warning}\n`);
  return range;
}

/** Each red against the commits of the range that touched what it reads. Best effort: never refuses. */
export async function attributionOf(
  context: RangeContext,
  status: ProofStatus
): Promise<{ attribution?: ReportAttribution }> {
  const { range } = context;
  if (range === undefined || !status.obligations.some((entry) => entry.state === 'red')) return {};
  const reds = await attributeReds({
    namespace: context.namespace,
    root: context.root,
    plan: context.plan,
    obligations: status.obligations,
    snapshot: context.snapshot,
    range,
  }).catch(() => []);
  return { attribution: { range, reds } };
}
