// SPDX-License-Identifier: EUPL-1.2
import { lstat, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { getPlatform } from '../../../utils/platform.js';
import { isBrandingSetup, setupBranding } from '../../branding.js';
import { generateMozconfig } from '../../mach-mozconfig.js';
import { composeCapturedBuildOutputs } from '../build-generated.js';
import { captureAuthoredSnapshot } from '../capture.js';
import { sourceGit } from '../git.js';
import { exportCapturedTree, exportPristineTree } from '../materialize.js';
import { commitFixture, sourceFixture, writeAt } from './fixtures.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

it('derives the exact branding and mozconfig mutations from frozen narrow inputs without touching the donor', async () => {
  const value = await sourceFixture();
  directories.push(dirname(value.root));
  await writeAt(
    value.pristine,
    'browser/branding/unofficial/moz.build',
    '# Branding build registration\n'
  );
  await writeAt(
    value.pristine,
    'browser/branding/unofficial/configure.sh',
    '# Original identity\nMOZ_APP_BASENAME=Original\n'
  );
  await writeAt(
    value.pristine,
    'browser/branding/unofficial/locales/en-US/brand.properties',
    'brandShortName=Original\n'
  );
  await writeAt(
    value.pristine,
    'browser/branding/unofficial/locales/en-US/brand.ftl',
    '-brand-short-name = Original\n'
  );
  await writeAt(
    value.pristine,
    'browser/branding/unofficial/content/icon.png',
    Buffer.from([0, 1, 2, 0xff])
  );
  await writeAt(value.pristine, 'browser/moz.configure', 'include("../toolkit/moz.configure")\n');
  await writeAt(
    value.pristine,
    'toolkit/moz.configure',
    'project_flag("MOZ_APP_VENDOR", env="MOZ_APP_VENDOR")\n'
  );
  await commitFixture(value.pristine);
  const commit = (await sourceGit(value.pristine, ['rev-parse', 'HEAD'])).toString('utf8').trim();
  value.config.sources = {
    schemaVersion: 1,
    mode: 'authored',
    root: 'src',
    metadataRoot: '.fireforge-sources',
    pristineCommit: commit,
  };
  await writeAt(value.root, 'fireforge.json', JSON.stringify(value.config));
  await writeAt(
    value.root,
    'configs/common.mozconfig',
    'ac_add_options --with-branding=browser/branding/${binaryName}\n'
  );
  await writeAt(
    value.root,
    `configs/${getPlatform()}.mozconfig`,
    'ac_add_options --enable-application=browser\n'
  );
  const snapshot = await captureAuthoredSnapshot({
    projectRoot: value.root,
    intendedPaths: ['src'],
    pristineRepository: value.pristine,
  });
  const donorIndex = await readFile(join(value.pristine, '.git/index'));
  const expected = await composeCapturedBuildOutputs(snapshot, {
    pristineRepository: value.pristine,
  });
  expect(expected.provenance.platform).toBe(getPlatform());
  expect(expected.files.has('mozconfig')).toBe(true);
  expect(expected.files.has('browser/moz.configure')).toBe(true);
  expect(expected.files.has('toolkit/moz.configure')).toBe(false);
  expect(expected.files.has('browser/manifest.txt')).toBe(false);
  await writeAt(value.root, 'configs/common.mozconfig', 'unrelated live editor change\n');
  const stable = await composeCapturedBuildOutputs(snapshot, {
    pristineRepository: value.pristine,
  });
  expect(stable.provenance).toEqual(expected.provenance);
  expect(stable.files).toEqual(expected.files);
  const slot = join(dirname(value.root), 'slot');
  await exportCapturedTree(snapshot, slot);
  const engine = join(slot, 'engine');
  await exportPristineTree(value.pristine, commit, engine);
  if (!(await isBrandingSetup(engine, snapshot.config)))
    await setupBranding(engine, snapshot.config);
  await generateMozconfig(join(slot, 'configs'), engine, snapshot.config);
  for (const [path, file] of expected.files) {
    expect(await readFile(join(engine, path))).toEqual(file.bytes);
    expect(((await lstat(join(engine, path))).mode & 0o111) !== 0).toBe(file.mode === '100755');
  }
  expect(await readFile(join(value.pristine, '.git/index'))).toEqual(donorIndex);
  expect(await readFile(join(value.pristine, 'browser/moz.configure'), 'utf8')).not.toContain(
    'imply_option'
  );
});
