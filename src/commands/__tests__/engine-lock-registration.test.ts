// SPDX-License-Identifier: EUPL-1.2
/**
 * Every command that rewrites engine/ must be flagged in the manifest and hold
 * the engine-session lock. Which commands those are is written down here by
 * hand, from what each command does, so the flags are checked against
 * something other than themselves. The registrars are driven for real; only
 * the lock is replaced, by a recorder that does not run the command body.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/engine-session-lock.js', () => ({
  withEngineSessionLock: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock('../re-export-preflight.js', () => ({
  preflightReExportArguments: vi.fn(() => Promise.resolve(undefined)),
}));

import { withEngineSessionLock } from '../../core/engine-session-lock.js';
import { COMMAND_MANIFEST } from '../manifest.js';

/**
 * What each manifest command does to engine/, decided per command. A new
 * command fails the suite until it is classified here, and `rewrites` plus
 * `edits-files` must be exactly the manifest's `mutatesEngine` set.
 */
const ENGINE_EFFECT: Record<string, 'rewrites' | 'locks-own-sections' | 'edits-files' | 'none'> = {
  // Rewrite engine/ wholesale or move its HEAD/index: flagged, locked.
  download: 'rewrites',
  import: 'rewrites',
  resolve: 'rewrites',
  reset: 'rewrites',
  discard: 'rewrites',
  export: 'rewrites',
  'export-all': 'rewrites',
  're-export': 'rewrites',
  park: 'rewrites',
  rebase: 'rewrites',
  // Take the engine-session lock themselves around the sections that need it.
  build: 'locks-own-sections',
  test: 'locks-own-sections',
  tree: 'locks-own-sections',
  package: 'locks-own-sections',
  furnace: 'locks-own-sections',
  patch: 'locks-own-sections',
  // Edit individual registration or token files in engine/ in place (patch mode): flagged, locked.
  register: 'edits-files',
  wire: 'edits-files',
  token: 'edits-files',
  // Read engine/, write outside it, or act on an isolated engine.
  setup: 'none',
  source: 'none',
  authored: 'none',
  host: 'none',
  slot: 'none',
  job: 'none',
  prove: 'none',
  bootstrap: 'none',
  run: 'none',
  status: 'none',
  watch: 'none',
  config: 'none',
  doctor: 'none',
  lint: 'none',
  typecheck: 'none',
  verify: 'none',
  check: 'none',
};

const projects: string[] = [];

/** A project download can run in: config only, no engine/. */
async function downloadProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fireforge-lock-registration-'));
  projects.push(root);
  await writeFile(
    join(root, 'fireforge.json'),
    JSON.stringify({
      name: 'Fixture',
      vendor: 'Example',
      appId: 'invalid.example.fixture',
      binaryName: 'fixture',
      firefox: { version: '140.9.0esr', product: 'firefox-esr' },
    })
  );
  return root;
}

/** Arguments that reach each flagged command's locked section. */
const INVOCATIONS: Record<
  string,
  { argv: string[]; dryRunArgv?: string[]; project?: () => Promise<string> }
> = {
  download: { argv: ['download'], project: downloadProject },
  import: { argv: ['import'], dryRunArgv: ['import', '--dry-run'] },
  resolve: { argv: ['resolve'] },
  reset: { argv: ['reset', '--yes'], dryRunArgv: ['reset', '--dry-run'] },
  discard: { argv: ['discard', 'a.txt', '--yes'], dryRunArgv: ['discard', 'a.txt', '--dry-run'] },
  export: { argv: ['export', 'a.txt'] },
  'export-all': { argv: ['export-all'], dryRunArgv: ['export-all', '--dry-run'] },
  're-export': { argv: ['re-export', '--all'], dryRunArgv: ['re-export', '--all', '--dry-run'] },
  park: { argv: ['park', '001-x.patch'] },
  register: { argv: ['register', 'a.js'], dryRunArgv: ['register', 'a.js', '--dry-run'] },
  wire: { argv: ['wire', 'a'], dryRunArgv: ['wire', 'a', '--dry-run'] },
  token: {
    argv: ['token', 'add', 'x', 'v', '--mode', 'static'],
    dryRunArgv: ['token', 'add', 'x', 'v', '--mode', 'static', '--dry-run'],
  },
  rebase: { argv: ['rebase', '--abort', '--yes'], dryRunArgv: ['rebase', '--dry-run'] },
};

async function run(name: string, argv: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  const entry = COMMAND_MANIFEST.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`no manifest entry ${name}`);
  const root = (await INVOCATIONS[name]?.project?.()) ?? '/project';
  entry.register(program, {
    getProjectRoot: () => root,
    withErrorHandling: (handler) => handler,
  });
  await program.parseAsync(['node', 'fireforge', ...argv]);
}

describe('engine-mutating commands hold the engine-session lock', () => {
  beforeEach(() => {
    vi.mocked(withEngineSessionLock).mockClear();
  });
  afterEach(async () => {
    await Promise.all(projects.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  const flagged = COMMAND_MANIFEST.filter((entry) => entry.mutatesEngine === true);

  it('classifies every manifest command by what it does to engine/', () => {
    expect(Object.keys(ENGINE_EFFECT).sort()).toEqual(
      COMMAND_MANIFEST.map((entry) => entry.name).sort()
    );
  });

  it('flags exactly the commands classified as rewriting or editing engine/', () => {
    expect(flagged.map((entry) => entry.name).sort()).toEqual(
      Object.entries(ENGINE_EFFECT)
        .filter(([, effect]) => effect === 'rewrites' || effect === 'edits-files')
        .map(([name]) => name)
        .sort()
    );
  });

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
