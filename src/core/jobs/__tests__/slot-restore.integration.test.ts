// SPDX-License-Identifier: EUPL-1.2
/** `slot restore` on a slot that has really been built, followed by the builds an agent would run next, as real processes. */
import { execFileSync } from 'node:child_process';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { commitFixture, writeAt } from '../../authored/__tests__/fixtures.js';
import type { SlotRecord } from '../slot-types.js';
import { readJson, slotDirectory, writeDurable } from '../store.js';
import { type HostFixture, hostFixture, lintClean, removeHostFixture } from './host-fixture.js';

const fixtures: HostFixture[] = [];
afterAll(async () => {
  await Promise.all(fixtures.splice(0).map(removeHostFixture));
}, 120_000);

const slotOf = (f: HostFixture): Promise<SlotRecord> =>
  readJson<SlotRecord>(join(slotDirectory(f.namespace, 'a'), 'slot.json'));

const TEST = 'browser/x/test/browser_a.js';

/** A built host, in one of the shapes a project keeps its branding in. */
async function builtHost(prepare?: (f: HostFixture) => Promise<void>): Promise<HostFixture> {
  const f = await hostFixture();
  fixtures.push(f);
  await writeAt(f.project, `src/${TEST}`, lintClean('add_task(async function () {});\n'));
  await prepare?.(f);
  await commitFixture(f.project);
  const init = await f.cli(f.project, ['host', 'init', '--slots', '1', '--from-engine', f.donor]);
  expect(init.code, `${init.stdout}${init.stderr}`).toBe(0);
  const full = await f.cli(f.project, ['job', 'run', '--build', 'full']);
  expect(full.code, `${full.stdout}${full.stderr}`).toBe(0);
  return f;
}

/** A stray file and the quarantine it earns at the next admission, then the restore and what follows. */
async function strayRestoreRebuild(f: HostFixture): Promise<void> {
  const before = await slotOf(f);
  const objects = join(before.root, 'engine/obj-fake/dist/bin/fixture');
  const built = await readFile(objects, 'utf8');
  await writeFile(join(before.root, 'engine/browser/stray.js'), 'stray');
  await writeDurable(join(slotDirectory(f.namespace, 'a'), 'slot.json'), {
    ...before,
    requiresAudit: true,
  });
  const quarantined = await f.cli(f.project, ['job', 'run', '--check', '--timeout', '15']);
  expect(quarantined.code, quarantined.stdout + quarantined.stderr).toBe(18);
  expect((await slotOf(f)).quarantined).toMatch(/stray/);
  const cancelled = await f.cli(f.project, [
    'job',
    'cancel',
    quarantined.stdout.split(' ')[0] ?? '',
  ]);
  expect(cancelled.code).toBe(0);

  const restored = await f.cli(f.project, ['slot', 'restore', 'a']);
  expect(restored.code, restored.stdout + restored.stderr).toBe(0);
  const slot = await slotOf(f);
  expect(slot.quarantined).toBeNull();
  expect(slot.requiresFullBuild).toBe(true);
  expect(await readFile(objects, 'utf8')).toBe(built);

  // Restoring again changes nothing a third party could tell apart.
  expect((await f.cli(f.project, ['slot', 'restore', 'a'])).code).toBe(0);
  expect((await f.cli(f.project, ['slot', 'audit', 'a'])).code).toBe(0);

  const rebuilt = await f.cli(f.project, ['job', 'run', '--build', 'full']);
  expect(rebuilt.code, `${rebuilt.stdout}${rebuilt.stderr}`).toBe(0);
  const test = await f.cli(f.project, ['job', 'run', '--test', TEST]);
  expect(test.code, `${test.stdout}${test.stderr}`).toBe(0);
  expect((await slotOf(f)).quarantined).toBeNull();
}

describe.concurrent('slot restore on a built slot', () => {
  it('branding the build generates: restore, full build, UI build and test all run', async () => {
    const f = await builtHost();
    const { root } = await slotOf(f);
    await expect(
      lstat(join(root, 'engine/browser/branding/fixture/moz.build'))
    ).resolves.toBeDefined();
    await strayRestoreRebuild(f);
  }, 300_000);

  it('branding held in source, overlapping what the build generates: the same', async () => {
    const f = await builtHost(async ({ project }) => {
      for (const [path, body] of [
        ['moz.build', 'DIRS += ["content"]\n'],
        ['configure.sh', '# held in source\nMOZ_APP_DISPLAYNAME="Fixture"\n'],
        ['locales/en-US/brand.properties', 'brandShorterName=Fixture\n'],
        ['locales/en-US/brand.ftl', '-brand-short-name = Fixture\n'],
      ] as const)
        await writeAt(project, `src/browser/branding/fixture/${path}`, body);
    });
    await strayRestoreRebuild(f);
  }, 300_000);

  it('keeps the mtime of what already holds the snapshot, so the next build stays incremental', async () => {
    const f = await builtHost();
    const { root } = await slotOf(f);
    const owned = join(root, 'engine/browser/new.js');
    const stamped = (await lstat(owned)).mtimeMs;
    await writeFile(join(root, 'engine/browser/stray.js'), 'stray');
    const slot = await slotOf(f);
    await writeDurable(join(slotDirectory(f.namespace, 'a'), 'slot.json'), {
      ...slot,
      quarantined: 'a stray',
    });
    const restored = await f.cli(f.project, ['slot', 'restore', 'a']);
    expect(restored.code, restored.stderr).toBe(0);
    expect((await lstat(owned)).mtimeMs).toBe(stamped);
    await expect(lstat(join(root, 'engine/browser/stray.js'))).rejects.toThrow(/ENOENT/);
  }, 300_000);

  it('a lock file a killed run left in the slot does not outlive the restore', async () => {
    const f = await builtHost();
    const { root } = await slotOf(f);
    await writeFile(join(root, '.fireforge/engine-session.lock'), 'pid=1\nchild-group=1\n');
    const slot = await slotOf(f);
    await writeDurable(join(slotDirectory(f.namespace, 'a'), 'slot.json'), {
      ...slot,
      quarantined: 'interrupted',
    });
    expect((await f.cli(f.project, ['slot', 'restore', 'a'])).code).toBe(0);
    await expect(lstat(join(root, '.fireforge/engine-session.lock'))).rejects.toThrow(/ENOENT/);
    execFileSync('true');
  }, 300_000);
});
