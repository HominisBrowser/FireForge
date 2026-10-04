// SPDX-License-Identifier: EUPL-1.2
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { copyFile } from '../../utils/fs.js';
import { changedComponentSources, snapshotComponentSources } from '../component-source-guard.js';
import { assertEngineWriteBoundary } from '../engine-write-boundary.js';
import { attemptMozinfoRewrite, findObjdirRelocationViolation } from '../mach-build-artifacts.js';
import {
  assertHealthyPartialConfig,
  assertLocalObjdir,
  findStaleObjdirLink,
  pruneDanglingTestLinks,
  relocateObjdirProducts,
} from '../objdir-maintenance.js';

let root: string;
let engine: string;
const obj = 'obj-debug';
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'ff-forge-regression-')));
  engine = join(root, 'engine');
  await mkdir(join(engine, obj), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
}

describe('source preservation', () => {
  it.each(['symlink', 'hardlink'])(
    'deploy detaches a destination %s instead of modifying the linked source',
    async (kind) => {
      const authored = join(root, 'components/custom/widget/widget.css');
      const incoming = join(root, 'incoming.css');
      const deployed = join(engine, 'widget.css');
      await put(authored, 'edited component');
      await put(incoming, 'engine payload');
      if (kind === 'symlink') await symlink(authored, deployed);
      else await link(authored, deployed);
      await copyFile(incoming, deployed);
      expect(await readFile(authored, 'utf8')).toBe('edited component');
      expect(await readFile(deployed, 'utf8')).toBe('engine payload');
    }
  );

  it('refuses a destination directory aliased to components before mkdir/copy', async () => {
    const sources = join(root, 'components/custom/widget');
    await mkdir(sources, { recursive: true });
    await put(join(sources, 'widget.css'), 'unexported edit');
    await symlink(sources, join(engine, 'widget'));
    await expect(assertEngineWriteBoundary(engine, join(engine, 'widget'))).rejects.toThrow(
      /outside engine/
    );
    expect(await readFile(join(sources, 'widget.css'), 'utf8')).toBe('unexported edit');
  });

  it('detects source reversion, removal and addition independently of the write-through protections', async () => {
    const sources = join(root, 'components/custom/widget');
    await put(join(sources, 'widget.css'), 'unexported edit');
    await put(join(sources, 'widget.mjs'), 'module');
    const before = await snapshotComponentSources([sources, join(root, 'absent')]);
    expect(await changedComponentSources([sources], before)).toEqual([]);
    await put(join(sources, 'widget.css'), 'reverted HEAD');
    await rm(join(sources, 'widget.mjs'));
    await put(join(sources, 'new.css'), 'added');
    expect(await changedComponentSources([sources], before)).toEqual([
      join(sources, 'new.css'),
      join(sources, 'widget.css'),
      join(sources, 'widget.mjs'),
    ]);
  });

  it('accepts an in-engine alias and a not-yet-created descendant', async () => {
    await mkdir(join(engine, 'local'));
    await symlink(join(engine, 'local'), join(engine, 'alias'));
    await assertEngineWriteBoundary(engine, join(engine, 'alias', 'new', 'child'));
  });
});

it('never prunes dangling links in a peer objdir reached through an ancestor alias', async () => {
  const peer = join(root, 'peer-obj');
  await mkdir(join(peer, '_tests'), { recursive: true });
  await symlink(join(root, 'absent-target'), join(peer, '_tests/dangling'));
  await rm(join(engine, obj), { recursive: true });
  await symlink(peer, join(engine, obj));
  await expect(pruneDanglingTestLinks(engine, obj)).rejects.toThrow(/outside its local/);
  expect(await readlink(join(peer, '_tests/dangling'))).toBe(join(root, 'absent-target'));
});

describe('cloned objdir relocation', () => {
  it('repairs links and dependency inputs before configure and never touches primary config values', async () => {
    const old = join(root, 'primary/engine');
    const primaryValue = join(old, obj, 'config.statusd/substs/CXX');
    await put(primaryValue, '"clang"');
    await put(join(engine, 'chrome.js'), 'clone chrome');
    await mkdir(join(engine, obj, 'dist/bin'), { recursive: true });
    await symlink(join(old, 'chrome.js'), join(engine, obj, 'dist/bin/chrome.js'));
    await put(
      join(engine, obj, 'config.statusd/substs/config.track'),
      JSON.stringify([primaryValue])
    );
    await put(join(engine, obj, 'config.statusd/defines/config.track'), primaryValue);
    const metadata = [
      'widget.pp',
      '.deps/widget.d',
      'faster/install.json',
      'target/.fingerprint/build.json',
    ];
    for (const path of metadata) await put(join(engine, obj, path), old + '/browser/chrome.js');
    await put(
      join(engine, obj, 'mozinfo.json'),
      JSON.stringify({ topsrcdir: old, topobjdir: join(old, obj) })
    );
    const result = await attemptMozinfoRewrite(engine, obj);
    expect(result.rewritten).toBe(true);
    expect(await readlink(join(engine, obj, 'dist/bin/chrome.js'))).toBe(join(engine, 'chrome.js'));
    for (const path of metadata)
      expect(await readFile(join(engine, obj, path), 'utf8')).toBe(engine + '/browser/chrome.js');
    await expect(
      readFile(join(engine, obj, 'config.statusd/substs/config.track'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(primaryValue, 'utf8')).toBe('"clang"');
    await put(join(engine, obj, 'config.status'), 'local config');
    expect(
      await findObjdirRelocationViolation({ engineDir: engine, objDir: obj, forbiddenDir: old })
    ).toBeUndefined();
  });

  it('refuses a symlinked objdir without rewriting primary metadata', async () => {
    const shared = join(root, 'primary-obj');
    await mkdir(shared);
    await rm(join(engine, obj), { recursive: true });
    await symlink(shared, join(engine, obj));
    await expect(assertLocalObjdir(engine, obj)).rejects.toThrow(/outside its local/);
    await expect(relocateObjdirProducts(engine, obj, '/old/engine')).rejects.toThrow(/Refusing/);
  });

  it('refuses partial-config directory aliases before touching the peer', async () => {
    const peer = join(root, 'peer/config.statusd');
    await put(join(peer, 'substs/config.track'), 'peer tracking inventory');
    await symlink(peer, join(engine, obj, 'config.statusd'));
    await expect(relocateObjdirProducts(engine, obj, '/old/engine')).rejects.toThrow(/aliased/);
    expect(await readFile(join(peer, 'substs/config.track'), 'utf8')).toBe(
      'peer tracking inventory'
    );
  });

  it('unlinks copied config.track symlinks without writing through them', async () => {
    const peerTrack = join(root, 'peer-track');
    await put(peerTrack, 'peer tracking inventory');
    await mkdir(join(engine, obj, 'config.statusd/substs'), { recursive: true });
    await symlink(peerTrack, join(engine, obj, 'config.statusd/substs/config.track'));
    await relocateObjdirProducts(engine, obj, '/old/engine');
    await expect(
      readlink(join(engine, obj, 'config.statusd/substs/config.track'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(peerTrack, 'utf8')).toBe('peer tracking inventory');
  });

  it('detects stale links, including a directory alias which traversal must not follow', async () => {
    const old = join(root, 'primary');
    await mkdir(old);
    await put(join(old, 'preserve'), 'primary');
    await symlink(old, join(engine, obj, 'external-dir'));
    expect(await findStaleObjdirLink(engine, obj, old)).toContain('external-dir');
    await relocateObjdirProducts(engine, obj, old);
    expect(await readFile(join(old, 'preserve'), 'utf8')).toBe('primary');
  });

  it('prunes only missing _tests links and leaves live files and linked directories alone', async () => {
    const tests = join(engine, obj, '_tests');
    await mkdir(tests);
    await put(join(engine, 'live.js'), 'live');
    await put(join(tests, 'regular.js'), 'regular');
    await symlink(join(engine, 'missing.js'), join(tests, 'missing.js'));
    await symlink(join(engine, 'live.js'), join(tests, 'live.js'));
    await symlink(root, join(tests, 'linked-dir'));
    expect(await pruneDanglingTestLinks(engine, obj)).toBe(1);
    expect(await readFile(join(tests, 'live.js'), 'utf8')).toBe('live');
    expect(await readFile(join(tests, 'regular.js'), 'utf8')).toBe('regular');
    expect(await readlink(join(tests, 'linked-dir'))).toBe(root);
    expect(await pruneDanglingTestLinks(engine, 'obj-missing')).toBe(0);
  });

  it('names the configure repair for all-null partial config and accepts healthy or absent groups', async () => {
    await assertHealthyPartialConfig(engine, obj);
    const dir = join(engine, obj, 'config.statusd/substs');
    await put(join(dir, 'config.track'), 'tracking metadata');
    await put(join(dir, 'CXX'), 'null\n');
    await put(join(dir, 'CARGO'), 'null');
    await expect(assertHealthyPartialConfig(engine, obj)).rejects.toThrow(
      /python3 \.\/mach configure/
    );
    await put(join(dir, 'CXX'), '"clang"');
    await assertHealthyPartialConfig(engine, obj);
  });
});
