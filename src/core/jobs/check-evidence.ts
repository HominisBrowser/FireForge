// SPDX-License-Identifier: EUPL-1.2
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { digest } from '../authored/git.js';
import type { AuthoredSnapshot } from '../authored/types.js';
import { assertFullCheckArguments } from './check-arguments.js';
import { assertFullCheckEvidence, fullCheckContractForSnapshot } from './check-contract.js';
import type {
  CheckExecutionDocument,
  FullCheckEvidence,
  ObservedCheckStep,
} from './check-types.js';
import type { JobStep } from './schema.js';

async function artifactBytes(base: string, path: string): Promise<Buffer> {
  const info = await lstat(join(base, path));
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error('Check artifact is not a regular owned file');
  return readFile(join(base, path));
}
function validateArtifact(bytes: Buffer, step: ObservedCheckStep, root: string): void {
  const rows: unknown[] = bytes
    .toString('utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);
  validateStart(rows[0], step, root);
  validateEnd(rows.at(-1), step);
  for (const row of rows.slice(1, -1))
    if (
      !row ||
      typeof row !== 'object' ||
      !('stream' in row) ||
      !['stdout', 'stderr'].includes(String(row.stream)) ||
      !('text' in row) ||
      typeof row.text !== 'string'
    )
      throw new Error('Invalid captured check output record');
}
function validateStart(start: unknown, step: ObservedCheckStep, root: string): void {
  if (
    !start ||
    typeof start !== 'object' ||
    !('event' in start) ||
    start.event !== 'start' ||
    !('name' in start) ||
    start.name !== step.name ||
    !('display' in start) ||
    typeof start.display !== 'string' ||
    start.display.split(root).join('$PROJECT') !== step.command ||
    !('at' in start) ||
    start.at !== step.startedAt
  )
    throw new Error('Check artifact lacks observed execution boundaries');
}
function validateEnd(end: unknown, step: ObservedCheckStep): void {
  if (
    !end ||
    typeof end !== 'object' ||
    !('event' in end) ||
    end.event !== 'end' ||
    !('name' in end) ||
    end.name !== step.name ||
    !('status' in end) ||
    end.status !== 'pass' ||
    !('exitCode' in end) ||
    end.exitCode !== 0 ||
    !('at' in end) ||
    end.at !== step.finishedAt
  )
    throw new Error('Check artifact lacks observed execution boundaries');
}
/** Re-read exact execution artifacts at dispatch completion and again at final sealing. */
export async function readCheckEvidence(options: {
  namespace: string;
  job: string;
  index: number;
  root: string;
  snapshot: AuthoredSnapshot;
  step: JobStep;
  /** The CPU the step was admitted with, which is its default concurrency. */
  cpu?: number;
  phase?: string;
  expected?: FullCheckEvidence;
}): Promise<FullCheckEvidence> {
  const { namespace, job, index, root, snapshot, step } = options;
  const cpu = options.cpu ?? step.resources?.cpu ?? 1;
  const jobs = assertFullCheckArguments(step.args, cpu) ?? cpu;
  const base = join(namespace, 'artifacts', job),
    path = `step-${index}-check.json`,
    bytes = await artifactBytes(base, path),
    document = JSON.parse(bytes.toString('utf8')) as CheckExecutionDocument;
  const { configDigest, plan, verdict, ...observed } = document;
  const contract = fullCheckContractForSnapshot(snapshot);
  const evidence: FullCheckEvidence = {
    ...observed,
    resultDigest: createHash('sha256').update(bytes).digest('hex'),
  };
  assertFullCheckEvidence(contract, evidence, snapshot.id);
  if (
    evidence.job !== job ||
    evidence.index !== index ||
    evidence.jobs !== jobs ||
    (options.phase !== undefined && evidence.phase !== options.phase) ||
    configDigest !== contract.configDigest ||
    digest(plan) !== digest(contract.steps) ||
    !verdict.passed ||
    verdict.reason !== undefined ||
    verdict.steps !== contract.steps.length ||
    verdict.failed.length !== 0 ||
    digest(verdict.skipped) !==
      digest(evidence.steps.filter((item) => item.status === 'skipped').map((item) => item.name))
  )
    throw new Error('Complete check verdict/identity does not match captured execution');
  for (const item of evidence.steps.filter((item) => item.status === 'pass')) {
    if (!item.artifact?.startsWith(`step-${index}-check/`))
      throw new Error('Check output belongs to another phase');
    const output = await artifactBytes(base, item.artifact);
    if (createHash('sha256').update(output).digest('hex') !== item.artifactDigest)
      throw new Error('Check output artifact changed');
    validateArtifact(output, item, root);
  }
  if (options.expected && digest(evidence) !== digest(options.expected))
    throw new Error('Check evidence changed before sealing');
  return evidence;
}
