// SPDX-License-Identifier: EUPL-1.2
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { judgeCheck } from '../../../commands/check-report.js';
import { runCheckSteps } from '../../../commands/check-run.js';
import { DEFAULT_CONFIG } from '../../../test-utils/index.js';
import { execStream } from '../../../utils/process.js';
import type { AuthoredSnapshot } from '../../authored/types.js';
import { buildCheckPlan } from '../../check/steps.js';
import { assertFullCheckArguments } from '../check-arguments.js';
import { assertFullCheckEvidence, fullCheckContractForSnapshot } from '../check-contract.js';
import { readCheckEvidence } from '../check-evidence.js';
import { beginOwnedCheck } from '../check-runtime.js';
import type { CheckExecutionDocument } from '../check-types.js';
import { readAdmittedSnapshot } from '../guard.js';
import type { JobRequest } from '../schema.js';
import { validateRequest } from '../schema.js';

vi.mock('../guard.js', () => ({
  coordinatorNamespace: () => process.env['FIREFORGE_COORDINATOR'],
  readAdmittedSnapshot: vi.fn(),
}));
vi.mock('../../../utils/process.js', () => ({ execStream: vi.fn() }));
let directory: string, root: string;
const source = 'a'.repeat(64),
  job = 'test-check-job',
  phase = 'owned-phase',
  index = 2;
function snapshot(): AuthoredSnapshot {
  return {
    schemaVersion: 1,
    repository: directory,
    tree: 'b'.repeat(40),
    objectFormat: 'sha1',
    pin: { firefox: DEFAULT_CONFIG.firefox, commit: 'c'.repeat(40), digest: 'd'.repeat(64) },
    files: [],
    id: source,
    config: {
      ...DEFAULT_CONFIG,
      check: {
        extraSteps: [
          { name: 'project-quality', command: 'node tools/quality.mjs', after: ['lint'] },
        ],
      },
    },
    inputs: [],
  };
}
function admitted(value: AuthoredSnapshot): void {
  vi.mocked(readAdmittedSnapshot).mockResolvedValue({
    snapshot: value,
    pristineRepository: '/pristine',
    slot: {} as Awaited<ReturnType<typeof readAdmittedSnapshot>>['slot'],
    phase,
    execution: { jobId: job, index, args: [], cpu: 1 },
  });
}
async function execute(value = snapshot()): Promise<Awaited<ReturnType<typeof readCheckEvidence>>> {
  admitted(value);
  const plan = buildCheckPlan({
    projectRoot: root,
    config: value.config,
    furnaceConfigured: false,
  });
  const capture = await beginOwnedCheck(root, plan, 1);
  if (!capture) throw new Error('Missing owned capture');
  const results = await runCheckSteps(plan, 1, undefined, undefined, capture.recorder);
  await capture.finish(results, judgeCheck(results));
  return readCheckEvidence({
    namespace: directory,
    job,
    index,
    root,
    snapshot: value,
    step: { command: 'check', args: [] },
    phase,
  });
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ff-check-observed-'));
  root = join(directory, 'project');
  vi.stubEnv('FIREFORGE_COORDINATOR', directory);
  vi.stubEnv('FIREFORGE_JOB_TOKEN', 'capability');
  vi.stubEnv('FIREFORGE_ADAPTER_COMMAND', 'check');
  vi.mocked(execStream).mockImplementation((_command, _args, options) => {
    options?.onStdout?.('actual stdout\n');
    options?.onStderr?.('actual stderr\n');
    return Promise.resolve(0);
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await rm(directory, { recursive: true, force: true });
});
it('records every real scheduled child and captured project extra, then revalidates output artifacts at sealing', async () => {
  const value = snapshot(),
    observed = await execute(value),
    contract = fullCheckContractForSnapshot(value);
  expect(observed.steps.map((step) => step.name)).toEqual(contract.steps.map((step) => step.name));
  expect(observed.steps.filter((step) => step.status === 'pass')).toHaveLength(5);
  expect(execStream).toHaveBeenCalledTimes(5);
  const extra = observed.steps.find((step) => step.name === 'project-quality');
  if (!extra?.artifact) throw new Error('Expected real extra artifact');
  expect(await readFile(join(directory, 'artifacts', job, extra.artifact), 'utf8')).toContain(
    'actual stdout'
  );
  assertFullCheckEvidence(contract, observed, source);
  expect(
    await readCheckEvidence({
      namespace: directory,
      job,
      index,
      root,
      snapshot: value,
      step: { command: 'check', args: [] },
      expected: observed,
    })
  ).toEqual(observed);
  await appendFile(join(directory, 'artifacts', job, extra.artifact), 'corrupt');
  await expect(
    readCheckEvidence({
      namespace: directory,
      job,
      index,
      root,
      snapshot: value,
      step: { command: 'check', args: [] },
      expected: observed,
    })
  ).rejects.toThrow(/artifact changed/);
});
it('refuses missing, empty, narrowed and unauthorized skip execution even with exit-zero summaries', async () => {
  const value = snapshot(),
    observed = await execute(value),
    contract = fullCheckContractForSnapshot(value);
  for (const steps of [
    [],
    observed.steps.slice(0, 1),
    observed.steps.map((step) =>
      step.name === 'lint' ? { ...step, status: 'skipped' as const, exitCode: null } : step
    ),
  ])
    expect(() => {
      assertFullCheckEvidence(contract, { ...observed, steps }, source);
    }).toThrow();
  const doc = join(directory, 'artifacts', job, `step-${index}-check.json`),
    raw = JSON.parse(await readFile(doc, 'utf8')) as Record<string, unknown>;
  await writeFile(
    doc,
    JSON.stringify({
      ...raw,
      steps: [],
      verdict: { passed: true, steps: 0, failed: [], skipped: [] },
    })
  );
  await expect(
    readCheckEvidence({
      namespace: directory,
      job,
      index,
      root,
      snapshot: value,
      step: { command: 'check', args: [] },
    })
  ).rejects.toThrow(/observed check evidence/);
});
it('binds phase/configuration/source, refuses reused evidence directories and rejects incomplete child execution', async () => {
  const value = snapshot(),
    observed = await execute(value);
  await expect(
    readCheckEvidence({
      namespace: directory,
      job,
      index,
      root,
      snapshot: value,
      step: { command: 'check', args: [] },
      phase: 'another',
    })
  ).rejects.toThrow(/identity/);
  const changed = {
    ...value,
    config: {
      ...value.config,
      check: { extraSteps: [{ name: 'new-required', command: 'node more.mjs' }] },
    },
  };
  expect(() => {
    assertFullCheckEvidence(fullCheckContractForSnapshot(changed), observed, source);
  }).toThrow();
  const plan = buildCheckPlan({
    projectRoot: root,
    config: value.config,
    furnaceConfigured: false,
  });
  await expect(beginOwnedCheck(root, plan, 1)).rejects.toThrow();
  await rm(join(directory, 'artifacts', job), { recursive: true, force: true });
  vi.mocked(execStream).mockResolvedValue(1);
  await expect(execute(value)).rejects.toThrow(/successful execution/);
});
it('does not start a recorder from an unowned or mismatched check invocation', async () => {
  const value = snapshot(),
    plan = buildCheckPlan({ projectRoot: root, config: value.config, furnaceConfigured: false });
  vi.stubEnv('FIREFORGE_JOB_TOKEN', undefined);
  expect(await beginOwnedCheck(root, plan, 1)).toBeUndefined();
  vi.stubEnv('FIREFORGE_JOB_TOKEN', 'capability');
  vi.stubEnv('FIREFORGE_ADAPTER_COMMAND', 'status');
  await expect(beginOwnedCheck(root, plan, 1)).rejects.toThrow(/own admitted phase/);
  vi.stubEnv('FIREFORGE_ADAPTER_COMMAND', 'check');
  admitted(value);
  await expect(beginOwnedCheck(root, plan, 2)).rejects.toThrow(/concurrency/);
  await expect(beginOwnedCheck(root, plan.slice(0, 1), 1)).rejects.toThrow(
    /captured complete gate/
  );
});
it.each([
  ['--only', 'status'],
  ['--only='],
  ['--skip', 'lint'],
  ['--patches', 'one'],
  ['--help'],
  ['-h'],
  ['--jobs', '0'],
  ['--jobs', '1', '--jobs', '1'],
  ['--jobs', '3'],
])('rejects narrowed/no-op arguments at immutable job admission: %j', (...args) => {
  const request: JobRequest = {
    schemaVersion: 1,
    key: 'key',
    sourceId: source,
    slot: 'a',
    quiet: false,
    resources: { cpu: 2, memory: 2, build: 1, browser: 1, display: 1 },
    steps: [{ command: 'check', args }],
  };
  expect(() => {
    assertFullCheckArguments(args, 1);
    validateRequest(request);
  }).toThrow();
});
it('permits only a default full check and positive bounded jobs/output options', () => {
  expect(assertFullCheckArguments([])).toBeUndefined();
  expect(assertFullCheckArguments(['--json', '--jobs=2'], 2)).toBe(2);
});

it('rejects a fabricated success artifact without an observed child completion even after its checksum is updated', async () => {
  const value = snapshot();
  await execute(value);
  const base = join(directory, 'artifacts', job),
    docPath = join(base, `step-${index}-check.json`),
    doc = JSON.parse(await readFile(docPath, 'utf8')) as CheckExecutionDocument;
  const observed = doc.steps.find((step) => step.status === 'pass');
  if (!observed?.artifact) throw new Error('Missing observed child');
  const path = join(base, observed.artifact),
    lines = (await readFile(path, 'utf8')).trimEnd().split('\n');
  lines.pop();
  const incomplete = lines.join('\n') + '\n';
  await writeFile(path, incomplete);
  observed.artifactDigest = createHash('sha256').update(incomplete).digest('hex');
  await writeFile(docPath, JSON.stringify(doc));
  await expect(
    readCheckEvidence({
      namespace: directory,
      job,
      index,
      root,
      snapshot: value,
      step: { command: 'check', args: [] },
    })
  ).rejects.toThrow(/observed execution boundaries/);
});
