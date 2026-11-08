// SPDX-License-Identifier: EUPL-1.2
/** Whether an ancestor's own gate evidence is complete, and the status a plan reads. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authenticateAuthoredSnapshot } from '../../authored/provider.js';
import { evaluateProof, readDecisions, readEvidence } from '../evidence.js';
import { measureCurrentIdentity } from '../identity.js';
import { retainedSnapshotsOfTree } from '../publish.js';
import { planCapturedSource } from '../snapshot.js';
import { cleanGateProbe, currentStatus } from '../status.js';

vi.mock('../../authored/provider.js', () => ({ authenticateAuthoredSnapshot: vi.fn() }));
vi.mock('../evidence.js', () => ({
  evaluateProof: vi.fn(),
  readDecisions: vi.fn(),
  readEvidence: vi.fn(),
}));
vi.mock('../identity.js', () => ({ measureCurrentIdentity: vi.fn() }));
vi.mock('../publish.js', () => ({ retainedSnapshotsOfTree: vi.fn() }));
vi.mock('../snapshot.js', () => ({ planCapturedSource: vi.fn() }));

const plan = (fields: Record<string, unknown> = {}): never =>
  ({ source: 'own', tier: 'gate', base: { narrowed: false }, ...fields }) as never;
const status = (complete: boolean, waived: string[] = []): never =>
  ({ complete, waived, obligations: [], failures: [], finished: 0 }) as never;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(readEvidence).mockResolvedValue({ rows: [{ status: 'passed' }] } as never);
  vi.mocked(readDecisions).mockResolvedValue({} as never);
  vi.mocked(measureCurrentIdentity).mockResolvedValue({ id: 'now' } as never);
  vi.mocked(authenticateAuthoredSnapshot).mockImplementation((value) =>
    Promise.resolve(value as never)
  );
});

describe('the current status of a plan', () => {
  it('reads a carried source beside its own, and reads every byte only for a gate claim', async () => {
    vi.mocked(evaluateProof).mockReturnValue(status(true));
    const carried = plan({ carry: { source: 'ancestor' } });
    const result = await currentStatus('/ns', carried, { claim: true });
    expect(result.status).toMatchObject({ complete: true });
    expect(readEvidence).toHaveBeenCalledWith('/ns', 'ancestor');
    expect(measureCurrentIdentity).toHaveBeenLastCalledWith('/ns', 'own', true, true);
    await currentStatus('/ns', plan({ tier: 'check' }), { claim: true });
    expect(measureCurrentIdentity).toHaveBeenLastCalledWith('/ns', 'own', true, false);
  });
});

describe('the clean gate probe', () => {
  it('counts only the named source, planned as its own complete, unwaived gate', async () => {
    vi.mocked(retainedSnapshotsOfTree).mockResolvedValue([
      { id: 'other' },
      { id: 'carried' },
    ] as never);
    const probe = cleanGateProbe('/ns', '/root', '/donor');
    vi.mocked(planCapturedSource).mockResolvedValue(plan({ carry: { source: 'x' } }));
    expect(await probe('c1', 'tree', 'carried')).toBe(false);
    vi.mocked(planCapturedSource).mockResolvedValue(plan({ base: { narrowed: true } }));
    expect(await probe('c1', 'tree', 'carried')).toBe(false);
    vi.mocked(planCapturedSource).mockResolvedValue(plan());
    vi.mocked(evaluateProof).mockReturnValue(status(true, ['lint']));
    expect(await probe('c1', 'tree', 'carried')).toBe(false);
    vi.mocked(evaluateProof).mockReturnValue(status(false));
    expect(await probe('c1', 'tree', 'carried')).toBe(false);
    vi.mocked(evaluateProof).mockReturnValue(status(true));
    expect(await probe('c1', 'tree', 'carried')).toBe(true);
    expect(await probe('c1', 'tree', 'missing')).toBe(false);
    // One listing per tree, however often it is asked.
    expect(retainedSnapshotsOfTree).toHaveBeenCalledTimes(1);
    expect(authenticateAuthoredSnapshot).toHaveBeenCalledWith({ id: 'carried' }, '/donor');
    expect(planCapturedSource).toHaveBeenLastCalledWith({
      root: '/root',
      snapshot: { id: 'carried' },
      tier: 'gate',
      head: 'c1',
    });
  });
});
