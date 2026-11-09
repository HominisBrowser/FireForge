// SPDX-License-Identifier: EUPL-1.2
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { captureAuthoredSnapshot } from '../../authored/index.js';
import { recordSuccessfulBuild } from '../build-identity.js';
import { submitJob, waitForJob } from '../client.js';
import { hostCapacity } from '../schema.js';
import { readSlot } from '../slots.js';
import { writeDurable } from '../store.js';
import { type JobFixture, jobFixture } from './job-fixture.js';

// The fixture has no toolchain. Everything the sequence decides on is real, including a real
// `fireforge build` process that runs in the slot and goes red because the fixture has no mach.
vi.mock('../native-tools.js', async (original) => ({
  ...(await original<typeof import('../native-tools.js')>()),
  needsNativeTools: vi.fn(() => false),
}));
vi.mock('../build-derived.js', async (original) => ({
  ...(await original<typeof import('../build-derived.js')>()),
  prepareBuildDerived: vi.fn(() => Promise.resolve()),
  verifyBuildDerived: vi.fn(() => Promise.resolve()),
}));

const fixtures: JobFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

/** A real job seeds the build recipe, which is part of what an anchor binds. */
async function anchorFullBuild(f: JobFixture): Promise<void> {
  const seeded = await submitJob(
    f.namespace,
    f.request([{ command: 'status', args: [] }]),
    f.snapshot
  );
  expect((await waitForJob(f.namespace, seeded.id, 90_000)).state).toBe('passed');
  const slot = await readSlot(f.namespace, 'a');
  await writeDurable(join(slot.root, '.fireforge', 'last-build.json'), {
    engineHeadSha: f.commit,
    builtAt: new Date().toISOString(),
    binaryName: f.config.binaryName,
    buildKind: 'full',
  });
  await recordSuccessfulBuild(f.namespace, 'a', fullBuild);
  expect((await readSlot(f.namespace, 'a')).requiresFullBuild).toBe(false);
}

const fullBuild = { command: 'build' as const, args: [] };
const uiBuild = { command: 'build' as const, args: ['--ui'] };

it('A full build passes, C full build fails, A again: a --ui build is refused', async () => {
  const f = await jobFixture();
  fixtures.push(f);
  // A: a full build establishes the anchor.
  await anchorFullBuild(f);
  const anchored = await readSlot(f.namespace, 'a');
  expect(anchored.fullBuildAnchor?.digest).toBeDefined();

  // C: compiled source changes, and its full build compiles partway and goes red.
  await writeFile(join(f.root, 'src/browser/new.cpp'), 'int value = 3;\n');
  const compiled = await captureAuthoredSnapshot({
    projectRoot: f.root,
    intendedPaths: ['src'],
    pristineRepository: f.pristine,
  });
  const failing = await submitJob(
    f.namespace,
    { ...f.request([fullBuild]), sourceId: compiled.id },
    compiled
  );
  const red = await waitForJob(f.namespace, failing.id, 90_000);
  expect(red.state, JSON.stringify(red)).toBe('failed');
  // The build was granted three quarters of the host, which is what its `-j` follows.
  expect(red.stepResources?.[0]?.cpu).toBe(Math.max(1, Math.floor(hostCapacity().cpu * 0.75)));
  const afterRed = await readSlot(f.namespace, 'a');
  expect(afterRed.quarantined).toBeNull();
  // A failed build must leave nothing that still describes a good binary.
  expect(afterRed.fullBuildAnchor).toBeUndefined();
  expect(afterRed.trustedBuild).toBeUndefined();

  // A': the compiled inputs match A's anchor again, but C's objects are what is on disk.
  await rm(join(f.root, 'src/browser/new.cpp'));
  const restored = await captureAuthoredSnapshot({
    projectRoot: f.root,
    intendedPaths: ['src'],
    pristineRepository: f.pristine,
  });
  expect(restored.id).toBe(f.snapshot.id);
  await expect(submitJob(f.namespace, f.request([uiBuild]), restored)).rejects.toThrow(
    /Slot a cannot run this job: it has no full build/
  );
  // The refusal itself costs nothing.
  const after = await readSlot(f.namespace, 'a');
  expect(after.quarantined).toBeNull();
  expect(after.requiresFullBuild).toBe(true);
}, 240_000);

it('a red UI build forgets the package but keeps the anchor, so the next UI build may run', async () => {
  const f = await jobFixture();
  fixtures.push(f);
  await anchorFullBuild(f);
  const { fullBuildAnchor } = await readSlot(f.namespace, 'a');
  const job = await submitJob(f.namespace, f.request([uiBuild]), f.snapshot);
  const red = await waitForJob(f.namespace, job.id, 90_000);
  expect(red.state, JSON.stringify(red)).toBe('failed');
  expect(red.reason).toMatch(/Executor exited/);
  const after = await readSlot(f.namespace, 'a');
  expect(after.fullBuildAnchor).toEqual(fullBuildAnchor);
  expect(after.trustedBuild).toBeUndefined();
  expect(after.requiresBuild).toBe(true);
  expect(after.quarantined).toBeNull();
}, 150_000);
