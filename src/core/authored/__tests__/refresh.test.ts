// SPDX-License-Identifier: EUPL-1.2
import { chmod, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { createDefaultFurnaceConfig } from '../../furnace-config.js';
import { captureAuthoredSnapshot } from '../capture.js';
import { sourceGit } from '../git.js';
import { refreshAuthoredSnapshot } from '../refresh.js';
import { declareAuthoredOverride } from '../writer.js';
import { commitFixture, readCaptured, sourceFixture, upstreamDeltas, writeAt } from './fixtures.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});
const text = Array.from({ length: 15 }, (_, index) => `line ${index + 1}\n`).join('');

it('proposes three-way text/mode/binary/deletion refreshes and preserves reduced-context/reject evidence without mutating any input', async () => {
  const value = await sourceFixture();
  directories.push(dirname(value.root));
  const names = [
    'clean.txt',
    'reduced.txt',
    'conflict.txt',
    'mode.txt',
    'removed.txt',
    'deleted-edit.txt',
  ];
  for (const name of names) await writeAt(value.pristine, `browser/${name}`, text);
  await writeAt(value.pristine, 'browser/binary.bin', Buffer.from([0, 1]));
  await commitFixture(value.pristine);
  const oldCommit = (await sourceGit(value.pristine, ['rev-parse', 'HEAD']))
    .toString('utf8')
    .trim();
  if (!value.config.sources) throw new Error('Fixture requires source mode');
  value.config.sources.pristineCommit = oldCommit;
  await writeAt(value.root, 'fireforge.json', JSON.stringify(value.config));
  await writeAt(value.root, 'docs/refresh.md', 'Approved fixture exception.\n');
  for (const name of [...names, 'binary.bin'])
    await declareAuthoredOverride(value.root, `browser/${name}`, {
      component: 'fixture',
      classification: 'exception',
      adr: 'docs/refresh.md',
      pristineRepository: value.pristine,
      ...(['removed.txt', 'deleted-edit.txt'].includes(name) ? { delete: true } : {}),
    });
  for (const name of ['clean.txt', 'reduced.txt', 'conflict.txt'])
    await writeAt(value.root, `src/browser/${name}`, text.replace('line 4\n', 'local line 4\n'));
  await chmod(join(value.root, 'src/browser/mode.txt'), 0o755);
  await writeAt(value.root, 'src/browser/binary.bin', Buffer.from([0, 2]));
  const snapshot = await captureAuthoredSnapshot({
    projectRoot: value.root,
    intendedPaths: ['src', 'docs/refresh.md'],
    pristineRepository: value.pristine,
  });
  const editorHead = await sourceGit(value.root, ['rev-parse', 'HEAD']);
  const editorIndex = await readFile(join(value.root, '.git/index'));
  const originalConfig = await readFile(join(value.root, 'fireforge.json'));
  await writeAt(
    value.pristine,
    'browser/clean.txt',
    text.replace('line 12\n', 'upstream line 12\n')
  );
  await writeAt(
    value.pristine,
    'browser/reduced.txt',
    text.replace('line 1\n', 'upstream line 1\n')
  );
  await writeAt(
    value.pristine,
    'browser/conflict.txt',
    text.replace('line 4\n', 'upstream line 4\n')
  );
  await writeAt(
    value.pristine,
    'browser/mode.txt',
    text.replace('line 12\n', 'upstream line 12\n')
  );
  await writeAt(value.pristine, 'browser/deleted-edit.txt', text + 'upstream addition\n');
  await writeAt(value.pristine, 'browser/binary.bin', Buffer.from([0, 3]));
  await writeAt(value.pristine, 'browser/new.js', 'export const upstream = true;\n');
  await rm(join(value.pristine, 'browser/removed.txt'));
  await commitFixture(value.pristine);
  const newCommit = (await sourceGit(value.pristine, ['rev-parse', 'HEAD']))
    .toString('utf8')
    .trim();
  const donorIndex = await readFile(join(value.pristine, '.git/index'));
  const donorObjects = await sourceGit(value.pristine, ['count-objects', '-v']);
  const destination = join(dirname(value.root), 'proposal');
  const options = {
    snapshot,
    destination,
    oldPristineRepository: value.pristine,
    newPristineRepository: value.pristine,
    newPin: { firefox: { ...value.config.firefox, version: '153.7.0esr' }, commit: newCommit },
  };
  await expect(
    refreshAuthoredSnapshot({ ...options, destination: join(value.root, 'proposal') })
  ).rejects.toThrow('authored-refresh-destination');
  const proposal = await refreshAuthoredSnapshot(options);
  const paths = new Map(proposal.paths.map((path) => [path.path, path]));
  expect(paths.get('browser/clean.txt')?.outcome).toBe('clean');
  expect(paths.get('browser/reduced.txt')?.outcome).toBe('clean');
  expect(paths.get('browser/conflict.txt')).toMatchObject({
    outcome: 'conflict',
    reason: 'content-conflict',
    conflictFiles: ['conflicts/browser/conflict.txt'],
  });
  const markers = await readFile(join(destination, 'conflicts/browser/conflict.txt'), 'utf8');
  expect(markers).toContain('<<<<<<< local');
  expect(markers).toContain('>>>>>>> new pristine');
  expect(markers).toContain('local line 4');
  expect(markers).toContain('upstream line 4');
  expect(paths.get('browser/binary.bin')).toMatchObject({
    outcome: 'conflict',
    reason: 'binary-conflict',
    conflictFiles: [
      'conflicts/browser/binary.bin.base',
      'conflicts/browser/binary.bin.local',
      'conflicts/browser/binary.bin.upstream',
    ],
  });
  expect(await readFile(join(destination, 'conflicts/browser/binary.bin.upstream'))).toEqual(
    Buffer.from([0, 3])
  );
  expect(paths.get('browser/deleted-edit.txt')).toMatchObject({
    outcome: 'conflict',
    reason: 'delete-edit-conflict',
  });
  expect(paths.get('browser/removed.txt')?.outcome).toBe('retired');
  expect(paths.get('browser/new.js')).toMatchObject({
    outcome: 'conflict',
    reason: 'created-now-shadows-upstream',
  });
  expect(paths.get('browser/mode.txt')?.outcome).toBe('clean');
  expect(await readFile(join(destination, 'src/browser/clean.txt'), 'utf8')).toContain(
    'upstream line 12'
  );
  expect(await readFile(join(destination, 'src/browser/clean.txt'), 'utf8')).toContain(
    'local line 4'
  );
  expect(
    JSON.parse(
      await readFile(
        join(destination, '.fireforge-sources/overrides/browser/clean.txt.json'),
        'utf8'
      )
    )
  ).toMatchObject({ base: { commit: newCommit } });
  await expect(
    readFile(join(destination, '.fireforge-sources/overrides/browser/removed.txt.json'))
  ).rejects.toThrow();
  expect(proposal.conflicts).toBe(4);
  expect(proposal.reviewRequired).toBe(true);
  expect(await sourceGit(value.root, ['rev-parse', 'HEAD'])).toEqual(editorHead);
  expect(await readFile(join(value.root, '.git/index'))).toEqual(editorIndex);
  expect(await readFile(join(value.root, 'fireforge.json'))).toEqual(originalConfig);
  expect(await readFile(join(value.pristine, '.git/index'))).toEqual(donorIndex);
  expect(await sourceGit(value.pristine, ['count-objects', '-v'])).toEqual(donorObjects);
  expect(await sourceGit(value.pristine, ['rev-parse', 'HEAD'])).toEqual(
    Buffer.from(newCommit + '\n')
  );
});

it('refreshes generated component authority without creating a second postimage and produces a capturable clean proposal', async () => {
  const value = await sourceFixture();
  directories.push(dirname(value.root));
  const path = 'toolkit/content/widgets/moz-fixture/moz-fixture.mjs';
  await writeAt(value.pristine, path, text);
  await commitFixture(value.pristine);
  const oldCommit = (await sourceGit(value.pristine, ['rev-parse', 'HEAD']))
    .toString('utf8')
    .trim();
  if (!value.config.sources) throw new Error('Fixture requires source mode');
  value.config.sources.pristineCommit = oldCommit;
  await writeAt(value.root, 'fireforge.json', JSON.stringify(value.config));
  const furnace = createDefaultFurnaceConfig({ binaryName: 'fixture' });
  furnace.custom['moz-fixture'] = {
    description: 'Fixture',
    targetPath: 'toolkit/content/widgets/moz-fixture',
    register: false,
    localized: false,
  };
  await writeAt(value.root, 'furnace.json', JSON.stringify(furnace));
  const component = 'components/custom/moz-fixture/moz-fixture.mjs';
  await writeAt(value.root, component, text.replace('line 4\n', 'local line 4\n'));
  await writeAt(value.root, 'docs/refresh.md', 'Approved fixture exception.\n');
  await declareAuthoredOverride(value.root, path, {
    component: 'fixture',
    classification: 'exception',
    adr: 'docs/refresh.md',
    pristineRepository: value.pristine,
  });
  const snapshot = await captureAuthoredSnapshot({
    projectRoot: value.root,
    intendedPaths: ['src', 'docs/refresh.md'],
    pristineRepository: value.pristine,
  });
  await writeAt(value.pristine, path, text.replace('line 12\n', 'upstream line 12\n'));
  await commitFixture(value.pristine);
  const newCommit = (await sourceGit(value.pristine, ['rev-parse', 'HEAD']))
    .toString('utf8')
    .trim();
  const destination = join(dirname(value.root), 'generated-proposal');
  const proposal = await refreshAuthoredSnapshot({
    snapshot,
    destination,
    oldPristineRepository: value.pristine,
    newPristineRepository: value.pristine,
    newPin: { firefox: { ...value.config.firefox, version: '153.7.0esr' }, commit: newCommit },
  });
  expect(proposal.conflicts).toBe(0);
  expect(await readFile(join(destination, component), 'utf8')).toContain('upstream line 12');
  expect(await readFile(join(destination, component), 'utf8')).toContain('local line 4');
  await expect(readFile(join(destination, 'src', path))).rejects.toThrow();
  await sourceGit(destination, ['init', '--quiet']);
  await commitFixture(destination);
  const refreshed = await captureAuthoredSnapshot({
    projectRoot: destination,
    intendedPaths: ['src'],
    pristineRepository: value.pristine,
  });
  expect((await readCaptured(refreshed, path))?.toString()).toContain('upstream line 12');
  expect(refreshed.files.find((file) => file.path === path)?.declaration?.base.commit).toBe(
    newCommit
  );
});

it('reports directory and file transitions per path instead of aborting or passing them', async () => {
  const value = await sourceFixture();
  directories.push(dirname(value.root));
  await writeAt(value.pristine, 'browser/became-dir.txt', text);
  await commitFixture(value.pristine);
  const oldCommit = (await sourceGit(value.pristine, ['rev-parse', 'HEAD']))
    .toString('utf8')
    .trim();
  if (!value.config.sources) throw new Error('Fixture requires source mode');
  value.config.sources.pristineCommit = oldCommit;
  await writeAt(value.root, 'fireforge.json', JSON.stringify(value.config));
  await declareAuthoredOverride(value.root, 'browser/became-dir.txt', {
    component: 'fixture',
    classification: 'registration',
    pristineRepository: value.pristine,
  });
  await writeAt(value.root, 'src/browser/created/a.js', 'export const a = 1;\n');
  await writeAt(value.root, 'src/browser/stays.js', 'export const b = 2;\n');
  await commitFixture(value.root);
  const snapshot = await captureAuthoredSnapshot({
    projectRoot: value.root,
    pristineRepository: value.pristine,
  });
  await rm(join(value.pristine, 'browser/became-dir.txt'));
  await writeAt(value.pristine, 'browser/became-dir.txt/inner.txt', text);
  await writeAt(value.pristine, 'browser/created', 'upstream file where a directory was\n');
  await commitFixture(value.pristine);
  const newCommit = (await sourceGit(value.pristine, ['rev-parse', 'HEAD']))
    .toString('utf8')
    .trim();
  const proposal = await refreshAuthoredSnapshot({
    snapshot,
    destination: join(dirname(value.root), 'missing-parent', 'proposal'),
    oldPristineRepository: value.pristine,
    newPristineRepository: value.pristine,
    newPin: { firefox: { ...value.config.firefox, version: '153.7.0esr' }, commit: newCommit },
  });
  const paths = new Map(proposal.paths.map((path) => [path.path, path]));
  expect(paths.get('browser/created/a.js')).toMatchObject({
    outcome: 'conflict',
    reason: 'upstream-file-at-ancestor: browser/created',
  });
  expect(paths.get('browser/became-dir.txt')).toMatchObject({
    outcome: 'conflict',
    reason: 'upstream-directory-at-path',
  });
  expect(paths.get('browser/stays.js')?.outcome).toBe('created');
});

it('gives each binary override a replayable per-path delta', async () => {
  const value = await sourceFixture();
  directories.push(dirname(value.root));
  const original = Buffer.from([0, 1, 2, 3, 255, 10, 0, 7]);
  await writeAt(value.pristine, 'updater/release.der', original);
  await commitFixture(value.pristine);
  const commit = (await sourceGit(value.pristine, ['rev-parse', 'HEAD'])).toString('utf8').trim();
  if (!value.config.sources) throw new Error('Fixture requires source mode');
  value.config.sources.pristineCommit = commit;
  await writeAt(value.root, 'fireforge.json', JSON.stringify(value.config));
  await declareAuthoredOverride(value.root, 'updater/release.der', {
    component: 'fixture',
    classification: 'registration',
    pristineRepository: value.pristine,
  });
  await writeAt(value.root, 'src/updater/release.der', Buffer.from([9, 0, 8, 255, 10, 0, 1]));
  await commitFixture(value.root);
  const snapshot = await captureAuthoredSnapshot({
    projectRoot: value.root,
    pristineRepository: value.pristine,
  });
  const deltas = await upstreamDeltas(snapshot, value.pristine);
  const delta = deltas.find((entry) => entry.path === 'updater/release.der');
  if (!delta) throw new Error('Expected a binary delta');
  await sourceGit(value.pristine, ['apply', '--check', '--binary', '-'], delta.diff);
});
