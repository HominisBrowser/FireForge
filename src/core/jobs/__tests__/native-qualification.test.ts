// SPDX-License-Identifier: EUPL-1.2
/** Qualification as what it is, an ordinary owned job, on real slots with a fake mach. */
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { ExitCode } from '../../../errors/codes.js';
import type { AuthoredSnapshot } from '../../authored/types.js';
import {
  NATIVE_PROBE,
  nativeRecipeDigest,
  nativeRuntimePath,
  type NativeRuntimeRecord,
  nativeSiteParent,
  nativeStateRoot,
  verifyQualifiedSites,
} from '../native-state.js';
import { nativeToolEnvironment, readHostToolchain } from '../native-tools.js';
import type { SlotRecord } from '../slot-types.js';
import { readJson, slotDirectory } from '../store.js';
import { type HostFixture, hostFixture, removeHostFixture } from './host-fixture.js';

const fixtures: HostFixture[] = [];
// Every test has its own host, so they run side by side.
afterAll(async () => {
  await Promise.all(fixtures.splice(0).map(removeHostFixture));
}, 120_000);

interface Qualified {
  f: HostFixture;
  slot: SlotRecord;
  snapshot: AuthoredSnapshot;
  record: NativeRuntimeRecord;
}

async function qualified(): Promise<Qualified> {
  const f = await hostFixture();
  fixtures.push(f);
  const init = await f.cli(f.project, ['host', 'init', '--from-engine', f.donor]);
  expect(init.code, init.stdout + init.stderr).toBe(0);
  const directory = slotDirectory(f.namespace, 'a');
  const slot = await readJson<SlotRecord>(join(directory, 'slot.json'));
  return {
    f,
    slot,
    snapshot: await readJson<AuthoredSnapshot>(join(directory, 'snapshot.json')),
    record: await readJson<NativeRuntimeRecord>(nativeRuntimePath(slot.root)),
  };
}

const verify = async (q: Qualified, options: { full?: boolean } = {}): Promise<unknown> =>
  verifyQualifiedSites(q.snapshot, await readHostToolchain(q.f.namespace), q.slot.root, options);

describe.concurrent('a qualified slot', () => {
  it('provisions its sites at the final path, freezes them, and leaves Mach’s locks writable', async () => {
    const q = await qualified();
    expect(q.record.sites.map((site) => site.name)).toEqual(['build', 'common', 'mach']);
    const parent = await nativeSiteParent(q.slot.root);
    for (const name of ['build', 'common', 'mach'])
      expect((await lstat(join(parent, name, 'bin'))).mode & 0o222).toBe(0);
    await verify(q);
    await verify(q, { full: true });
    // A warm job's Mach writes its sibling locks and private caches, which changes nothing.
    const manifest = await readHostToolchain(q.f.namespace);
    await promisify(execFile)(
      manifest.python.executable,
      [
        '-B',
        join(q.slot.root, 'engine', 'mach'),
        'python',
        '--virtualenv',
        'common',
        '-c',
        NATIVE_PROBE,
      ],
      {
        cwd: join(q.slot.root, 'engine'),
        env: { ...process.env, ...nativeToolEnvironment(manifest, q.slot.root) },
      }
    );
    await writeFile(join(nativeStateRoot(q.slot.root), 'private-cache.json'), 'mutable');
    await verify(q);
    await verify(q, { full: true });
  }, 120_000);

  it('requalifying with unchanged tools keeps the record, so nothing clobbers', async () => {
    const q = await qualified();
    const again = await q.f.cli(q.f.project, ['slot', 'qualify-native', 'a']);
    expect(again.code, again.stdout + again.stderr).toBe(0);
    const next = await readJson<NativeRuntimeRecord>(nativeRuntimePath(q.slot.root));
    expect(next.qualifiedAt).toBe(q.record.qualifiedAt);
    expect(JSON.stringify(next)).not.toMatch(/sourceId|sourceGeneration|executorDigest/);
    const slot = await readJson<SlotRecord>(join(slotDirectory(q.f.namespace, 'a'), 'slot.json'));
    expect(slot.requiresToolchainClean).toBeUndefined();
  }, 120_000);

  it('a UI edit keeps the recipe; a Mach or Python edit asks for requalification, by name', async () => {
    const q = await qualified();
    const ui = {
      ...q.snapshot,
      files: [{ path: 'browser/ui.js', kind: 'created', blob: 'ui', mode: '100644' }],
    } as AuthoredSnapshot;
    expect(nativeRecipeDigest(ui)).toBe(nativeRecipeDigest(q.snapshot));
    const manifest = await readHostToolchain(q.f.namespace);
    await verifyQualifiedSites(ui, manifest, q.slot.root);
    const recipe = {
      ...q.snapshot,
      files: [{ path: 'python/sites/common.txt', kind: 'override', blob: 'x', mode: '100644' }],
    } as AuthoredSnapshot;
    await expect(verifyQualifiedSites(recipe, manifest, q.slot.root)).rejects.toThrow(
      /slot qualify-native a/
    );
    await expect(
      verifyQualifiedSites(q.snapshot, { ...manifest, digest: 'other' }, q.slot.root)
    ).rejects.toThrow(/toolchain changed/);
  }, 120_000);

  it('a job notices changed site bytes by stat; only a full read notices ones that hid their mtime', async () => {
    const q = await qualified();
    const parent = await nativeSiteParent(q.slot.root);
    const binary = join(parent, 'common', 'bin', 'python');
    const before = await lstat(binary);
    await chmod(join(parent, 'common', 'bin'), 0o755);
    await chmod(binary, 0o755);
    const bytes = await readFile(binary, 'utf8');
    await writeFile(binary, bytes.replace('FIREFORGE_NATIVE_PROBE', 'FIREFORGE_NATIVE_PROBX'));
    await chmod(binary, 0o555);
    await chmod(join(parent, 'common', 'bin'), 0o555);
    expect(before.size).toBe((await lstat(binary)).size);
    await expect(verify(q)).rejects.toThrow(/bytes changed/);
  }, 120_000);

  it('refuses a site nobody qualified and ambient Mach configuration', async () => {
    const q = await qualified();
    const parent = await nativeSiteParent(q.slot.root);
    await mkdir(join(parent, 'foreign'));
    await expect(verify(q)).rejects.toThrow(/Unexpected/);
    await rm(join(parent, 'foreign'), { recursive: true });
    await writeFile(join(nativeStateRoot(q.slot.root), 'machrc'), 'foreign-config');
    await expect(verify(q)).rejects.toThrow(/ambient Mach/);
    await rm(join(nativeStateRoot(q.slot.root), 'machrc'));
  }, 120_000);

  it('refuses to run from a state directory aliased to another checkout', async () => {
    const q = await qualified();
    const state = nativeStateRoot(q.slot.root);
    const moved = `${state}-moved`;
    await promisify(execFile)('mv', [state, moved]);
    await symlink(moved, state);
    await expect(verify(q)).rejects.toThrow(/alias/);
  }, 120_000);
});

describe.concurrent('a qualification that does not finish', () => {
  it('publishes nothing when Mach cannot provision a site, and costs the slot nothing', async () => {
    const f = await hostFixture({ mach: 'raise RuntimeError("fixture install failed")\n' });
    fixtures.push(f);
    const init = await f.cli(f.project, ['host', 'init', '--from-engine', f.donor]);
    expect(init.code).toBe(ExitCode.GENERAL_ERROR);
    expect(init.stdout).toMatch(/failed slot=a/);
    const slot = await readJson<SlotRecord>(join(slotDirectory(f.namespace, 'a'), 'slot.json'));
    await expect(readFile(nativeRuntimePath(slot.root))).rejects.toThrow(/ENOENT/);
    expect(slot.quarantined).toBeNull();
    const job = await f.cli(f.project, ['job', 'run', '--build', 'full']);
    expect(job.code).toBe(ExitCode.JOB_FAILED);
    expect(job.stdout).toMatch(/not qualified; run: fireforge slot qualify-native a/);
  }, 180_000);

  it('a cancel stops the installer through its phase, and leaves no qualification', async () => {
    const f = await hostFixture({
      mach: 'import time\nprint("installing", flush=True)\ntime.sleep(120)\n',
    });
    fixtures.push(f);
    const init = f.cli(f.project, ['host', 'init', '--from-engine', f.donor]);
    let id: string | undefined;
    for (let attempt = 0; attempt < 600 && id === undefined; attempt += 1) {
      await new Promise((settle) => setTimeout(settle, 100));
      const names = await readdir(join(f.namespace, 'logs')).catch(() => [] as string[]);
      for (const name of names) {
        const log = await readFile(join(f.namespace, 'logs', name), 'utf8');
        if (log.includes('installing')) id = name.replace(/\.log$/, '');
      }
    }
    expect(id).toBeDefined();
    const started = Date.now();
    await f.cli(f.project, ['job', 'cancel', id ?? '']);
    const finished = await init;
    expect(finished.code).toBe(ExitCode.GENERAL_ERROR);
    expect(finished.stdout).toMatch(/cancelled slot=a/);
    expect(Date.now() - started).toBeLessThan(60_000);
    const slot = await readJson<SlotRecord>(join(slotDirectory(f.namespace, 'a'), 'slot.json'));
    await expect(readFile(nativeRuntimePath(slot.root))).rejects.toThrow(/ENOENT/);
  }, 180_000);
});

// Runs after the concurrent suites: the environment it changes is one every test above reads.
describe('an ambient Mach environment', () => {
  it('refuses an inherited workspace variable', async () => {
    const q = await qualified();
    vi.stubEnv('WORKSPACE', '/foreign');
    try {
      await expect(verify(q)).rejects.toThrow(/WORKSPACE/);
    } finally {
      vi.unstubAllEnvs();
    }
  }, 120_000);
});
