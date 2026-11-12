// SPDX-License-Identifier: EUPL-1.2
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ExitCode } from '../kernel/errors.js';
import { s } from '../kernel/schema.js';
import { sleep } from '../kernel/time.js';
import { defineStateSection, type Project, readState, updateState } from '../project/index.js';
import { TEST_PIN_KEY } from '../testing/config.js';
import { makeEngineProject, seedPristine, useMachSandbox } from '../testing/engine.js';
import { readMachLog, SYNTHETIC_FIREFOX_PATHS as PATHS } from '../testing/firefox.js';
import { git } from '../testing/git.js';
import { useTempDir, writeTree } from '../testing/temp.js';
import { build } from './build.js';
import { pinKey } from './pin.js';
import {
  addWorkspace,
  leaseWorkspace,
  listWorkspaces,
  removeWorkspace,
  repairWorkspace,
} from './pool.js';
import { buildStaleness, readBuildBaseline } from './staleness.js';

const dir = useTempDir();
const logged = useMachSandbox();

/** A source-mode checkout on a host whose pristine repository exists. */
async function checkout(name = 'project'): Promise<Project> {
  return makeEngineProject(dir(), { source: true }, name);
}

async function seeded(): Promise<{ project: Project; commit: string }> {
  const project = await checkout();
  return { project, commit: await seedPristine(project.host) };
}

const pin = (project: Project): Project['config']['firefox'] => project.config.firefox;
const leasedName = (project: Project, name?: string): Promise<string> =>
  leaseWorkspace(project, { name, waitMs: 0 }, (workspace) => Promise.resolve(workspace.name));

describe('addWorkspace', () => {
  it('checks the pristine commit out as a real git repository', async () => {
    const { project, commit } = await seeded();
    const added = await addWorkspace(project.host, 'alpha', { pin: pin(project) });
    expect(added).toMatchObject({
      name: 'alpha',
      dir: join(project.host.workspaces, 'alpha'),
      pin: TEST_PIN_KEY,
      commit,
      built: false,
      holders: [],
    });
    expect((await git(added.engineDir, ['rev-parse', 'HEAD'])).trim()).toBe(commit);
    expect((await git(added.engineDir, ['status', '--porcelain'])).trim()).toBe('');
    expect(await readFile(join(added.engineDir, '.git/info/exclude'), 'utf8')).toContain(
      '/obj-fireforge/\n/mozconfig\n'
    );
    expect((await listWorkspaces(project.host)).map((workspace) => workspace.name)).toEqual([
      'alpha',
    ]);
  });

  it('refuses a bad name, a taken name, and a pin this host never downloaded', async () => {
    const { project } = await seeded();
    await expect(addWorkspace(project.host, '../up', { pin: pin(project) })).rejects.toMatchObject({
      code: 'invalid-argument',
      exitCode: ExitCode.INVALID_ARGUMENT,
    });
    await addWorkspace(project.host, 'alpha', { pin: pin(project) });
    await expect(addWorkspace(project.host, 'alpha', { pin: pin(project) })).rejects.toMatchObject({
      code: 'workspace-exists',
    });
    const other = { ...pin(project), version: '141.0esr' };
    await expect(addWorkspace(project.host, 'beta', { pin: other })).rejects.toMatchObject({
      code: 'pristine-missing',
      hint: expect.stringContaining('fireforge download') as string,
    });
    // A release candidate is another archive than the release, filed apart from it.
    const candidate = { ...pin(project), candidate: 'build2' };
    expect(pinKey(candidate)).toBe(`${TEST_PIN_KEY}-build2`);
    await expect(addWorkspace(project.host, 'rc', { pin: candidate })).rejects.toMatchObject({
      code: 'pristine-missing',
    });
    // A failed creation leaves nothing half-made behind.
    expect((await listWorkspaces(project.host)).map((workspace) => workspace.name)).toEqual([
      'alpha',
    ]);
  });
});

describe('leaseWorkspace', () => {
  it('creates the first workspace of a pin, and hands the command a workspace it can build in', async () => {
    const { project } = await seeded();
    const seen = await leaseWorkspace(project, {}, async (workspace) => {
      expect(workspace).toMatchObject({
        name: 'w1',
        kind: 'pool',
        engineDir: join(project.host.workspaces, 'w1', 'engine'),
        objDir: join(project.host.workspaces, 'w1', 'engine', 'obj-fireforge'),
        stateDir: join(project.host.workspaces, 'w1'),
        project,
      });
      const [listed] = await listWorkspaces(project.host);
      expect(listed?.holders.map((holder) => holder.pid)).toEqual([process.pid]);
      await build(workspace);
      return workspace;
    });
    expect(logged()).toContain('creating "w1"');
    expect(await readBuildBaseline(seen)).toMatchObject({ kind: 'full' });
    expect(await listWorkspaces(project.host)).toMatchObject([
      { name: 'w1', built: true, holders: [], lessee: { root: project.root } },
    ]);
    expect(await leasedName(project)).toBe('w1');
  });

  it('prefers the workspace this checkout used last, then the least recently used', async () => {
    const { project: first } = await seeded();
    const [second, third] = [await checkout('second'), await checkout('third')];
    await addWorkspace(first.host, 'alpha', { pin: pin(first) });
    await addWorkspace(first.host, 'beta', { pin: pin(first) });
    expect(await leasedName(first)).toBe('alpha');
    await sleep(5);
    expect(await leasedName(second)).toBe('beta');
    await sleep(5);
    // Each checkout returns to its own, whichever was used more recently.
    expect(await leasedName(first)).toBe('alpha');
    expect(await leasedName(second)).toBe('beta');
    await sleep(5);
    expect(await leasedName(first)).toBe('alpha');
    // A newcomer takes the one idle longest, and from then on it is its own.
    expect(await leasedName(third)).toBe('beta');
    expect(await leasedName(third)).toBe('beta');
    expect(await leasedName(second)).toBe('alpha');
  });

  it('takes a free workspace when its preferred one is leased, and waits when all are', async () => {
    const { project: first } = await seeded();
    const second = await checkout('second');
    await addWorkspace(first.host, 'alpha', { pin: pin(first) });
    await addWorkspace(first.host, 'beta', { pin: pin(first) });
    await leasedName(second, 'alpha');
    await leaseWorkspace(first, { name: 'alpha', command: 'build' }, async () => {
      expect(await leasedName(second)).toBe('beta');
      await leaseWorkspace(first, { name: 'beta' }, async () => {
        await expect(leasedName(second)).rejects.toMatchObject({
          code: 'lock-timeout',
          exitCode: ExitCode.LOCK_TIMEOUT,
          message: expect.stringMatching(
            new RegExp(
              `"alpha" by PID ${process.pid} \\(checkout=.*command=build\\); "beta" by PID`
            )
          ) as string,
        });
      });
    });
  });

  it('waits for a workspace to come free', async () => {
    const { project } = await seeded();
    await addWorkspace(project.host, 'alpha', { pin: pin(project) });
    const order: string[] = [];
    const holding = leaseWorkspace(project, {}, async () => {
      await sleep(300);
      order.push('first done');
    });
    await sleep(50);
    await leaseWorkspace(project, { waitMs: 10_000 }, () => {
      order.push('second ran');
      return Promise.resolve();
    });
    await holding;
    expect(order).toEqual(['first done', 'second ran']);
  });

  it('runs the prepare step under the lease, before the work, and releases when it fails', async () => {
    const { project } = await seeded();
    const order: string[] = [];
    await leaseWorkspace(
      project,
      {
        prepare: async (workspace) => {
          await writeTree(workspace.engineDir, { 'browser/owned.js': '// materialized\n' });
          order.push('prepare');
        },
      },
      async (workspace) => {
        order.push(await readFile(join(workspace.engineDir, 'browser/owned.js'), 'utf8'));
      }
    );
    expect(order).toEqual(['prepare', '// materialized\n']);
    await expect(
      leaseWorkspace(project, { prepare: () => Promise.reject(new Error('conflict')) }, () =>
        Promise.resolve('unreached')
      )
    ).rejects.toThrow('conflict');
    expect(await leasedName(project)).toBe('w1');
  });

  it('refuses a named workspace that is absent or on another Firefox', async () => {
    const { project } = await seeded();
    await addWorkspace(project.host, 'alpha', { pin: pin(project) });
    await expect(leasedName(project, 'nope')).rejects.toMatchObject({
      code: 'workspace-not-found',
      hint: 'The pool has: alpha.',
    });
    const moved = await makeEngineProject(
      dir(),
      { source: true, config: { firefox: { version: '141.0esr', product: 'firefox-esr' } } },
      'moved'
    );
    await expect(leasedName(moved, 'alpha')).rejects.toMatchObject({
      code: 'workspace-pin-mismatch',
    });
    // Without a name, a project on another pin never gets this pin's workspace.
    await expect(leasedName(moved)).rejects.toMatchObject({ code: 'pristine-missing' });
  });
});

describe('removeWorkspace and repairWorkspace', () => {
  it('refuse while the workspace is leased, naming the holder', async () => {
    const { project } = await seeded();
    await addWorkspace(project.host, 'alpha', { pin: pin(project) });
    await leaseWorkspace(project, { command: 'test' }, async () => {
      for (const act of [removeWorkspace, repairWorkspace]) {
        await expect(act(project.host, 'alpha')).rejects.toMatchObject({
          code: 'workspace-busy',
          message: expect.stringContaining(`leased by PID ${process.pid}`) as string,
        });
      }
    });
    await removeWorkspace(project.host, 'alpha');
    expect(await listWorkspaces(project.host)).toEqual([]);
    await expect(removeWorkspace(project.host, 'alpha')).rejects.toMatchObject({
      code: 'workspace-not-found',
    });
  });

  it('repair resets the engine to pristine, keeps the build, and forgets what was materialized', async () => {
    const { project } = await seeded();
    const ledger = defineStateSection('materialized', s.array(s.string()), 'none');
    const workspace = await leaseWorkspace(project, {}, async (leased) => {
      await writeTree(leased.engineDir, {
        [PATHS.browserScript]: '// owned edit\n',
        'browser/owned.js': '// owned file\n',
      });
      await updateState(leased, ledger, () => [PATHS.browserScript, 'browser/owned.js']);
      await build(leased);
      return leased;
    });
    await writeFile(join(workspace.engineDir, '.git/index.lock'), '');

    await repairWorkspace(project.host, 'w1');
    expect(await readFile(join(workspace.engineDir, PATHS.browserScript), 'utf8')).toBe(
      'export const browserTitle = "baseline";\n'
    );
    await expect(lstat(join(workspace.engineDir, 'browser/owned.js'))).rejects.toThrow();
    expect((await git(workspace.engineDir, ['status', '--porcelain'])).trim()).toBe('');
    expect((await lstat(join(workspace.objDir, 'dist'))).isDirectory()).toBe(true);
    expect(await readState(workspace, ledger)).toBeUndefined();
    expect(await readBuildBaseline(workspace)).toMatchObject({ kind: 'full' });
    // The build is of the owned source, which the engine no longer holds until it is prepared again.
    expect(await buildStaleness(workspace)).toMatchObject({ needs: 'ui' });
    await writeTree(workspace.engineDir, {
      [PATHS.browserScript]: '// owned edit\n',
      'browser/owned.js': '// owned file\n',
    });
    expect(await buildStaleness(workspace)).toEqual({ state: 'fresh' });
  });
});

describe('a workspace cloned from a built one', () => {
  it('takes the engine and what is recorded about its content, and none of its builds', async (test) => {
    const { project } = await seeded();
    const ledger = defineStateSection('ledger', s.object({ files: s.array(s.string()) }), 'none');
    await leaseWorkspace(project, { name: undefined }, async (workspace) => {
      await writeTree(workspace.engineDir, { [PATHS.browserScript]: '// owned edit\n' });
      await updateState(workspace, ledger, () => ({ files: [PATHS.browserScript] }));
      await build(workspace);
      await writeTree(workspace.releaseObjDir, { 'dist/browser.dmg': 'a release\n' });
    });
    try {
      await addWorkspace(project.host, 'copy', { pin: pin(project), from: 'w1' });
    } catch (error: unknown) {
      // The temporary directory's filesystem cannot clone copy-on-write.
      if ((error as { code?: string }).code === 'clone-unsupported') test.skip();
      throw error;
    }
    expect(await listWorkspaces(project.host)).toMatchObject([
      { name: 'copy', built: false, clonedFrom: 'w1', pin: TEST_PIN_KEY },
      { name: 'w1', built: true },
    ]);
    await leaseWorkspace(project, { name: 'copy' }, async (workspace) => {
      expect(await readFile(join(workspace.engineDir, PATHS.browserScript), 'utf8')).toBe(
        '// owned edit\n'
      );
      expect(await readState(workspace, ledger)).toEqual({ files: [PATHS.browserScript] });
      expect(await git(workspace.engineDir, ['status', '--porcelain'])).toContain(
        ` M ${PATHS.browserScript}\n`
      );
      // A build belongs to the path it was configured at, so none came along.
      await expect(lstat(workspace.objDir)).rejects.toThrow();
      await expect(lstat(join(workspace.stateDir, 'release'))).rejects.toThrow();
      expect(await readBuildBaseline(workspace)).toBeUndefined();
      expect(await buildStaleness(workspace)).toMatchObject({
        needs: 'full',
        why: 'no build of this workspace is recorded',
      });
      const result = await build(workspace);
      expect(result.discardedObjdirOf).toBeUndefined();
      // The stand-in's log came along with the clone; this call is the clone's own.
      const calls = (await readMachLog(workspace.engineDir)).map((call) => call.args[0]);
      expect(calls.at(-1)).toBe('build');
      expect(calls).not.toContain('configure');
      expect(await buildStaleness(workspace)).toEqual({ state: 'fresh' });
    });
    // The source of the clone keeps its builds and still builds in place.
    await leaseWorkspace(project, { name: 'w1' }, async (workspace) => {
      expect((await lstat(join(workspace.releaseObjDir, 'dist/browser.dmg'))).isFile()).toBe(true);
      expect(await buildStaleness(workspace)).toEqual({ state: 'fresh' });
      expect((await build(workspace)).discardedObjdirOf).toBeUndefined();
    });
  });

  it('is refused while the source is leased or on another pin', async () => {
    const { project } = await seeded();
    await addWorkspace(project.host, 'alpha', { pin: pin(project) });
    await leaseWorkspace(project, { name: 'alpha' }, async () => {
      await expect(
        addWorkspace(project.host, 'copy', { pin: pin(project), from: 'alpha' })
      ).rejects.toMatchObject({ code: 'workspace-busy' });
    });
    await expect(
      addWorkspace(project.host, 'copy', {
        pin: { ...pin(project), version: '141.0esr' },
        from: 'alpha',
      })
    ).rejects.toMatchObject({ code: 'workspace-pin-mismatch' });
    expect((await listWorkspaces(project.host)).map((workspace) => workspace.name)).toEqual([
      'alpha',
    ]);
  });
});
