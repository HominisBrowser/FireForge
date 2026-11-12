// SPDX-License-Identifier: EUPL-1.2
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ExitCode, type FireForgeError } from '../kernel/errors.js';
import { git, initRepo } from '../testing/git.js';
import { useTempDir, writeTree } from '../testing/temp.js';
import { findProjectRoot, hostPaths, loadProject, readCheckout } from './index.js';

const dir = useTempDir();

const CONFIG = {
  name: 'Mine',
  vendor: 'Example',
  appId: 'org.example.mine',
  binaryName: 'mine',
  firefox: { version: '153.4.0esr', product: 'firefox-esr' },
};

const SOURCE = { root: 'src', metadataRoot: '.fireforge-sources', pristineCommit: 'b'.repeat(40) };

async function failure(promise: Promise<unknown>): Promise<FireForgeError> {
  return promise.then(
    () => {
      throw new Error('expected a failure');
    },
    (error: unknown) => error as FireForgeError
  );
}

describe('findProjectRoot', () => {
  it('returns the nearest directory at or above cwd holding fireforge.json', async () => {
    const nested = join(dir(), 'engine', 'browser', 'modules');
    await mkdir(nested, { recursive: true });
    await writeFile(join(dir(), 'fireforge.json'), '{}');
    expect(await findProjectRoot(nested)).toBe(dir());
    expect(await findProjectRoot(dir())).toBe(dir());
  });

  it('refuses with exit code 2 when no directory above has one', async () => {
    const error = await failure(findProjectRoot(dir()));
    expect(error.code).toBe('project-not-found');
    expect(error.exitCode).toBe(ExitCode.CONFIG_ERROR);
  });
});

describe('loadProject', () => {
  it('loads a patch-mode project with the engine among its paths', async () => {
    await writeTree(dir(), { 'fireforge.json': JSON.stringify(CONFIG) });
    const project = await loadProject(join(dir(), 'patches'), { FIREFORGE_HOME: '/host' });
    expect(project.mode).toBe('patches');
    expect(project.root).toBe(dir());
    expect(project.paths).toEqual({
      root: dir(),
      config: join(dir(), 'fireforge.json'),
      furnace: join(dir(), 'furnace.json'),
      stateDir: join(dir(), '.fireforge'),
      state: join(dir(), '.fireforge', 'state.json'),
      patches: join(dir(), 'patches'),
      components: join(dir(), 'components'),
      configs: join(dir(), 'configs'),
      engine: join(dir(), 'engine'),
    });
    expect(project.host.workspaces).toBe(join('/host', 'workspaces'));
  });

  it('loads a source-mode project with its source and metadata roots', async () => {
    const config = { ...CONFIG, mode: 'source', source: SOURCE };
    await writeTree(dir(), { 'fireforge.json': JSON.stringify(config) });
    const project = await loadProject(dir(), {});
    if (project.mode !== 'source') throw new Error('expected source mode');
    expect(project.paths.source).toBe(join(dir(), 'src'));
    expect(project.paths.sourceMetadata).toBe(join(dir(), '.fireforge-sources'));
    expect(project.config.source.pristineCommit).toBe('b'.repeat(40));
    expect('engine' in project.paths).toBe(false);
  });

  it('carries the checkout the project sits in', async () => {
    await initRepo(dir(), { 'fireforge.json': JSON.stringify(CONFIG) });
    const project = await loadProject(dir(), {});
    expect(project.checkout).toEqual(await readCheckout(dir()));
    expect(project.checkout.worktree).toBe(dir());
  });

  it('refuses an invalid configuration with exit code 2', async () => {
    await writeTree(dir(), { 'fireforge.json': JSON.stringify({ ...CONFIG, mode: 'source' }) });
    const error = await failure(loadProject(dir(), {}));
    expect(error.code).toBe('config-invalid');
    expect(error.message).toContain('needs a "source" block');
  });
});

describe('hostPaths', () => {
  it('lives under ~/.fireforge unless FIREFORGE_HOME moves it', () => {
    expect(hostPaths({}).root).toBe(join(homedir(), '.fireforge'));
    expect(hostPaths({ FIREFORGE_HOME: '' }).root).toBe(join(homedir(), '.fireforge'));
    expect(hostPaths({ FIREFORGE_HOME: '/srv/ff' })).toEqual({
      root: '/srv/ff',
      pristine: join('/srv/ff', 'pristine'),
      workspaces: join('/srv/ff', 'workspaces'),
      locks: join('/srv/ff', 'locks'),
      cache: join('/srv/ff', 'cache'),
    });
  });

  it('refuses a relative FIREFORGE_HOME', () => {
    expect(() => hostPaths({ FIREFORGE_HOME: 'relative/home' })).toThrow(
      expect.objectContaining({ code: 'fireforge-home-invalid' }) as Error
    );
  });
});

describe('readCheckout', () => {
  it('describes a directory outside git by the project root', async () => {
    const checkout = await readCheckout(dir());
    expect(checkout).toMatchObject({ worktree: undefined, gitDir: undefined, linked: false });
    expect(checkout.key).toMatch(/^[0-9a-f]{16}$/);
  });

  it('gives each worktree its own stable key and the repository one common directory', async () => {
    const main = join(dir(), 'main');
    await initRepo(main, { 'fireforge.json': '{}', 'nested/x': '' });
    const linked = join(dir(), 'linked');
    await git(main, ['worktree', 'add', '-q', '-b', 'side', linked]);

    const first = await readCheckout(join(main, 'nested'));
    const second = await readCheckout(linked);
    expect(first).toMatchObject({ worktree: main, linked: false, gitDir: join(main, '.git') });
    expect(second).toMatchObject({ worktree: linked, linked: true, commonDir: first.commonDir });
    expect(second.key).not.toBe(first.key);
    expect((await readCheckout(linked)).key).toBe(second.key);

    await git(linked, ['checkout', '-q', '-b', 'other']);
    expect((await readCheckout(linked)).key).toBe(second.key);
  });

  it('refuses a .git file that points nowhere', async () => {
    await writeFile(join(dir(), '.git'), 'gitdir: /nowhere/at/all\n');
    const error = await failure(readCheckout(dir()));
    expect(error.code).toBe('checkout-broken');
    expect(error.exitCode).toBe(ExitCode.GIT_ERROR);
  });
});
