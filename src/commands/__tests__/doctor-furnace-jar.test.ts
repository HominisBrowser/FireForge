// SPDX-License-Identifier: EUPL-1.2
/**
 * "Furnace jar.mn registrations" doctor-check tests.
 *
 * The check exists because a component rename can leave the old toolkit
 * jar.mn line pointing at a deleted file, failing every build at packaging
 * while `doctor --repair-furnace` reports success without pruning. These
 * cover the reporting and repair arms it was written to provide.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/furnace-registration.js', () => ({
  findStaleJarMnEntries: vi.fn(),
  pruneStaleJarMnEntries: vi.fn(),
}));

import { findStaleJarMnEntries, pruneStaleJarMnEntries } from '../../core/furnace-registration.js';
import type { DoctorCheck } from '../../types/commands/index.js';
import type { DoctorCheckContext } from '../doctor-check-core.js';
import { furnaceStaleJarRegistrationCheck } from '../doctor-furnace-jar.js';

type StaleEntry = { tagName: string; fileName: string; line: string };

const STALE_ONE: StaleEntry[] = [
  { tagName: 'my-widget', fileName: 'my-widget.mjs', line: 'content/global/my-widget.mjs' },
];
const STALE_TWO: StaleEntry[] = [
  { tagName: 'my-widget', fileName: 'my-widget.mjs', line: 'content/global/my-widget.mjs' },
  { tagName: 'my-panel', fileName: 'my-panel.css', line: 'content/global/my-panel.css' },
];

function makeContext(overrides: Partial<DoctorCheckContext> = {}): DoctorCheckContext {
  return {
    projectRoot: '/project',
    paths: { engine: '/project/engine' },
    engineExists: true,
    furnaceConfigExists: true,
    furnaceConfig: { custom: { 'my-widget': {} }, overrides: {}, stock: [] },
    options: {},
    ...overrides,
  } as unknown as DoctorCheckContext;
}

async function run(ctx: DoctorCheckContext): Promise<DoctorCheck> {
  const result = await furnaceStaleJarRegistrationCheck.run(ctx);
  return Array.isArray(result) ? (result[0] as DoctorCheck) : result;
}

describe('furnaceStaleJarRegistrationCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('skipIf', () => {
    it.each([
      ['furnace.json is absent', { furnaceConfigExists: false }],
      ['the furnace config failed to parse', { furnaceConfig: undefined }],
      ['the engine directory is missing', { engineExists: false }],
    ])('skips when %s', (_label, overrides) => {
      expect(furnaceStaleJarRegistrationCheck.skipIf?.(makeContext(overrides))).toBe(true);
    });

    it('runs when the furnace subsystem and engine are both present', () => {
      expect(furnaceStaleJarRegistrationCheck.skipIf?.(makeContext())).toBe(false);
    });
  });

  it('returns no rows when the config is unexpectedly absent past skipIf', async () => {
    const result = await furnaceStaleJarRegistrationCheck.run(
      makeContext({ furnaceConfig: undefined })
    );
    expect(result).toEqual([]);
    expect(findStaleJarMnEntries).not.toHaveBeenCalled();
  });

  it('reports OK when no stale entries exist', async () => {
    vi.mocked(findStaleJarMnEntries).mockResolvedValue([]);
    const check = await run(makeContext());
    expect(check).toMatchObject({ name: 'Furnace jar.mn registrations', severity: 'ok' });
    expect(pruneStaleJarMnEntries).not.toHaveBeenCalled();
  });

  it('passes the engine, custom dir, and managed tags to the probe', async () => {
    vi.mocked(findStaleJarMnEntries).mockResolvedValue([]);
    await run(makeContext());
    expect(findStaleJarMnEntries).toHaveBeenCalledWith(
      '/project/engine',
      expect.stringContaining('custom'),
      ['my-widget']
    );
  });

  describe('without --repair-furnace', () => {
    it('warns and names the stale entries and the packaging failure', async () => {
      vi.mocked(findStaleJarMnEntries).mockResolvedValue(STALE_TWO);
      const check = await run(makeContext());

      expect(check.severity).toBe('warning');
      expect(check.message).toContain('2 registration lines');
      expect(check.message).toContain('my-widget/my-widget.mjs, my-panel/my-panel.css');
      expect(check.message).toContain('mach build will fail at packaging');
      expect(check.fix).toMatch(/--repair-furnace/);
      expect(pruneStaleJarMnEntries).not.toHaveBeenCalled();
    });
  });

  describe('with --repair-furnace', () => {
    const repairCtx = (): DoctorCheckContext => makeContext({ options: { repairFurnace: true } });

    it('prunes and reports how many lines were removed', async () => {
      vi.mocked(findStaleJarMnEntries).mockResolvedValue(STALE_TWO);
      vi.mocked(pruneStaleJarMnEntries).mockResolvedValue(STALE_TWO);

      const check = await run(repairCtx());

      expect(pruneStaleJarMnEntries).toHaveBeenCalledWith(
        '/project/engine',
        expect.stringContaining('custom'),
        ['my-widget']
      );
      expect(check.severity).toBe('warning');
      expect(check.message).toContain('Pruned 2 stale jar.mn registration lines');
    });

    it.each<[string, unknown, string]>([
      [
        'an Error',
        Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
        'EACCES: permission denied',
      ],
      ['a non-Error throwable', 'plain string failure', 'plain string failure'],
    ])(
      'fails with the underlying reason when pruning throws %s',
      async (_label, failure, reason) => {
        vi.mocked(findStaleJarMnEntries).mockResolvedValue(STALE_ONE);
        vi.mocked(pruneStaleJarMnEntries).mockRejectedValue(failure);

        const check = await run(repairCtx());

        expect(check.severity).toBe('error');
        expect(check.message).toContain('Could not prune stale jar.mn lines');
        expect(check.message).toContain(reason);
        expect(check.fix).toContain('toolkit/content/jar.mn');
      }
    );
  });
});
