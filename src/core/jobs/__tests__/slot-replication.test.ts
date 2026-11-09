// SPDX-License-Identifier: EUPL-1.2
/** Copying one slot's build into another: real templates, real clones, real Git, real locks. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { sourceFixture } from '../../authored/__tests__/fixtures.js';
import { captureAuthoredSnapshot } from '../../authored/index.js';
import type { AuthoredSnapshot } from '../../authored/types.js';
import { slotViews } from '../admission-context.js';
import { initializeCoordinator } from '../client.js';
import { displacedObjdirs } from '../native-qualify.js';
import { readDetachedRecord, recordDetached } from '../slot-detached.js';
import { createSlot } from '../slot-lifecycle.js';
import {
  abandonReplication,
  readReplicationMarker,
  replicateSlotBuild,
  ReplicationDeclined,
} from '../slot-replication.js';
import type { SlotRecord } from '../slot-types.js';
import { acquireSlot, auditSlot, readSlot } from '../slots.js';
import { readJson, slotDirectory, writeDurable } from '../store.js';
import { FIXTURE_MEMORY_GIB } from './host-fixture.js';

vi.mock('../native-tools.js', async (original) => ({
  ...(await original<typeof import('../native-tools.js')>()),
  readHostToolchain: vi.fn(() => Promise.resolve({})),
  nativeBuildDigest: vi.fn(() => 'tools'),
}));
vi.setConfig({ testTimeout: 180_000 });

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    execFileSync('chmod', ['-R', 'u+rwX', directory]);
    await rm(directory, { recursive: true, force: true });
  }
});

interface Pair {
  namespace: string;
  snapshot: AuthoredSnapshot;
  a: SlotRecord;
  b: SlotRecord;
}

const slotFile = (namespace: string, id: string): string =>
  join(slotDirectory(namespace, id), 'slot.json');

/** Two slots on one pin; `a` holds a full build of this host's tools and a generated root file. */
async function pair(): Promise<Pair> {
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
  const a = await createSlot({
    namespace,
    id: 'a',
    snapshot,
    pristineRepository: value.pristine,
  });
  const b = await createSlot({ namespace, id: 'b', snapshot });
  const engine = join(a.root, 'engine');
  const objdir = join(engine, 'obj-fixture');
  await mkdir(join(objdir, 'dist', 'bin'), { recursive: true });
  await mkdir(join(objdir, 'tmp'), { recursive: true });
  await writeFile(join(objdir, 'dist', 'bin', 'fixture'), 'binary');
  await writeFile(join(objdir, 'tmp', 'scratch'), 'scratch');
  await writeFile(
    join(objdir, 'mozinfo.json'),
    JSON.stringify({ topsrcdir: await realpath(engine), topobjdir: join(engine, 'obj-fixture') })
  );
  for (const root of [a.root, b.root]) await mkdir(join(root, '.fireforge'), { recursive: true });
  await writeFile(join(a.root, '.fireforge', 'last-build.json'), '{"from":"a"}');
  await writeFile(join(a.root, 'generated.txt'), 'generated');
  await writeDurable(join(slotDirectory(namespace, 'a'), 'derived.json'), {
    'generated.txt': {
      path: 'generated.txt',
      sha256: createHash('sha256').update('generated').digest('hex'),
      mode: '100644',
      sourceId: a.sourceId,
      generation: a.generation,
      phase: 'fixture',
      generatorVersion: '1',
    },
  });
  const built: SlotRecord = {
    ...a,
    successfulBuildGeneration: 1,
    requiresBuild: false,
    fullBuildAnchor: {
      digest: 'compiled',
      baselineDigest: 'baseline',
      sourceId: a.sourceId,
      buildGeneration: 1,
      nativeToolsDigest: 'tools',
    },
    trustedBuild: {
      sourceId: a.sourceId,
      materializationDigest: 'm',
      successfulBuildGeneration: 1,
      baselineDigest: 'baseline',
      slotGeneration: a.generation,
    },
    ...(a.storage === undefined ? {} : { storage: { ...a.storage, consumedBytes: 1 } }),
  };
  await writeDurable(slotFile(namespace, 'a'), built);
  // What b had: its own build, its own qualified sites, a few more generations.
  await mkdir(join(b.root, 'engine', 'obj-old'), { recursive: true });
  await writeFile(join(b.root, 'engine', 'obj-old', 'stale'), 'stale');
  await writeFile(join(b.root, '.fireforge', 'native-qualified.json'), '{"slot":"b"}');
  await writeDurable(slotFile(namespace, 'b'), { ...b, generation: 7 });
  return { namespace, snapshot, a: built, b: await readSlot(namespace, 'b') };
}

describe('replicating a slot’s build', () => {
  it('gives the destination the source’s build and source at its own paths', async () => {
    const { namespace, a, b } = await pair();
    const before = await readFile(slotFile(namespace, 'a'), 'utf8');
    await recordDetached(namespace, 'a', 'job-1', [{ pid: 7001, group: 7001, start: 's' }]);
    await replicateSlotBuild(namespace, 'a', 'b');
    // What a phase left detached stays with the slot it was left in.
    expect(await readDetachedRecord(namespace, 'b')).toEqual([]);
    expect(await readDetachedRecord(namespace, 'a')).toHaveLength(1);

    const replica = await readSlot(namespace, 'b');
    expect(replica).toMatchObject({
      id: 'b',
      root: b.root,
      pristineRepository: b.pristineRepository,
      sourceId: a.sourceId,
      quarantined: null,
      generation: 8,
      successfulBuildGeneration: 2,
      requiresBuild: true,
      fullBuildAnchor: { digest: 'compiled', nativeToolsDigest: 'tools', buildGeneration: 2 },
    });
    expect(replica.trustedBuild).toBeUndefined();
    expect(replica.storage?.consumedBytes).toBe(1);
    // Admission treats it as holding the build; its package waits for a build here.
    expect((await slotViews(namespace)).get('b')).toMatchObject({ anchorDigest: 'compiled' });
    expect((await slotViews(namespace)).get('b')?.packagedSource).toBeUndefined();

    const engine = join(b.root, 'engine');
    expect(await readFile(join(engine, 'obj-fixture', 'dist', 'bin', 'fixture'), 'utf8')).toBe(
      'binary'
    );
    expect((await readdir(engine)).filter((name) => name.startsWith('obj-'))).toEqual([
      'obj-fixture',
    ]);
    expect(await readdir(join(engine, 'obj-fixture'))).not.toContain('tmp');
    expect(await readFile(join(engine, '.git'), 'utf8')).toBe(`gitdir: ${b.pristineRepository}\n`);
    expect(await readFile(join(b.root, '.fireforge', 'last-build.json'), 'utf8')).toBe(
      '{"from":"a"}'
    );
    expect(await readFile(join(b.root, '.fireforge', 'native-qualified.json'), 'utf8')).toBe(
      '{"slot":"b"}'
    );
    expect(
      (
        await readJson<Record<string, { generation: number }>>(
          join(slotDirectory(namespace, 'b'), 'derived.json')
        )
      )['generated.txt']?.generation
    ).toBe(8);
    // The copied objects still name a's engine: qualification moves them.
    expect(await displacedObjdirs(engine)).toEqual([
      { name: 'obj-fixture', from: await realpath(join(a.root, 'engine')) },
    ]);
    await auditSlot(namespace, replica);
    expect(await readReplicationMarker(namespace, 'b')).toMatchObject({
      from: 'a',
      phase: 'relocating',
    });
    expect(
      (await readdir(slotDirectory(namespace, 'b'))).some((name) => name.startsWith('replica-'))
    ).toBe(false);

    expect(await readFile(slotFile(namespace, 'a'), 'utf8')).toBe(before);
    await auditSlot(namespace, await readSlot(namespace, 'a'));
  });

  it('declines without touching either slot when this host’s tools did not build it', async () => {
    const { namespace } = await pair();
    const source = await readSlot(namespace, 'a');
    await writeDurable(slotFile(namespace, 'a'), {
      ...source,
      fullBuildAnchor: { ...source.fullBuildAnchor, nativeToolsDigest: 'elsewhere' },
    });
    const before = await readFile(slotFile(namespace, 'b'), 'utf8');
    const refusal = await replicateSlotBuild(namespace, 'a', 'b').catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ReplicationDeclined);
    expect((refusal as ReplicationDeclined).retry).toBe(false);
    expect(await readFile(slotFile(namespace, 'b'), 'utf8')).toBe(before);
    expect(await readReplicationMarker(namespace, 'b')).toBeUndefined();
  });

  it('declines on a source that does not audit, and leaves its quarantine to its next job', async () => {
    const { namespace, a } = await pair();
    await writeFile(join(a.root, 'engine', 'browser', 'manifest.txt'), 'drift\n');
    await expect(replicateSlotBuild(namespace, 'a', 'b')).rejects.toThrow(/did not audit/);
    expect((await readSlot(namespace, 'a')).quarantined).toBeNull();
    expect(await readFile(join(a.root, 'engine', 'browser', 'manifest.txt'), 'utf8')).toBe(
      'drift\n'
    );
  });

  it('waits, to try again, while something holds either slot', async () => {
    const { namespace } = await pair();
    const release = await acquireSlot(namespace, 'b');
    try {
      const refusal = await replicateSlotBuild(namespace, 'a', 'b').catch(
        (error: unknown) => error
      );
      expect(refusal).toBeInstanceOf(ReplicationDeclined);
      expect((refusal as ReplicationDeclined).retry).toBe(true);
    } finally {
      await release();
    }
  });

  it('marks a destination whose relocation failed as needing a full build, objects gone', async () => {
    const { namespace } = await pair();
    await replicateSlotBuild(namespace, 'a', 'b');
    const marker = await readReplicationMarker(namespace, 'b');
    if (marker === undefined) throw new Error('no marker');
    await abandonReplication(namespace, 'b', marker, 'configure failed');
    const failed = await readSlot(namespace, 'b');
    expect(failed).toMatchObject({ requiresFullBuild: true, quarantined: null });
    expect(failed.fullBuildAnchor).toBeUndefined();
    expect(
      (await readdir(join(failed.root, 'engine'))).some((name) => name.startsWith('obj-'))
    ).toBe(false);
    expect(await readReplicationMarker(namespace, 'b')).toBeUndefined();
    expect((await readSlot(namespace, 'a')).quarantined).toBeNull();
    await auditSlot(namespace, failed);
  });

  it('settles what a crash interrupted: untouched while copying, quarantined while swapping', async () => {
    const { namespace } = await pair();
    const before = await readFile(slotFile(namespace, 'b'), 'utf8');
    await mkdir(join(slotDirectory(namespace, 'b'), 'replica-interrupted', 'root'), {
      recursive: true,
    });
    await abandonReplication(namespace, 'b', { from: 'a', phase: 'copying', startedAt: '' }, 'x');
    expect(await readFile(slotFile(namespace, 'b'), 'utf8')).toBe(before);
    expect(await readdir(slotDirectory(namespace, 'b'))).not.toContain('replica-interrupted');

    await abandonReplication(
      namespace,
      'b',
      { from: 'a', phase: 'swapping', startedAt: '' },
      'the replication was interrupted'
    );
    const swapped = await readSlot(namespace, 'b');
    expect(swapped.quarantined).toBe(
      "Replicating slot a's build into it stopped partway: the replication was interrupted"
    );
    expect(
      (await readdir(join(swapped.root, 'engine'))).some((name) => name.startsWith('obj-'))
    ).toBe(false);
    expect((await readSlot(namespace, 'a')).quarantined).toBeNull();
  });
});
