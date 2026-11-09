// SPDX-License-Identifier: EUPL-1.2
import { lstat, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { getPlatform } from '../../../utils/platform.js';
import { commitFixture, sourceFixture, writeAt } from '../../authored/__tests__/fixtures.js';
import { captureAuthoredSnapshot } from '../../authored/capture.js';
import { sourceGit } from '../../authored/git.js';
import { prepareBuildEnvironment } from '../../build-prepare.js';
import { getProjectPaths } from '../../config-paths.js';
import { prepareBuildDerived, verifyBuildDerived } from '../build-derived.js';
import { readAdmittedSnapshot } from '../guard.js';
import { createSlot } from '../slot-lifecycle.js';
import { acquireSlot, auditSlot, prepareSlot } from '../slots.js';

vi.mock('../guard.js', async (original) => ({
  ...(await original<typeof import('../guard.js')>()),
  readAdmittedSnapshot: vi.fn(),
}));
const directories: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

it('runs actual build preparation against captured inputs, seals only declared output, and reuses the slot', async () => {
  const fixture = await sourceFixture();
  const directory = dirname(fixture.root);
  directories.push(directory);
  await writeAt(
    fixture.pristine,
    'browser/branding/unofficial/moz.build',
    '# Branding build registration\n'
  );
  await writeAt(
    fixture.pristine,
    'browser/branding/unofficial/configure.sh',
    '# Original identity\nMOZ_APP_BASENAME=Original\n'
  );
  await writeAt(
    fixture.pristine,
    'browser/branding/unofficial/locales/en-US/brand.properties',
    'brandShortName=Original\n'
  );
  await writeAt(
    fixture.pristine,
    'browser/branding/unofficial/locales/en-US/brand.ftl',
    '-brand-short-name = Original\n'
  );
  await writeAt(fixture.pristine, 'browser/moz.configure', 'include("../toolkit/moz.configure")\n');
  await writeAt(
    fixture.pristine,
    'toolkit/moz.configure',
    'project_flag("MOZ_APP_VENDOR", env="MOZ_APP_VENDOR")\n'
  );
  await commitFixture(fixture.pristine);
  const commit = (await sourceGit(fixture.pristine, ['rev-parse', 'HEAD'])).toString('utf8').trim();
  fixture.config.sources = {
    schemaVersion: 1,
    mode: 'authored',
    root: 'src',
    metadataRoot: '.fireforge-sources',
    pristineCommit: commit,
  };
  await writeAt(fixture.root, 'fireforge.json', JSON.stringify(fixture.config));
  await writeAt(
    fixture.root,
    'configs/common.mozconfig',
    'ac_add_options --with-branding=browser/branding/${binaryName}\n'
  );
  await writeAt(
    fixture.root,
    `configs/${getPlatform()}.mozconfig`,
    'ac_add_options --enable-application=browser\n'
  );
  const snapshot = await captureAuthoredSnapshot({
    projectRoot: fixture.root,
    intendedPaths: ['src'],
    pristineRepository: fixture.pristine,
  });
  const namespace = join(directory, 'coordinator');
  let slot = await createSlot({
    namespace,
    id: 'a',
    snapshot,
    pristineRepository: fixture.pristine,
  });
  const release = await acquireSlot(namespace, slot.id);
  try {
    vi.mocked(readAdmittedSnapshot).mockResolvedValue({
      snapshot,
      pristineRepository: slot.pristineRepository,
      slot,
      phase: 'fixture-owned-phase',
    });
    await prepareBuildDerived(namespace, slot, snapshot);
    const preparation = await prepareBuildEnvironment(
      slot.root,
      getProjectPaths(slot.root),
      snapshot.config,
      { refuseUnexportedDrift: true }
    );
    expect(preparation.reconfigured).toBe(false);
    expect(await readFile(join(slot.root, 'engine/mozconfig'), 'utf8')).toContain(
      '--with-branding=browser/branding/fixture'
    );
    await verifyBuildDerived(namespace, slot, snapshot);
    const audit = await auditSlot(namespace, slot);
    expect(audit.runtimeDigest).toMatch(/^[a-f0-9]{64}$/);
    await writeAt(slot.root, 'engine/browser/unknown.mjs', 'unrecorded drift');
    await expect(auditSlot(namespace, slot)).rejects.toThrow('Undeclared engine drift');
    await rm(join(slot.root, 'engine/browser/unknown.mjs'));
    slot = await prepareSlot(namespace, slot, snapshot);
    expect(await readFile(join(slot.root, 'engine/mozconfig'), 'utf8')).toContain(
      '--with-branding=browser/branding/fixture'
    );
    await writeAt(fixture.root, 'src/browser/new.js', 'export const value = 2;\n');
    const next = await captureAuthoredSnapshot({
      projectRoot: fixture.root,
      intendedPaths: ['src'],
      pristineRepository: fixture.pristine,
    });
    const before = (await lstat(join(slot.root, 'engine/mozconfig'))).mtimeMs;
    slot = await prepareSlot(namespace, slot, next);
    // Only the source changed, so the generated mozconfig stays exactly where configure saw it.
    expect((await lstat(join(slot.root, 'engine/mozconfig'))).mtimeMs).toBe(before);
    await prepareBuildDerived(namespace, slot, next);
    expect(await readFile(join(slot.root, 'engine/browser/new.js'), 'utf8')).toContain('value = 2');
    expect((await auditSlot(namespace, slot)).runtimeDigest).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    await release();
  }
});
