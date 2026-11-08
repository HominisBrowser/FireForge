// SPDX-License-Identifier: EUPL-1.2
/**
 * A qualification's phase body, in this process, against a real slot and a fake mach.
 * Normally it runs inside an executor, where coverage cannot see it; the supervised
 * path is `native-qualification.test.ts`. Only the phase's own authorization is stubbed.
 */
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AuthoredSnapshot } from '../../authored/types.js';
import { readAdmittedSnapshot } from '../guard.js';
import { runQualificationPhase } from '../native-qualify.js';
import {
  nativeRuntimePath,
  type NativeRuntimeRecord,
  nativeSiteParent,
  verifyQualifiedSites,
} from '../native-state.js';
import { nativeToolEnvironment, readHostToolchain } from '../native-tools.js';
import type { SlotRecord } from '../slot-types.js';
import { slotDirectory } from '../store.js';
import { readJson } from '../store.js';
import { type HostFixture, hostFixture, removeHostFixture } from './host-fixture.js';

vi.mock('../guard.js', async (original) => ({
  ...(await original<typeof import('../guard.js')>()),
  readAdmittedSnapshot: vi.fn(),
}));
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let f: HostFixture;
let slot: SlotRecord;
let snapshot: AuthoredSnapshot;

beforeAll(async () => {
  f = await hostFixture({
    config: {
      build: { release: { overlay: 'configs/release.mozconfig', outputs: ['dist/*.dmg'] } },
    },
    projectFiles: { 'configs/release.mozconfig': 'ac_add_options --enable-updater\n' },
  });
  const init = await f.cli(f.project, ['host', 'init', '--from-engine', f.donor]);
  expect(init.code, init.stdout + init.stderr).toBe(0);
  const directory = slotDirectory(f.namespace, 'a');
  slot = await readJson<SlotRecord>(join(directory, 'slot.json'));
  snapshot = await readJson<AuthoredSnapshot>(join(directory, 'snapshot.json'));
  vi.mocked(readAdmittedSnapshot).mockResolvedValue({ snapshot, slot } as never);
  vi.stubEnv('FIREFORGE_COORDINATOR', f.namespace);
  vi.stubEnv('FIREFORGE_TOOLCHAINS', f.toolchains);
  const manifest = await readHostToolchain(f.namespace);
  for (const [key, value] of Object.entries(nativeToolEnvironment(manifest, slot.root)))
    vi.stubEnv(key, value);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await removeHostFixture(f);
});

describe('the body of a qualify-native phase', () => {
  it('changes nothing when the slot is already qualified', async () => {
    const path = nativeRuntimePath(slot.root);
    const before = await readFile(path, 'utf8');
    await runQualificationPhase(slot.root);
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('provisions and measures again from nothing, and records what it found', async () => {
    const path = nativeRuntimePath(slot.root);
    const before = await readJson<{ sites: Array<{ name: string }>; toolchainDigest: string }>(
      path
    );
    await rm(path);
    await runQualificationPhase(slot.root);
    const after = await readJson<typeof before>(path);
    expect(after.toolchainDigest).toBe(before.toolchainDigest);
    expect(after.sites.map((site) => site.name)).toEqual(before.sites.map((site) => site.name));
  });

  it('qualifies the taskgraph site a release packages with, and replaces one a job made', async () => {
    const path = nativeRuntimePath(slot.root);
    const manifest = await readHostToolchain(f.namespace);
    const parent = await nativeSiteParent(slot.root);
    const record = await readJson<NativeRuntimeRecord>(path);
    expect(record.sites.map((site) => site.name)).toEqual(['build', 'common', 'mach', 'taskgraph']);
    await verifyQualifiedSites(snapshot, manifest, slot.root, { full: true });
    // A slot that qualified before its source declared a release, where a packaging job then made the site.
    await writeFile(
      path,
      JSON.stringify({ ...record, sites: record.sites.filter((site) => site.name !== 'taskgraph') })
    );
    await expect(verifyQualifiedSites(snapshot, manifest, slot.root)).rejects.toThrow(
      /qualified the Mach sites build, common, mach and this source needs build, common, mach, taskgraph; run: fireforge slot qualify-native a/
    );
    await chmod(join(parent, 'taskgraph', 'bin'), 0o700);
    await writeFile(join(parent, 'taskgraph', 'bin', 'job-made'), 'unverified');
    await runQualificationPhase(slot.root);
    const requalified = await readJson<NativeRuntimeRecord>(path);
    expect(requalified.sites.map((site) => site.name)).toEqual([
      'build',
      'common',
      'mach',
      'taskgraph',
    ]);
    await expect(readFile(join(parent, 'taskgraph', 'bin', 'job-made'))).rejects.toThrow(/ENOENT/);
    await verifyQualifiedSites(snapshot, manifest, slot.root, { full: true });
    // A site nobody declared is never adopted, by a job or by a qualification.
    await mkdir(join(parent, 'foreign'));
    await expect(verifyQualifiedSites(snapshot, manifest, slot.root)).rejects.toThrow(
      /Unexpected\/unqualified Mach virtualenv site: foreign/
    );
    await rm(path);
    await expect(runQualificationPhase(slot.root)).rejects.toThrow(/Unexpected Mach site foreign/);
    await rm(join(parent, 'foreign'), { recursive: true });
    await runQualificationPhase(slot.root);
  });

  it('refuses a stale object directory it cannot relocate, and a configure that fails', async () => {
    const obj = join(slot.root, 'engine', 'obj-elsewhere');
    await mkdir(obj, { recursive: true });
    await writeFile(
      join(obj, 'mozinfo.json'),
      JSON.stringify({ topsrcdir: '/nowhere/engine', topobjdir: '/nowhere/engine/obj-elsewhere' })
    );
    await rm(nativeRuntimePath(slot.root));
    await expect(runQualificationPhase(slot.root)).rejects.toThrow(/relocate|Relocation/i);
    await rm(obj, { recursive: true });
  });
});
