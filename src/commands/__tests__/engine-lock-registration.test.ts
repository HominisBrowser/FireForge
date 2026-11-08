// SPDX-License-Identifier: EUPL-1.2
/**
 * Every command the manifest flags as engine-mutating must hold the
 * engine-session lock for its run. The registrars are driven for real; only
 * the lock is replaced, by a recorder that does not run the command body.
 */
import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/engine-session-lock.js', () => ({
  withEngineSessionLock: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock('../re-export-preflight.js', () => ({
  preflightReExportArguments: vi.fn(() => Promise.resolve(undefined)),
}));

import { withEngineSessionLock } from '../../core/engine-session-lock.js';
import { COMMAND_MANIFEST } from '../manifest.js';

/** Arguments that reach each flagged command's locked section. */
const INVOCATIONS: Record<string, { argv: string[]; dryRunArgv?: string[] }> = {
  import: { argv: ['import'], dryRunArgv: ['import', '--dry-run'] },
  resolve: { argv: ['resolve'] },
  reset: { argv: ['reset', '--yes'], dryRunArgv: ['reset', '--dry-run'] },
  discard: { argv: ['discard', 'a.txt', '--yes'], dryRunArgv: ['discard', 'a.txt', '--dry-run'] },
  export: { argv: ['export', 'a.txt'] },
  'export-all': { argv: ['export-all'], dryRunArgv: ['export-all', '--dry-run'] },
  're-export': { argv: ['re-export', '--all'], dryRunArgv: ['re-export', '--all', '--dry-run'] },
  park: { argv: ['park', '001-x.patch'] },
  rebase: { argv: ['rebase', '--abort', '--yes'], dryRunArgv: ['rebase', '--dry-run'] },
};

async function run(name: string, argv: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  const entry = COMMAND_MANIFEST.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`no manifest entry ${name}`);
  entry.register(program, {
    getProjectRoot: () => '/project',
    withErrorHandling: (handler) => handler,
  });
  await program.parseAsync(['node', 'fireforge', ...argv]);
}

describe('engine-mutating commands hold the engine-session lock', () => {
  beforeEach(() => {
    vi.mocked(withEngineSessionLock).mockClear();
  });

  const flagged = COMMAND_MANIFEST.filter((entry) => entry.mutatesEngine === true);

  it('has a driven invocation for exactly the flagged commands', () => {
    expect(flagged.map((entry) => entry.name).sort()).toEqual(Object.keys(INVOCATIONS).sort());
  });

  it.each(flagged.map((entry) => entry.name))('%s acquires the lock exclusively', async (name) => {
    await run(name, INVOCATIONS[name]?.argv ?? []);
    expect(withEngineSessionLock).toHaveBeenCalledTimes(1);
    const options = vi.mocked(withEngineSessionLock).mock.calls[0]?.[3];
    expect(options?.mode).not.toBe('shared');
  });

  it.each(flagged.filter((entry) => INVOCATIONS[entry.name]?.dryRunArgv !== undefined))(
    '$name takes the lock shared for --dry-run',
    async ({ name }) => {
      await run(name, INVOCATIONS[name]?.dryRunArgv ?? []);
      expect(withEngineSessionLock).toHaveBeenCalledTimes(1);
      expect(vi.mocked(withEngineSessionLock).mock.calls[0]?.[3]).toMatchObject({ mode: 'shared' });
    }
  );
});
