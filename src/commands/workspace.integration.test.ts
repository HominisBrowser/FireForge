// SPDX-License-Identifier: EUPL-1.2
/** `workspace` and `bootstrap` through the CLI, over a seeded pristine repository and the stand-in mach. */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { engineLockPath, workspaceLockPath } from '../engine/index.js';
import { ExitCode } from '../kernel/errors.js';
import { acquireLock } from '../kernel/lock.js';
import { hostPaths, type Project } from '../project/index.js';
import { type CliResult, runCli } from '../testing/cli.js';
import { TEST_PIN_KEY } from '../testing/config.js';
import {
  makeEngineProject,
  makeProjectEngine,
  makeSourceProject,
  seedPristine,
  useMachSandbox,
} from '../testing/engine.js';
import { readMachLog } from '../testing/firefox.js';
import { useTempDir } from '../testing/temp.js';

const dir = useTempDir();
useMachSandbox();

const cli = (project: Project, ...args: string[]): Promise<CliResult> =>
  runCli(args, { cwd: project.root, env: { FIREFORGE_HOME: project.host.root } });

const json = (result: CliResult): Record<string, unknown> =>
  JSON.parse(result.stdout) as Record<string, unknown>;

describe('fireforge workspace', () => {
  it('adds, lists, repairs and removes pool workspaces', async () => {
    const project = await makeEngineProject(dir(), { source: true });
    const commit = await seedPristine(project.host);
    expect((await cli(project, 'workspace', 'list')).stdout).toBe('The pool is empty.\n');

    const added = await cli(project, 'workspace', 'add', 'alpha', '--json');
    expect(added.exitCode).toBe(ExitCode.SUCCESS);
    expect(json(added)).toMatchObject({
      name: 'alpha',
      path: join(project.host.workspaces, 'alpha'),
      pin: TEST_PIN_KEY,
    });
    const listed = await cli(project, 'workspace', 'list', '--json');
    expect(json(listed)).toMatchObject({
      engine: null,
      workspaces: [{ name: 'alpha', pin: TEST_PIN_KEY, commit, built: false, holders: [] }],
    });
    expect((await cli(project, 'workspace', 'list')).stdout).toBe(
      `alpha  ${TEST_PIN_KEY}  not built  free  never leased\n`
    );

    expect((await cli(project, 'workspace', 'repair', 'alpha')).stdout).toContain(
      'Reset workspace'
    );
    expect((await cli(project, 'workspace', 'remove', 'alpha')).exitCode).toBe(ExitCode.SUCCESS);
    const gone = await cli(project, 'workspace', 'remove', 'alpha', '--json');
    expect(gone.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(json(gone)).toMatchObject({ code: 'workspace-not-found' });
  });

  it('clones a workspace without its build, and says the clone needs a full build', async (test) => {
    await seedPristine(hostPaths({ FIREFORGE_HOME: join(dir(), 'home') }));
    const project = await makeSourceProject(dir());
    expect((await cli(project, 'build')).exitCode).toBe(ExitCode.SUCCESS);
    expect((await cli(project, 'workspace', 'add', 'fresh')).stdout).toContain(
      'It needs a full build before it is useful.'
    );
    const cloned = await cli(project, 'workspace', 'add', 'copy', '--from', 'w1');
    if (cloned.stderr.includes('clone-unsupported')) test.skip();
    expect(cloned.exitCode).toBe(ExitCode.SUCCESS);
    expect(cloned.stdout).toContain(
      'The builds of "w1" were not copied (a build cannot be moved to another path): it needs a full build.'
    );
    const listed = json(await cli(project, 'workspace', 'list', '--json'));
    expect(listed['workspaces']).toMatchObject([
      { name: 'copy', built: false, clonedFrom: 'w1' },
      { name: 'fresh', built: false },
      { name: 'w1', built: true },
    ]);
    const again = await cli(project, 'workspace', 'add', 'other', '--from', 'w1', '--json');
    expect(json(again)).toMatchObject({ name: 'other', built: false });
  });

  it('refuses a bad name with the usage exit code', async () => {
    const project = await makeEngineProject(dir(), { source: true });
    await seedPristine(project.host);
    const result = await cli(project, 'workspace', 'add', 'Not A Name');
    expect(result.exitCode).toBe(ExitCode.INVALID_ARGUMENT);
    expect(result.stderr).toContain('is not a workspace name');
  });

  it("lists a patch-mode project's own engine", async () => {
    const project = await makeEngineProject(dir());
    const workspace = await makeProjectEngine(project);
    const listed = await cli(project, 'workspace', 'list', '--json');
    expect(json(listed)).toEqual({
      schemaVersion: 1,
      engine: {
        path: workspace.engineDir,
        holders: [],
        leased: false,
        leases: [],
        unidentifiedHolders: 0,
        waiting: 0,
      },
      host: {
        display: { leased: false, leases: [], unidentifiedHolders: 0, waiting: 0 },
        build: {
          slots: 1,
          inUse: 0,
          leased: false,
          leases: [],
          unidentifiedHolders: 0,
          waiting: 0,
        },
      },
      workspaces: [],
    });
    expect((await cli(project, 'workspace', 'list')).stdout).toBe(
      `engine  ${workspace.engineDir}  free\n`
    );
  });
});

describe('fireforge workspace list --json, lease state', () => {
  it('reports who leases each workspace and who holds the display and the build slots, without taking them', async () => {
    const project = await makeEngineProject(dir(), { source: true });
    await seedPristine(project.host);
    await cli(project, 'workspace', 'add', 'alpha');
    await cli(project, 'workspace', 'add', 'beta');
    await writeFile(join(project.host.root, 'host.json'), '{"buildSlots":2}');
    const state = async (): Promise<Record<string, unknown>> =>
      json(await cli(project, 'workspace', 'list', '--json'));

    const idle = await state();
    expect(idle['workspaces']).toMatchObject([
      { name: 'alpha', leased: false, leases: [], holders: [] },
      { name: 'beta', leased: false, leases: [], holders: [] },
    ]);

    const lease = await acquireLock(workspaceLockPath(project.host, 'beta'), {
      info: { checkout: '/work/sidebar', command: 'build' },
    });
    const display = await acquireLock(join(project.host.locks, 'display'), {});
    const slot = await acquireLock(join(project.host.locks, 'build'), {
      mode: 'shared',
      limit: 2,
      info: { command: 'build' },
    });
    try {
      const busy = await state();
      const beta = (busy['workspaces'] as Record<string, unknown>[])[1];
      expect(beta).toMatchObject({
        name: 'beta',
        pin: TEST_PIN_KEY,
        built: false,
        leased: true,
        holders: [process.pid],
        unidentifiedHolders: 0,
        leases: [
          { pid: process.pid, mode: 'exclusive', checkout: '/work/sidebar', command: 'build' },
        ],
      });
      const [held] = beta?.['leases'] as { since: string }[];
      expect(new Date(held?.since ?? '').toISOString()).toBe(held?.since);
      expect((busy['workspaces'] as Record<string, unknown>[])[0]).toMatchObject({
        name: 'alpha',
        leased: false,
      });
      expect(busy['host']).toEqual({
        display: {
          leased: true,
          leases: [
            {
              pid: process.pid,
              mode: 'exclusive',
              since: expect.any(String) as string,
              checkout: null,
              command: null,
            },
          ],
          unidentifiedHolders: 0,
          waiting: 0,
        },
        build: {
          slots: 2,
          inUse: 1,
          leased: true,
          leases: [
            {
              pid: process.pid,
              mode: 'shared',
              since: expect.any(String) as string,
              checkout: null,
              command: 'build',
            },
          ],
          unidentifiedHolders: 0,
          waiting: 0,
        },
      });
      // Reading changed nothing: the same holders show again, and nobody lost a lock.
      expect(await state()).toEqual(busy);
    } finally {
      await slot.release();
      await display.release();
      await lease.release();
    }
    expect(await state()).toEqual(idle);
  });

  it("reports a patch-mode engine's holder", async () => {
    const project = await makeEngineProject(dir());
    await makeProjectEngine(project);
    const lock = await acquireLock(engineLockPath(project), { info: { command: 'build' } });
    try {
      const listed = json(await cli(project, 'workspace', 'list', '--json'));
      expect(listed['engine']).toMatchObject({
        leased: true,
        holders: [process.pid],
        leases: [{ pid: process.pid, mode: 'exclusive', command: 'build', checkout: null }],
      });
    } finally {
      await lock.release();
    }
  });
});

describe('fireforge bootstrap', () => {
  it("runs mach bootstrap in a patch-mode project's engine", async () => {
    const project = await makeEngineProject(dir());
    const workspace = await makeProjectEngine(project);
    const result = await cli(project, 'bootstrap');
    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.stdout).toBe('Build dependencies are installed.\n');
    expect((await readMachLog(workspace.engineDir)).map((call) => call.args)).toEqual([
      ['bootstrap', '--application-choice', 'browser'],
    ]);
  });

  it('runs it in a pool workspace for a source-mode project, and fails with the build exit code', async () => {
    await seedPristine(hostPaths({ FIREFORGE_HOME: join(dir(), 'home') }), {
      '.mach-state/fail-bootstrap': '',
    });
    const project = await makeSourceProject(dir());
    const result = await cli(project, 'bootstrap');
    expect(result.exitCode).toBe(ExitCode.BUILD_ERROR);
    expect(result.stderr).toContain('mach bootstrap exited 1');
    const engine = join(project.host.workspaces, 'w1', 'engine');
    expect((await readMachLog(engine)).map((call) => call.args[0])).toEqual(['bootstrap']);
  });

  it('refuses a patch-mode project that has no engine yet', async () => {
    const project = await makeEngineProject(dir());
    const result = await cli(project, 'bootstrap');
    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(result.stderr).toContain('fireforge download');
  });
});
