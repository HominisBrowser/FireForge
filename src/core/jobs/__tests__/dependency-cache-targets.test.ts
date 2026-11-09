// SPDX-License-Identifier: EUPL-1.2
/** What replacing a slot's dependency tree may delete, and what it can say about the tree it installs. */
import { execFileSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DependencyCacheConfig } from '../../../types/config.js';
import { warn } from '../../../utils/logger.js';
import type { AuthoredSnapshot } from '../../authored/types.js';
import { ensureDependencyCachesCurrent, installDependencyCaches } from '../dependency-caches.js';
import type { SlotRecord } from '../slot-types.js';
import { slotDirectory, writeDurable } from '../store.js';

vi.mock('../../../utils/logger.js', async (original) => ({
  ...(await original<typeof import('../../../utils/logger.js')>()),
  warn: vi.fn(),
}));

const directories: string[] = [];
beforeEach(() => {
  vi.mocked(warn).mockClear();
});
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

const put = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
};

interface Slot {
  directory: string;
  namespace: string;
  root: string;
  pristine: string;
  commit: string;
  /** Installs what `declared` says, from a tree on disk, with a lockfile of these bytes. */
  install: (
    declared: DependencyCacheConfig[],
    trees: Array<{ source: string; target: string }>,
    lockfiles?: Record<string, string>,
    replace?: boolean
  ) => Promise<void>;
}

async function slot(): Promise<Slot> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'fireforge-targets-')));
  directories.push(directory);
  const namespace = join(directory, 'coordinator');
  const root = join(namespace, 'slots/a/root');
  await put(join(root, 'engine/mach'), 'keep me\n');
  await put(join(root, 'engine/obj-x/dist/bin/fixture'), 'keep me\n');
  const pristine = join(directory, 'pristine');
  await put(join(pristine, 'browser/tracked/node_modules/x/index.js'), 'upstream\n');
  const git = (...args: string[]): string =>
    execFileSync(
      'git',
      ['-C', pristine, '-c', 'user.email=f@example.invalid', '-c', 'user.name=f', ...args],
      { encoding: 'utf8' }
    ).trim();
  git('init', '-q');
  git('add', '-A', '-f');
  git('commit', '-qm', 'upstream');
  const commit = git('rev-parse', 'HEAD');
  return {
    directory,
    namespace,
    root,
    pristine,
    commit,
    install: async (declared, trees, lockfiles = {}, replace = false) => {
      const inputs = await Promise.all(
        Object.entries(lockfiles).map(async ([path, text]) => {
          const file = join(directory, 'blobs', path);
          await put(file, text);
          const blob = execFileSync('git', ['-C', pristine, 'hash-object', '-w', file], {
            encoding: 'utf8',
          }).trim();
          return { path, blob, mode: '100644' };
        })
      );
      await installDependencyCaches({
        namespace,
        slotId: 'a',
        root,
        pristineRepository: pristine,
        snapshot: {
          config: { slots: { dependencyCaches: declared } },
          inputs,
          files: [],
          pin: { commit },
          repository: pristine,
        } as unknown as AuthoredSnapshot,
        caches: trees,
        replace,
      });
    },
  };
}

const lock = (version: string): string =>
  JSON.stringify({ packages: { '': {}, 'node_modules/x': { version } } });

describe('replacing a dependency tree', () => {
  it('refuses a target spelled to reach the engine, leaving it whole', async () => {
    const f = await slot();
    const source = join(f.directory, 'tree');
    await put(join(source, 'x.js'), '1\n');
    await expect(
      f.install([{ source: 'tree', target: 'x/../engine' }], [{ source, target: 'x/../engine' }])
    ).rejects.toThrow(/canonical relative path/);
    expect(await readFile(join(f.root, 'engine/mach'), 'utf8')).toBe('keep me\n');
    expect(await readFile(join(f.root, 'engine/obj-x/dist/bin/fixture'), 'utf8')).toBe('keep me\n');
  });

  it('refuses a recorded target no longer declared, rather than deleting what it spells', async () => {
    const f = await slot();
    await writeDurable(join(slotDirectory(f.namespace, 'a'), 'dependency-caches.json'), {
      'x/../engine': { lockfile: 'l', lockfileDigest: null, digest: 'd', signature: 's' },
    });
    await expect(f.install([], [], {}, true)).rejects.toThrow(/fireforge slot remove a/);
    expect(await readFile(join(f.root, 'engine/mach'), 'utf8')).toBe('keep me\n');
  });

  it('refuses a target reached through a link, deleting nothing where it points', async () => {
    const f = await slot();
    const outside = join(f.directory, 'outside');
    await put(join(outside, 'py/precious.txt'), 'keep me\n');
    await symlink(outside, join(f.root, 'vendor'));
    const source = join(f.directory, 'tree');
    await put(join(source, 'x.js'), '1\n');
    await expect(
      f.install([{ source: 'tree', target: 'vendor/py' }], [{ source, target: 'vendor/py' }])
    ).rejects.toThrow(/passes through/);
    expect(await readFile(join(outside, 'py/precious.txt'), 'utf8')).toBe('keep me\n');
  });

  it('refuses a node_modules upstream tracks, and takes one it does not', async () => {
    const f = await slot();
    const source = join(f.directory, 'tree');
    await put(join(source, 'x.js'), '1\n');
    const tracked = 'engine/browser/tracked/node_modules';
    await expect(
      f.install([{ source: 'tree', target: tracked }], [{ source, target: tracked }])
    ).rejects.toThrow(/overlaps tracked engine source/);
    await f.install(
      [{ source: 'tree', target: 'engine/node_modules', lockfile: 'none.lock' }],
      [{ source, target: 'engine/node_modules' }]
    );
    await expect(lstat(join(f.root, 'engine/node_modules/x.js'))).resolves.toBeDefined();
    expect(await readFile(join(f.root, 'engine/mach'), 'utf8')).toBe('keep me\n');
  });
});

describe('a tree and its lockfile', () => {
  const VENDORED = { source: 'vendor/deps', target: 'vendor/deps', lockfile: 'deps.lock' };

  it('compares any npm tree, whatever its directory is called', async () => {
    const f = await slot();
    const source = join(f.directory, 'vendor/deps');
    await put(join(source, '.package-lock.json'), lock('1.0.0'));
    await put(join(source, 'node_modules/x/index.js'), '1\n');
    const trees = [{ source, target: VENDORED.target }];
    await expect(f.install([VENDORED], trees, { 'deps.lock': lock('2.0.0') })).rejects.toThrow(
      /states as 2\.0\.0/
    );
    await f.install([VENDORED], trees, { 'deps.lock': lock('1.0.0') });
    expect(warn).not.toHaveBeenCalled();
  });

  it('still refuses a node_modules with no install record', async () => {
    const f = await slot();
    const source = join(f.directory, 'kit/node_modules');
    await put(join(source, 'x/index.js'), '1\n');
    const cache = { source: 'kit/node_modules', target: 'kit/node_modules', lockfile: 'k.lock' };
    await expect(
      f.install([cache], [{ source, target: cache.target }], { 'k.lock': lock('1.0.0') })
    ).rejects.toThrow(/no \.package-lock\.json/);
  });

  it('says a tree it cannot compare is held by its bytes, and that a moved lockfile did not move them', async () => {
    const f = await slot();
    const source = join(f.directory, 'vendor/py');
    await put(join(source, 'tool.py'), 'print(1)\n');
    const cache = { source: 'vendor/py', target: 'vendor/py', lockfile: 'vendor/py.lock' };
    const trees = [{ source, target: cache.target }];
    await f.install([cache], trees, { 'vendor/py.lock': 'v1\n' });
    expect(vi.mocked(warn).mock.calls[0]?.[0]).toMatch(
      /vendor\/py cannot be compared with its lockfile: vendor\/py\.lock is not an npm lockfile\. It is identified by its bytes/
    );
    expect(vi.mocked(warn).mock.calls[0]?.[0]).not.toMatch(/same bytes/);
    vi.mocked(warn).mockClear();
    await f.install([cache], trees, { 'vendor/py.lock': 'v2\n' });
    expect(vi.mocked(warn).mock.calls[0]?.[0]).toMatch(
      /vendor\/py\.lock changed and these are the same bytes as before/
    );
    vi.mocked(warn).mockClear();
    await put(join(source, 'tool.py'), 'print(2)\n');
    await f.install([cache], trees, { 'vendor/py.lock': 'v3\n' });
    expect(vi.mocked(warn).mock.calls[0]?.[0]).not.toMatch(/same bytes/);
  });

  it('says nothing of the root node_modules on a project with no lockfile', async () => {
    const f = await slot();
    const source = join(f.directory, 'node_modules');
    await put(join(source, 'x/index.js'), '1\n');
    await f.install([], [{ source, target: 'node_modules' }]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('checkouts on different lockfiles sharing a slot', () => {
  it('gives a job the tree its own lockfile was installed with, and refuses one never installed', async () => {
    const f = await slot();
    const tree = async (version: string): Promise<string> => {
      const source = join(f.directory, `checkout-${version}/node_modules`);
      await put(join(source, '.package-lock.json'), lock(version));
      await put(join(source, 'x/index.js'), `${version}\n`);
      return source;
    };
    await f.install([], [{ source: await tree('1.0.0'), target: 'node_modules' }], {
      'package-lock.json': lock('1.0.0'),
    });
    // Another checkout refreshes the slot for its own lockfile.
    await f.install(
      [],
      [{ source: await tree('2.0.0'), target: 'node_modules' }],
      { 'package-lock.json': lock('2.0.0') },
      true
    );
    const record = { id: 'a', root: f.root, pristineRepository: f.pristine } as SlotRecord;
    const snapshotFor = async (version: string): Promise<AuthoredSnapshot> => {
      const file = join(f.directory, 'blobs', `lock-${version}`);
      await put(file, lock(version));
      const blob = execFileSync('git', ['-C', f.pristine, 'hash-object', '-w', file], {
        encoding: 'utf8',
      }).trim();
      return {
        config: {},
        inputs: [{ path: 'package-lock.json', blob, mode: '100644' }],
        files: [],
        pin: { commit: f.commit },
        repository: f.pristine,
      } as unknown as AuthoredSnapshot;
    };
    // A job queued from the first checkout runs on its own tree, not the refreshed one.
    await ensureDependencyCachesCurrent(f.namespace, record, await snapshotFor('1.0.0'));
    expect(await readFile(join(f.root, 'node_modules/x/index.js'), 'utf8')).toBe('1.0.0\n');
    await ensureDependencyCachesCurrent(f.namespace, record, await snapshotFor('2.0.0'));
    expect(await readFile(join(f.root, 'node_modules/x/index.js'), 'utf8')).toBe('2.0.0\n');
    await ensureDependencyCachesCurrent(f.namespace, record, await snapshotFor('2.0.0'));
    await expect(
      ensureDependencyCachesCurrent(f.namespace, record, await snapshotFor('3.0.0'))
    ).rejects.toThrow(
      /installed for another package-lock\.json than this source's, and no slot on this host was given one for it\. Run: fireforge slot refresh-deps a/
    );
  });

  it('refuses a stored tree that does not land as the bytes it was stored with', async () => {
    const f = await slot();
    const install = async (version: string, replace = false): Promise<void> => {
      const source = join(f.directory, `checkout-${version}/node_modules`);
      await put(join(source, '.package-lock.json'), lock(version));
      await put(join(source, 'x/index.js'), `${version}\n`);
      await f.install(
        [],
        [{ source, target: 'node_modules' }],
        {
          'package-lock.json': lock(version),
        },
        replace
      );
    };
    await install('1.0.0');
    await install('2.0.0', true);
    const stores = join(f.namespace, 'dependency-trees');
    const [target] = await readdir(stores);
    const entries = await readdir(join(stores, target ?? ''));
    for (const entry of entries) {
      const stored = join(stores, target ?? '', entry, 'tree/x/index.js');
      if ((await readFile(stored, 'utf8')) === '1.0.0\n') await writeFile(stored, 'tampered\n');
    }
    const file = join(f.directory, 'blobs', 'lock-again');
    await put(file, lock('1.0.0'));
    const blob = execFileSync('git', ['-C', f.pristine, 'hash-object', '-w', file], {
      encoding: 'utf8',
    }).trim();
    await expect(
      ensureDependencyCachesCurrent(
        f.namespace,
        { id: 'a', root: f.root, pristineRepository: f.pristine } as SlotRecord,
        {
          config: {},
          inputs: [{ path: 'package-lock.json', blob, mode: '100644' }],
          files: [],
          pin: { commit: f.commit },
          repository: f.pristine,
        } as unknown as AuthoredSnapshot
      )
    ).rejects.toThrow(/is not the tree that was installed for it/);
  });
});
