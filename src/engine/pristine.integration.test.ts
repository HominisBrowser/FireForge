// SPDX-License-Identifier: EUPL-1.2
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { hashFile } from '../kernel/hash.js';
import { hostPaths, loadProject, type PatchProject } from '../project/index.js';
import { makeSyntheticFirefoxArchive } from '../testing/firefox.js';
import { git } from '../testing/git.js';
import { useTempDir, writeTree } from '../testing/temp.js';
import { sourceArchive } from './archive.js';
import type { FirefoxPin } from './pin.js';
import {
  checkoutPristine,
  ensurePristine,
  findPristine,
  installProjectEngine,
  listPristineTree,
  readPristineFiles,
} from './pristine.js';

const run = promisify(execFile);
const dir = useTempDir();

const pin: FirefoxPin = {
  version: '140.9.0esr',
  product: 'firefox-esr',
  allowUnverifiedDownload: false,
};

/** Files upstream's own ignore rules would hide, and what makes the import add `.hgignore`. */
const EXTRA = {
  'obj-shipped/kept.txt': 'ignored by .gitignore, still part of the archive\n',
  'tools/lint/ignorefile.yml': 'ignorefile:\n  include: [.gitignore, .hgignore]\n',
  'browser/config/version.txt': '140.9.0\n',
};

/**
 * A network serving one synthetic archive and its published digest. The
 * archive is packed and extracted by a `tar` that handles xz, which Windows
 * is not relied on to have: the tests using it are skipped there.
 */
async function mozilla(extra = EXTRA): Promise<typeof fetch & { calls: string[]; file: string }> {
  const file = await makeSyntheticFirefoxArchive(join(dir(), 'mozilla'), pin.version, extra);
  const archive = sourceArchive(pin);
  const sums = `${await hashFile(file)}  ${archive.pathInChecksums}\n`;
  const calls: string[] = [];
  const serve = async (input: string | URL | Request): Promise<Response> => {
    const url = input as string;
    calls.push(url);
    if (url === archive.url) return new Response(await readFile(file));
    return url === archive.checksumsUrl ? new Response(sums) : new Response('', { status: 404 });
  };
  return Object.assign(serve, { calls, file });
}

const hostAt = (name: string): ReturnType<typeof hostPaths> =>
  hostPaths({ FIREFORGE_HOME: join(dir(), name) });

describe('ensurePristine', () => {
  it.skipIf(process.platform === 'win32')(
    'imports the archive as the same commit on every host, and as the commit plain git gives',
    async () => {
      const network = await mozilla();
      const first = await ensurePristine(hostAt('host-a'), pin, { fetch: network });
      const second = await ensurePristine(hostAt('host-b'), pin, { fetch: network });
      expect(second.commit).toBe(first.commit);
      expect(first.repo).toBe(join(dir(), 'host-a', 'pristine', 'firefox-esr-140.9.0esr'));

      // The recipe the commit id is pinned to: every archive file, the ignore
      // file mach lint needs, one fixed author, date and message.
      const plain = join(dir(), 'plain');
      await mkdir(plain);
      await run('tar', ['-xf', network.file, '-C', plain, '--strip-components=1']);
      await copyFile(join(plain, '.gitignore'), join(plain, '.hgignore'));
      await git(plain, ['init', '--initial-branch', 'main']);
      await git(plain, ['config', 'core.autocrlf', 'false']);
      await git(plain, ['add', '-A', '-f']);
      await run(
        'git',
        [
          ...['-c', 'user.name=FireForge', '-c', 'user.email=fireforge@localhost'],
          ...['commit', '--quiet', '-m', 'Initial Firefox source'],
        ],
        {
          cwd: plain,
          env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
            GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
          },
        }
      );
      expect(first.commit).toBe((await git(plain, ['rev-parse', 'HEAD'])).trim());
    }
  );

  it.skipIf(process.platform === 'win32')(
    'leaves a bare repository with main at the commit and a record of the pin',
    async () => {
      const host = hostAt('host');
      const pristine = await ensurePristine(host, pin, { fetch: await mozilla() });
      expect((await git(pristine.repo, ['rev-parse', '--is-bare-repository'])).trim()).toBe('true');
      expect((await git(pristine.repo, ['rev-parse', 'refs/heads/main'])).trim()).toBe(
        pristine.commit
      );
      expect((await git(pristine.repo, ['rev-list', '--count', 'main'])).trim()).toBe('1');
      const record = JSON.parse(
        await readFile(join(pristine.repo, 'fireforge-pin.json'), 'utf8')
      ) as unknown;
      expect(record).toEqual({ firefox: pin, commit: pristine.commit });
      expect(await findPristine(host, pin)).toEqual(pristine);
      // Nothing of the import is left beside it.
      expect(await readdir(host.pristine)).toEqual(['firefox-esr-140.9.0esr']);
    }
  );

  it.skipIf(process.platform === 'win32')(
    'holds every archive file, ignored ones included, and exposes them to readers',
    async () => {
      const pristine = await ensurePristine(hostAt('host'), pin, { fetch: await mozilla() });
      const files = await readPristineFiles(pristine, [
        'obj-shipped/kept.txt',
        '.hgignore',
        '.gitignore',
        'no/such/file',
      ]);
      expect(files.get('obj-shipped/kept.txt')?.toString()).toBe(EXTRA['obj-shipped/kept.txt']);
      expect(files.get('.hgignore')).toEqual(files.get('.gitignore'));
      expect(files.has('no/such/file')).toBe(false);
      const mach = await listPristineTree(pristine, ['mach']);
      expect(mach).toMatchObject([{ path: 'mach', mode: '100755', type: 'blob' }]);
      expect((await listPristineTree(pristine)).map((entry) => entry.path)).toContain(
        'browser/base/content/browser.js'
      );
    }
  );

  it.skipIf(process.platform === 'win32')('uses the network once per pin', async () => {
    const host = hostAt('host');
    const network = await mozilla();
    const [a, b] = await Promise.all([
      ensurePristine(host, pin, { fetch: network }),
      ensurePristine(host, pin, { fetch: network }),
    ]);
    expect(a).toEqual(b);
    const offline: typeof fetch = () => Promise.reject(new Error('offline'));
    expect(await ensurePristine(host, pin, { fetch: offline })).toEqual(a);
    expect(network.calls.filter((url) => url.endsWith('.tar.xz'))).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses an archive that does not reproduce the pinned commit, leaving no repository',
    async () => {
      const host = hostAt('host');
      const expectCommit = 'a'.repeat(40);
      await expect(
        ensurePristine(host, pin, { fetch: await mozilla(), expectCommit })
      ).rejects.toMatchObject({ code: 'pristine-commit-mismatch', exitCode: 2 });
      expect(await findPristine(host, pin)).toBeUndefined();
      expect(await readdir(host.pristine)).toEqual([]);

      const pristine = await ensurePristine(host, pin, { fetch: await mozilla() });
      await expect(ensurePristine(host, pin, { expectCommit })).rejects.toMatchObject({
        code: 'pristine-commit-mismatch',
      });
      expect(await ensurePristine(host, pin, { expectCommit: pristine.commit })).toEqual(pristine);
    }
  );

  it('finds a repository filed without the candidate when its record names the same archive', async () => {
    const host = hostAt('host');
    const candidate: FirefoxPin = { ...pin, candidate: 'build1', sha256: 'ab'.repeat(32) };
    const repo = join(host.pristine, 'firefox-esr-140.9.0esr');
    const commit = 'c'.repeat(40);
    await writeTree(repo, { 'fireforge-pin.json': JSON.stringify({ firefox: candidate, commit }) });
    expect(await findPristine(host, candidate)).toEqual({ repo, commit });
    // Another candidate, another digest, or no digest to compare is another archive.
    expect(await findPristine(host, { ...candidate, candidate: 'build2' })).toBeUndefined();
    expect(await findPristine(host, { ...candidate, sha256: 'cd'.repeat(32) })).toBeUndefined();
    await writeTree(repo, {
      'fireforge-pin.json': JSON.stringify({ firefox: { ...pin, candidate: 'build1' }, commit }),
    });
    expect(await findPristine(host, { ...pin, candidate: 'build1' })).toBeUndefined();
  });

  it('reports a malformed record instead of importing over it', async () => {
    const host = hostAt('host');
    await writeTree(join(host.pristine, 'firefox-esr-140.9.0esr'), {
      'fireforge-pin.json': '{"commit": 7}',
    });
    await expect(findPristine(host, pin)).rejects.toMatchObject({
      code: 'pristine-invalid',
      exitCode: 2,
    });
  });
});

// The archive is packed and extracted by a `tar` that handles xz.
describe.skipIf(process.platform === 'win32')('checkoutPristine', () => {
  it('creates a clean checkout on main that does not depend on the store', async () => {
    const pristine = await ensurePristine(hostAt('host'), pin, { fetch: await mozilla() });
    const engine = join(dir(), 'engine');
    await checkoutPristine(pristine, engine);
    expect((await git(engine, ['rev-parse', 'HEAD'])).trim()).toBe(pristine.commit);
    expect((await git(engine, ['symbolic-ref', '--short', 'HEAD'])).trim()).toBe('main');
    expect((await git(engine, ['status', '--porcelain', '--ignored'])).trim()).toBe('');
    expect((await stat(join(engine, 'mach'))).mode & 0o111).not.toBe(0);
    await expect(readFile(join(engine, '.git/objects/info/alternates'))).rejects.toThrow();

    await expect(checkoutPristine(pristine, engine)).rejects.toMatchObject({
      code: 'engine-exists',
    });
  });
});

// The archive is packed and extracted by a `tar` that handles xz.
describe.skipIf(process.platform === 'win32')('installProjectEngine', () => {
  async function patchProject(): Promise<PatchProject> {
    const root = join(dir(), 'project');
    await writeTree(root, {
      'fireforge.json': JSON.stringify({
        name: 'Example',
        vendor: 'Example Org',
        appId: 'org.example.browser',
        binaryName: 'example',
        firefox: { version: pin.version, product: pin.product },
      }),
    });
    const project = await loadProject(root, { FIREFORGE_HOME: join(dir(), 'host') });
    if (project.mode !== 'patches') throw new Error('expected a patch-mode project');
    return project;
  }

  it('creates the engine, refuses to replace it, and with force carries its changes over', async () => {
    const project = await patchProject();
    const pristine = await ensurePristine(project.host, pin, { fetch: await mozilla() });
    expect(await installProjectEngine(project, pristine)).toEqual({
      engineDir: project.paths.engine,
      replaced: false,
    });
    const engine = project.paths.engine;
    await writeFile(join(engine, 'browser/base/content/browser.js'), 'edited\n');
    await writeFile(join(engine, 'browser/new.js'), 'unexported\n');

    await expect(installProjectEngine(project, pristine)).rejects.toMatchObject({
      code: 'engine-exists',
    });
    expect(await readFile(join(engine, 'browser/new.js'), 'utf8')).toBe('unexported\n');

    const replaced = await installProjectEngine(project, pristine, { force: true });
    expect(replaced.replaced).toBe(true);
    expect(replaced.recovery).toMatch(/^refs\/fireforge\/recovery\/.+-download-/);
    expect((await git(engine, ['status', '--porcelain'])).trim()).toBe('');
    const saved = replaced.recovery ?? '';
    expect(await git(engine, ['show', `${saved}:browser/new.js`])).toBe('unexported\n');
    expect(await git(engine, ['show', `${saved}:browser/base/content/browser.js`])).toBe(
      'edited\n'
    );
    expect((await readdir(project.root)).sort()).toEqual([
      '.fireforge',
      'engine',
      'fireforge.json',
    ]);
  });

  it('replaces a directory that is not a repository without a snapshot', async () => {
    const project = await patchProject();
    const pristine = await ensurePristine(project.host, pin, { fetch: await mozilla() });
    await writeTree(project.paths.engine, { 'half/extracted.txt': 'left by a crash\n' });
    expect(await installProjectEngine(project, pristine, { force: true })).toEqual({
      engineDir: project.paths.engine,
      replaced: true,
    });
    expect((await git(project.paths.engine, ['rev-parse', 'HEAD'])).trim()).toBe(pristine.commit);
  });
});
