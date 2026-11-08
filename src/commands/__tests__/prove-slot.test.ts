// SPDX-License-Identifier: EUPL-1.2
/** `prove --slot`: every job a proof submits goes to the slot named, as `job run --slot` does. */
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureAuthoredSnapshot } from '../../core/authored/index.js';
import { submitJob } from '../../core/jobs/client.js';
import { readSlots } from '../../core/jobs/slots.js';
import { evaluateProof, readDecisions, readEvidence } from '../../core/proof/evidence.js';
import { measureCurrentIdentity } from '../../core/proof/identity.js';
import { composeProofJob } from '../../core/proof/job.js';
import { planCapturedSource } from '../../core/proof/snapshot.js';
import { UnknownSlotError } from '../../errors/job.js';
import { registerProve } from '../prove.js';

vi.mock('../../core/config.js', () => ({
  loadConfig: vi.fn(() => Promise.resolve({ sources: {} })),
}));
vi.mock('../../core/authored/index.js', () => ({ captureAuthoredSnapshot: vi.fn() }));
vi.mock('../../core/jobs/guard.js', () => ({ coordinatorNamespace: () => '/private/default' }));
vi.mock('../../core/jobs/client.js', () => ({
  ownerLabel: vi.fn(),
  submitJob: vi.fn(),
  waitForJob: vi.fn(),
}));
vi.mock('../../core/jobs/slots.js', () => ({ readSlots: vi.fn() }));
vi.mock('../../core/proof/evidence.js', () => ({
  evaluateProof: vi.fn(),
  obligationMeaning: vi.fn(),
  readDecisions: vi.fn(),
  readEvidence: vi.fn(),
  writeDecision: vi.fn(),
}));
vi.mock('../../core/proof/identity.js', () => ({
  measureCurrentIdentity: vi.fn(),
  measureTools: vi.fn(),
}));
vi.mock('../../core/proof/job.js', () => ({ composeProofJob: vi.fn(), namedObligation: vi.fn() }));
vi.mock('../../core/proof/snapshot.js', () => ({
  declaredInputs: vi.fn(() => []),
  planCapturedSource: vi.fn(),
}));
vi.mock('../../core/proof/publish.js', () => ({}));
vi.mock('../job-support.js', async (original) => ({
  ...(await original<typeof import('../job-support.js')>()),
  pristineDonor: vi.fn(() => Promise.resolve('/donor')),
}));

const snapshot = { id: 'source', config: { binaryName: 'hominis' } };
const plan = { id: 'plan', tier: 'gate', source: 'source', obligations: [] };
const slots = [{ id: 'a' }, { id: 'b' }];
const queued = {
  id: '7d41b2c0-3333-4aaa-8bbb-000000000003',
  state: 'queued',
  owner: 'me',
  request: { steps: [{ command: 'check', args: [] }] },
};
let writes: string[];

async function run(...args: string[]): Promise<void> {
  const program = new Command().exitOverride();
  program.configureOutput({ writeErr: () => undefined });
  registerProve(program, { getProjectRoot: () => '/editor', withErrorHandling: (h) => h });
  await program.parseAsync(['node', 'fireforge', 'prove', ...args]);
}

/** A plan whose obligations still need work, some of them a slot holding this source. */
function needing(needsSlot: boolean): void {
  vi.mocked(evaluateProof).mockReturnValue({
    obligations: [{ id: 'static', state: 'missing', ...(needsSlot ? { needsSlot } : {}) }],
    finished: 0,
    complete: false,
  } as never);
}

beforeEach(() => {
  vi.resetAllMocks();
  writes = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.mocked(captureAuthoredSnapshot).mockResolvedValue(snapshot as never);
  vi.mocked(planCapturedSource).mockResolvedValue(plan as never);
  vi.mocked(readEvidence).mockResolvedValue({ rows: [] } as never);
  vi.mocked(readDecisions).mockResolvedValue([] as never);
  vi.mocked(measureCurrentIdentity).mockResolvedValue({ toolchain: 'tools' } as never);
  vi.mocked(readSlots).mockResolvedValue(slots as never);
  vi.mocked(composeProofJob).mockReturnValue({
    steps: [{ command: 'check', args: [] }],
    slot: 'a',
    notes: [],
  } as never);
  vi.mocked(submitJob).mockResolvedValue(queued as never);
  needing(false);
});
afterEach(() => vi.restoreAllMocks());

describe('prove --slot', () => {
  it.each(['gate', 'task'])(
    'composes a %s job for the named slot alone and submits it there',
    async (tier) => {
      vi.mocked(planCapturedSource).mockResolvedValue({ ...plan, tier } as never);
      await run('run', '--tier', tier, '--slot', 'b', '--no-wait');
      expect(vi.mocked(composeProofJob).mock.calls[0]?.[2]).toEqual([{ id: 'b' }]);
      expect(submitJob).toHaveBeenCalledOnce();
      expect(vi.mocked(submitJob).mock.calls[0]?.[1]).toMatchObject({ slot: 'b' });
      expect(writes.join('')).toContain(`${queued.id} queued`);
    }
  );

  it('keys a named slot’s job apart from the scheduler’s, which still picks without one', async () => {
    await run('run', '--slot', 'b', '--no-wait');
    await run('run', '--no-wait');
    const [named, picked] = vi.mocked(submitJob).mock.calls.map((call) => call[1]);
    expect(picked).toMatchObject({ slot: 'a' });
    expect(named?.key).not.toBe(picked?.key);
    expect(vi.mocked(composeProofJob).mock.calls[1]?.[2]).toEqual(slots);
  });

  it('brings the named slot to this source when tools need measuring there', async () => {
    needing(true);
    await run('run', '--slot', 'b', '--no-wait');
    expect(vi.mocked(submitJob).mock.calls[0]?.[1]).toMatchObject({
      slot: 'b',
      steps: [{ command: 'status', args: ['--raw'] }],
    });
  });

  it('refuses a slot that does not exist before submitting anything', async () => {
    const refused = await run('run', '--slot', 'zz', '--no-wait').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(UnknownSlotError);
    expect((refused as Error).message).toBe(
      'Slot zz does not exist; fireforge slot list shows what exists'
    );
    expect(submitJob).not.toHaveBeenCalled();
  });
});
