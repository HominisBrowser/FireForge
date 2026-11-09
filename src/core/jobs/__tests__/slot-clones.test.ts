// SPDX-License-Identifier: EUPL-1.2
/** Slots as clones: real templates, real `cp`, real Git, real locks. */
import { execFileSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { sourceFixture, writeAt } from '../../authored/__tests__/fixtures.js';
import { captureAuthoredSnapshot } from '../../authored/index.js';
import type { AuthoredSnapshot } from '../../authored/types.js';
import { initializeCoordinator, submitJob, waitForJob } from '../client.js';
import { readDetachedRecord, recordDetached } from '../slot-detached.js';
import { createSlot, removeSlot, restoreSlot } from '../slot-lifecycle.js';
import { finishTrash, moveToTrash, readTemplate } from '../slot-template.js';
import { acquireSlot, auditSlot, prepareSlot, readSlot, SlotBusyError } from '../slots.js';
import { readJson, slotDirectory, writeDurable } from '../store.js';
import { LocalSupervisor } from '../supervisor.js';
import { FIXTURE_MEMORY_GIB } from './host-fixture.js';

// Real processes and real clones, beside whatever else the suite is running.
vi.setConfig({ testTimeout: 180_000 });

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    execFileSync('chmod', ['-R', 'u+rwX', directory]);
    await rm(directory, { recursive: true, force: true });
  }
});

interface Provisioned extends Awaited<ReturnType<typeof sourceFixture>> {
  namespace: string;
  snapshot: AuthoredSnapshot;
}

async function provisioned(): Promise<Provisioned> {
  const value = await sourceFixture();
  directories.push(dirname(value.root));
  const namespace = join(dirname(value.root), 'coordinator');
  await initializeCoordinator(namespace, {
    idleMs: 60_000,
    legacyExcluded: true,
    memory: FIXTURE_MEMORY_GIB,
  });
  const snapshot = await captureAuthoredSnapshot({
    projectRoot: value.root,
    pristineRepository: value.pristine,
  });
  return { ...value, namespace, snapshot };
}

const create = (f: Provisioned, id: string, from?: string): ReturnType<typeof createSlot> =>
  createSlot({
    namespace: f.namespace,
    id,
    snapshot: f.snapshot,
    pristineRepository: f.pristine,
    ...(from === undefined ? {} : { from }),
  });

const indexEntries = (engine: string): string =>
  execFileSync('git', ['-C', engine, 'ls-files', '--debug'], { encoding: 'utf8' });

describe('a slot from the pin’s template', () => {
  it('exports the pin once and clones it for every slot, needing no donor after the first', async () => {
    const f = await provisioned();
    const a = await create(f, 'a');
    const template = await readTemplate(f.namespace, f.commit);
    expect(template).toBeDefined();
    const before = (await lstat(join(template?.engine ?? '', 'browser/manifest.txt'))).mtimeMs;
    const b = await createSlot({ namespace: f.namespace, id: 'b', snapshot: f.snapshot });
    expect(await readdir(join(f.namespace, 'templates'))).toEqual(
      expect.arrayContaining([f.commit])
    );
    for (const slot of [a, b])
      expect(await readFile(join(slot.root, 'engine/browser/manifest.txt'), 'utf8')).toContain(
        'first'
      );
    expect((await lstat(join(b.root, 'engine/browser/manifest.txt'))).mtimeMs).toBe(before);
    await auditSlot(f.namespace, a);
    await auditSlot(f.namespace, b);
  });

  it('refuses a first slot on a pin with neither template nor donor, naming the fix', async () => {
    const f = await provisioned();
    await expect(
      createSlot({ namespace: f.namespace, id: 'a', snapshot: f.snapshot })
    ).rejects.toThrow(/no slot template/);
  });

  it('leaves an index with stat data, so the first audit does not rehash the tree', async () => {
    const f = await provisioned();
    const slot = await create(f, 'a');
    const engine = join(slot.root, 'engine');
    expect(indexEntries(engine)).not.toMatch(/size: 0\b/);
    expect(
      execFileSync('git', ['-C', engine, 'config', 'core.checkStat'], { encoding: 'utf8' }).trim()
    ).toBe('minimal');
    // A clone's every inode and ctime differ, and still nothing reads as modified.
    expect(execFileSync('git', ['-C', engine, 'diff-files', '--quiet'], { encoding: 'utf8' })).toBe(
      ''
    );
    await writeFile(join(engine, 'browser/manifest.txt'), 'first\nsecond\nthird\nfourth\nFIFTH\n');
    await expect(auditSlot(f.namespace, slot)).rejects.toThrow(/Undeclared engine drift/);
  });

  it('takes the slot’s own lock, so a peer’s job keeps running while a slot is created', async () => {
    const f = await provisioned();
    await create(f, 'a');
    const supervisor = await LocalSupervisor.start(f.namespace);
    try {
      const creation = create(f, 'b');
      const job = await submitJob(
        f.namespace,
        {
          schemaVersion: 1,
          key: 'peer',
          slot: 'a',
          sourceId: f.snapshot.id,
          steps: [{ command: 'status', args: [] }],
          quiet: false,
        },
        f.snapshot
      );
      await creation;
      expect((await waitForJob(f.namespace, job.id, 90_000)).state).toBe('passed');
      expect((await readSlot(f.namespace, 'b')).quarantined).toBeNull();
    } finally {
      await supervisor.close();
    }
  }, 180_000);
});

describe('slot create --from a built slot', () => {
  /** A slot with real source and objects whose mtimes are in the order a build leaves them. */
  async function built(f: Provisioned): Promise<void> {
    const slot = await create(f, 'a');
    const engine = join(slot.root, 'engine');
    const obj = join(engine, 'obj-fake');
    await mkdir(join(obj, 'dist/bin'), { recursive: true });
    await mkdir(join(obj, 'tmp'), { recursive: true });
    await writeFile(join(obj, 'dist/bin/libxul.dylib'), 'object bytes');
    await writeFile(join(obj, 'tmp/scratch'), 'scratch');
    await writeFile(join(obj, 'config.status'), `topsrcdir=${engine}\n`);
    await symlink(join(engine, 'browser/manifest.txt'), join(obj, 'dist/bin/manifest.txt'));
    await symlink('/opt/somewhere-outside/libonnxruntime.dylib', join(obj, 'dist/bin/onnx.dylib'));
    await writeDurable(join(slot.root, '.fireforge', 'last-build.json'), { built: true });
    const record = await readSlot(f.namespace, 'a');
    record.successfulBuildGeneration = 1;
    record.fullBuildAnchor = {
      digest: 'compiled',
      baselineDigest: 'baseline',
      sourceId: record.sourceId,
      buildGeneration: 1,
    };
    record.objdirToolsDigest = 'tools';
    record.trustedBuild = {
      sourceId: record.sourceId,
      materializationDigest: 'm',
      successfulBuildGeneration: 1,
      baselineDigest: 'baseline',
      slotGeneration: record.generation,
    };
    await writeDurable(join(slotDirectory(f.namespace, 'a'), 'slot.json'), record);
  }

  it('carries source and objects together, keeping their mtimes in the order the build left them', async () => {
    const f = await provisioned();
    await built(f);
    const source = await readSlot(f.namespace, 'a');
    await recordDetached(f.namespace, 'a', 'job-1', [{ pid: 7001, group: 7001, start: 's' }]);
    const clone = await create(f, 'b', 'a');
    // What a phase left detached was left in a's name, not b's.
    expect(await readDetachedRecord(f.namespace, 'b')).toEqual([]);
    const [from, to] = [source, clone].map((slot) => join(slot.root, 'engine'));
    for (const path of ['browser/manifest.txt', 'obj-fake/dist/bin/libxul.dylib']) {
      expect((await lstat(join(to ?? '', path))).mtimeMs).toBe(
        (await lstat(join(from ?? '', path))).mtimeMs
      );
    }
    expect(await readFile(join(to ?? '', 'obj-fake/dist/bin/libxul.dylib'), 'utf8')).toBe(
      'object bytes'
    );
    await expect(lstat(join(to ?? '', 'obj-fake/tmp'))).rejects.toThrow(/ENOENT/);
    // A link out of the tree, as a real objdir's onnxruntime is, survives the clone.
    expect(await readlink(join(to ?? '', 'obj-fake/dist/bin/onnx.dylib'))).toBe(
      '/opt/somewhere-outside/libonnxruntime.dylib'
    );
    expect(await readFile(join(clone.root, '.fireforge', 'last-build.json'), 'utf8')).toContain(
      'built'
    );
    expect(
      await realpath(
        execFileSync('git', ['-C', to ?? '', 'rev-parse', '--git-dir'], { encoding: 'utf8' }).trim()
      )
    ).toBe(await realpath(join(slotDirectory(f.namespace, 'b'), 'engine.git')));
    await auditSlot(f.namespace, await readSlot(f.namespace, 'b'));
  });

  it('drops the anchor when no toolchain vouches for it, keeps its objects, and needs a build either way', async () => {
    const f = await provisioned();
    await built(f);
    const clone = await create(f, 'b', 'a');
    expect(clone.fullBuildAnchor).toBeUndefined();
    expect(clone.requiresFullBuild).toBe(true);
    expect(clone.requiresBuild).toBe(true);
    expect(clone.trustedBuild).toBeUndefined();
    expect(clone.objdirToolsDigest).toBe('tools');
  });

  it('applies only what differs when it clones onto another source', async () => {
    const f = await provisioned();
    await built(f);
    const source = await readSlot(f.namespace, 'a');
    await writeAt(f.root, 'src/browser/other.js', 'export const other = 2;\n');
    const next = await captureAuthoredSnapshot({
      projectRoot: f.root,
      pristineRepository: f.pristine,
    });
    const clone = await createSlot({
      namespace: f.namespace,
      id: 'b',
      snapshot: next,
      from: 'a',
    });
    const engine = join(clone.root, 'engine');
    expect(await readFile(join(engine, 'browser/other.js'), 'utf8')).toContain('other');
    expect((await lstat(join(engine, 'browser/manifest.txt'))).mtimeMs).toBe(
      (await lstat(join(source.root, 'engine/browser/manifest.txt'))).mtimeMs
    );
    expect(clone.sourceId).toBe(next.id);
    await auditSlot(f.namespace, await readSlot(f.namespace, 'b'));
  });

  it('refuses a source slot that is in use or quarantined, and audits it first', async () => {
    const f = await provisioned();
    await built(f);
    const release = await acquireSlot(f.namespace, 'a', { jobId: 'busy' });
    await expect(create(f, 'b', 'a')).rejects.toBeInstanceOf(Error);
    await release();
    const source = await readSlot(f.namespace, 'a');
    await writeFile(join(source.root, 'engine/stray.txt'), 'drift');
    await expect(create(f, 'c', 'a')).rejects.toThrow(/Undeclared engine drift/);
    await rm(join(source.root, 'engine/stray.txt'));
    source.quarantined = 'reason';
    await writeDurable(join(slotDirectory(f.namespace, 'a'), 'slot.json'), source);
    await expect(create(f, 'd', 'a')).rejects.toThrow(/quarantined/);
  });
});

describe('removing a slot', () => {
  /** Freezes part of a slot the way qualification freezes its Mach sites. */
  async function qualifiedLayout(root: string): Promise<void> {
    const site = join(root, '.fireforge/native-state/srcdirs/engine-x/_virtualenvs/build/bin');
    await mkdir(site, { recursive: true });
    await writeFile(join(site, 'python'), '#!/bin/sh\n');
    await chmod(join(site, 'python'), 0o555);
    await chmod(site, 0o555);
    await chmod(dirname(site), 0o555);
  }

  it('removes a qualified slot and frees its name, keeping the template', async () => {
    const f = await provisioned();
    const slot = await create(f, 'a');
    await qualifiedLayout(slot.root);
    await expect(removeSlot(f.namespace, 'a')).resolves.toEqual({ removed: 'a' });
    await expect(readSlot(f.namespace, 'a')).rejects.toThrow(/does not exist/);
    expect(await readTemplate(f.namespace, f.commit)).toBeDefined();
    expect(await readdir(join(f.namespace, 'trash'))).toEqual([]);
    await createSlot({ namespace: f.namespace, id: 'a', snapshot: f.snapshot });
  });

  it('finishes after a crash at any step: the rename already freed the name', async () => {
    const f = await provisioned();
    const slot = await create(f, 'a');
    await qualifiedLayout(slot.root);
    // The process died right after moving the directory out of its name.
    await moveToTrash(f.namespace, slotDirectory(f.namespace, 'a'), 'a');
    expect(await readdir(join(f.namespace, 'trash'))).toHaveLength(1);
    await expect(removeSlot(f.namespace, 'a')).resolves.toEqual({ removed: 'a' });
    expect(await readdir(join(f.namespace, 'trash'))).toEqual([]);
    // And any other entry point finishes one too.
    const second = await create(f, 'b');
    await qualifiedLayout(second.root);
    await moveToTrash(f.namespace, slotDirectory(f.namespace, 'b'), 'b');
    await expect(finishTrash(f.namespace)).resolves.toEqual(['b']);
  });

  it('refuses a slot a job holds, leaving it intact', async () => {
    const f = await provisioned();
    await create(f, 'a');
    const release = await acquireSlot(f.namespace, 'a', { jobId: 'job' });
    await expect(removeSlot(f.namespace, 'a')).rejects.toBeInstanceOf(SlotBusyError);
    await release();
    await readSlot(f.namespace, 'a');
  });

  it('refuses a slot with a process inside it', async () => {
    const f = await provisioned();
    const slot = await create(f, 'a');
    const { spawn } = await import('node:child_process');
    const inside = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], {
      cwd: join(slot.root, 'engine'),
      stdio: 'ignore',
    });
    try {
      await new Promise((settle) => setTimeout(settle, 300));
      await expect(removeSlot(f.namespace, 'a')).rejects.toThrow(/in use by process/);
    } finally {
      inside.kill('SIGKILL');
    }
  });
});

describe('names', () => {
  it('a mistyped name leaves nothing behind', async () => {
    const f = await provisioned();
    await create(f, 'a');
    await expect(acquireSlot(f.namespace, 'typo')).rejects.toThrow(/does not exist/);
    await expect(removeSlot(f.namespace, 'typo')).rejects.toThrow(/does not exist/);
    await expect(restoreSlot(f.namespace, 'typo')).rejects.toThrow(/does not exist/);
    expect(await readdir(join(f.namespace, 'slots'))).toEqual(['a']);
  });

  it('a failed provisioning gives its name back, with no diagnostics to clean up by hand', async () => {
    const f = await provisioned();
    await expect(
      createSlot({
        namespace: f.namespace,
        id: 'a',
        snapshot: f.snapshot,
        pristineRepository: f.pristine,
        caches: [{ source: join(f.root, 'missing'), target: 'node_modules' }],
      })
    ).rejects.toThrow();
    expect(
      await readJson<{ error: string }>(
        join(slotDirectory(f.namespace, 'a'), 'creation-failed.json')
      )
    ).toMatchObject({ error: expect.stringContaining('ENOENT') as string });
    await create(f, 'a');
    await auditSlot(f.namespace, await readSlot(f.namespace, 'a'));
  });

  it('an interrupted provisioning gives its name back once its owner has exited, and not before', async () => {
    const f = await provisioned();
    const directory = slotDirectory(f.namespace, 'a');
    await mkdir(directory, { recursive: true });
    await writeDurable(join(directory, 'provisioning.json'), {
      owner: { pid: 999_999, start: 'gone' },
    });
    await writeFile(join(directory, 'partial'), 'left by a crash');
    await create(f, 'a');
    await auditSlot(f.namespace, await readSlot(f.namespace, 'a'));
    const live = slotDirectory(f.namespace, 'b');
    await mkdir(live, { recursive: true });
    const { processIdentityAsync } = await import('../process.js');
    await writeDurable(join(live, 'provisioning.json'), {
      owner: await processIdentityAsync(process.pid),
    });
    await expect(create(f, 'b')).rejects.toThrow(/still being provisioned/);
  });

  it('prepares from a clone’s index the same as any slot', async () => {
    const f = await provisioned();
    const slot = await create(f, 'a');
    await writeAt(f.root, 'src/browser/other.js', 'export const other = 2;\n');
    const next = await captureAuthoredSnapshot({
      projectRoot: f.root,
      pristineRepository: f.pristine,
    });
    const release = await acquireSlot(f.namespace, 'a');
    try {
      await prepareSlot(f.namespace, slot, next);
    } finally {
      await release();
    }
    await auditSlot(f.namespace, await readSlot(f.namespace, 'a'));
  });
});

describe('what the audit can see', () => {
  it('a stray file an ignore rule hides is drift, and restore takes it away', async () => {
    const f = await provisioned();
    const slot = await create(f, 'a');
    const engine = join(slot.root, 'engine');
    await writeFile(join(engine, '.mozconfig'), 'ac_add_options --enable-foreign\n');
    await expect(auditSlot(f.namespace, slot)).rejects.toThrow(
      /Undeclared engine drift: \.mozconfig/
    );
    const record = await readSlot(f.namespace, 'a');
    record.quarantined = 'stray';
    await writeDurable(join(slotDirectory(f.namespace, 'a'), 'slot.json'), record);
    await recordDetached(f.namespace, 'a', 'job-1', [{ pid: 7001, group: 7001, start: 's' }]);
    await restoreSlot(f.namespace, 'a');
    await expect(lstat(join(engine, '.mozconfig'))).rejects.toThrow(/ENOENT/);
    expect(await readDetachedRecord(f.namespace, 'a')).toEqual([]);
  });

  it('object directories and Python caches a build leaves are not drift', async () => {
    const f = await provisioned();
    const slot = await create(f, 'a');
    const engine = join(slot.root, 'engine');
    await mkdir(join(engine, 'obj-fake'), { recursive: true });
    await writeFile(join(engine, 'obj-fake/object.o'), 'object');
    await mkdir(join(engine, 'browser/__pycache__'), { recursive: true });
    await writeFile(join(engine, '.gitignore'), '__pycache__/\n');
    await rm(join(engine, '.gitignore'));
    await auditSlot(f.namespace, slot);
  });

  it('a user’s global ignore file and fsmonitor have no say', async () => {
    const f = await provisioned();
    const slot = await create(f, 'a');
    const home = join(dirname(f.root), 'home');
    await writeAt(home, 'global-ignore', '*.stray\n');
    await writeAt(
      home,
      '.gitconfig',
      `[core]\n  excludesFile = ${join(home, 'global-ignore')}\n  fsmonitor = true\n`
    );
    vi.stubEnv('HOME', home);
    vi.stubEnv('XDG_CONFIG_HOME', home);
    vi.stubEnv('GIT_CONFIG_GLOBAL', join(home, '.gitconfig'));
    await writeFile(join(slot.root, 'engine/hidden.stray'), 'drift');
    await expect(auditSlot(f.namespace, slot)).rejects.toThrow(/hidden\.stray/);
    vi.unstubAllEnvs();
  });
});
