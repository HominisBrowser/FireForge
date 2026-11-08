// SPDX-License-Identifier: EUPL-1.2
/** What the token and nonce of a phase authorize, and what they refuse. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { verifyPackageOncePerPhase } from '../package-signature.js';
import { assertCleanupReport, authorizeExecution } from '../phase-capability.js';
import type { RpcRequest } from '../protocol.js';
import type { JobRecord, JobStep } from '../schema.js';
import { readSlot } from '../slots.js';

vi.mock('../slots.js', async (original) => ({
  ...(await original<typeof import('../slots.js')>()),
  readSlot: vi.fn(),
}));
vi.mock('../package-signature.js', async (original) => ({
  ...(await original<typeof import('../package-signature.js')>()),
  verifyPackageOncePerPhase: vi.fn(() => Promise.resolve()),
}));

const job = (step: JobStep, over: Partial<JobRecord> = {}): JobRecord =>
  ({
    schemaVersion: 1,
    id: 'job',
    owner: 't',
    state: 'running',
    epoch: 1,
    slot: 'a',
    executionToken: 'token',
    process: { pid: 1, start: 's' },
    phase: { index: 0, active: true, ticket: 1, nonce: 'nonce' },
    stepResources: [{ cpu: 3, memory: 1, build: 0, browser: 0, display: 0 }],
    request: { schemaVersion: 1, key: 'k', sourceId: 's', steps: [step], quiet: false },
    ...over,
  }) as JobRecord;

const ask = (command: string, over: object = {}): Extract<RpcRequest, { token: string }> => ({
  operation: 'authorize',
  jobId: 'job',
  token: 'token',
  phase: 'nonce',
  command,
  ...over,
});

const TEST: JobStep = { command: 'test', args: ['--headless', 'a.js'] };
const built = {
  id: 'a',
  root: '/slot',
  sourceId: 'source',
  generation: 2,
  successfulBuildGeneration: 5,
  fullBuildAnchor: { digest: 'd' },
  trustedBuild: { sourceId: 'source', slotGeneration: 2, successfulBuildGeneration: 5 },
};

beforeEach(() => {
  vi.mocked(readSlot).mockReset();
  vi.mocked(verifyPackageOncePerPhase).mockClear();
});

describe('a phase capability', () => {
  it.each([
    ['a job that is not running', { state: 'queued' }, {}],
    ['another token', {}, { token: 'stale' }],
    ['another phase', {}, { phase: 'earlier' }],
    ['no process recorded', { process: undefined }, {}],
    ['no phase', { phase: undefined }, {}],
  ])('refuses %s', async (_name, record, request) => {
    await expect(
      authorizeExecution('/ns', job(TEST, record as Partial<JobRecord>), ask('test', request))
    ).rejects.toThrow('Executor capability refused');
  });

  it('refuses another command, and no job at all', async () => {
    await expect(authorizeExecution('/ns', job(TEST), ask('build'))).rejects.toThrow(/refused/);
    await expect(authorizeExecution('/ns', undefined, ask('test'))).rejects.toThrow(/refused/);
  });

  it("lets a check's own steps through, and nothing else under it", async () => {
    vi.mocked(readSlot).mockResolvedValue(built as never);
    const check = job({ command: 'check', args: [] });
    for (const command of ['status', 'verify', 'lint', 'typecheck', 'furnace'])
      await expect(authorizeExecution('/ns', check, ask(command))).resolves.toMatchObject({
        slot: 'a',
      });
    await expect(authorizeExecution('/ns', check, ask('build'))).rejects.toThrow(/refused/);
  });

  it('refuses a running job with no slot', async () => {
    const slotless = job(TEST);
    delete slotless.slot;
    await expect(authorizeExecution('/ns', slotless, ask('test'))).rejects.toThrow(/refused/);
  });

  it.each([
    ['needs a build', { requiresBuild: true }],
    ['needs a full build', { requiresFullBuild: true }],
    ['has no anchor', { fullBuildAnchor: undefined }],
    ['built another source', { sourceId: 'other' }],
    [
      'built at another generation',
      { trustedBuild: { sourceId: 'source', slotGeneration: 1, successfulBuildGeneration: 5 } },
    ],
    [
      'built by an earlier build',
      { trustedBuild: { sourceId: 'source', slotGeneration: 2, successfulBuildGeneration: 4 } },
    ],
  ])('refuses a test on a slot that %s', async (_name, over) => {
    vi.mocked(readSlot).mockResolvedValue({ ...built, ...over } as never);
    await expect(authorizeExecution('/ns', job(TEST), ask('test'))).rejects.toThrow(
      /fresh admitted build/
    );
    expect(verifyPackageOncePerPhase).not.toHaveBeenCalled();
  });

  it('checks the package of a step that reads it, and gives the phase what it owns', async () => {
    vi.mocked(readSlot).mockResolvedValue(built as never);
    const granted = await authorizeExecution('/ns', job(TEST), ask('test'));
    expect(verifyPackageOncePerPhase).toHaveBeenCalledWith(built, 'job', 'nonce');
    expect(granted).toMatchObject({ jobId: 'job', slot: 'a', root: '/slot', cpu: 3, epoch: 1 });
  });

  it('asks nothing of the package for a step that builds it', async () => {
    vi.mocked(readSlot).mockResolvedValue({ ...built, requiresBuild: true } as never);
    await authorizeExecution('/ns', job({ command: 'build', args: [] }), ask('build'));
    expect(verifyPackageOncePerPhase).not.toHaveBeenCalled();
  });
});

describe('a cleanup report', () => {
  it('speaks only for the live phase, with a reason that fits', () => {
    expect(() => {
      assertCleanupReport(job(TEST), ask('test', { reason: 'a census failed' }));
    }).not.toThrow();
    for (const reason of ['', 'x'.repeat(4097), 7])
      expect(() => {
        assertCleanupReport(job(TEST), ask('test', { reason }));
      }).toThrow(/Invalid process cleanup/);
    expect(() => {
      assertCleanupReport(job(TEST), ask('test', { reason: 'r', token: 'stale' }));
    }).toThrow(/refused/);
  });
});
