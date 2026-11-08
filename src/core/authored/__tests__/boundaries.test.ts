// SPDX-License-Identifier: EUPL-1.2
import * as filesystem from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { captureAuthoredSnapshot } from '../capture.js';
import * as gitTransport from '../git.js';
import { exportPristineTree, materializeAuthoredSnapshot } from '../materialize.js';
import { validateAuthoredConfig } from '../paths.js';
import { authenticateAuthoredSnapshot } from '../provider.js';
import { sourceFixture, writeAt } from './fixtures.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, rename: vi.fn(original.rename) };
});

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => filesystem.rm(path, { recursive: true, force: true }))
  );
});

it('refuses a torn intended input capture and detects mode/config changes even when dirty paths stay the same', async () => {
  const { root, pristine, config } = await sourceFixture();
  directories.push(dirname(root));
  await writeAt(root, 'src/browser/new.js', 'export const value = 1;\n// dirty\n');
  const original = gitTransport.sourceGit;
  let value = 2;
  vi.spyOn(gitTransport, 'sourceGit').mockImplementation(async (...args) => {
    const result = await original(...args);
    if (args[1][0] === 'hash-object')
      await writeAt(root, 'src/browser/new.js', `export const value = ${value++};\n`);
    return result;
  });
  await expect(
    captureAuthoredSnapshot({
      projectRoot: root,
      intendedPaths: ['src'],
      pristineRepository: pristine,
    })
  ).rejects.toThrow('authored-capture-moved');
  vi.restoreAllMocks();
  const before = await captureAuthoredSnapshot({
    projectRoot: root,
    intendedPaths: ['src'],
    pristineRepository: pristine,
  });
  await filesystem.chmod(join(root, 'src/browser/new.js'), 0o755);
  const executable = await captureAuthoredSnapshot({
    projectRoot: root,
    intendedPaths: ['src'],
    pristineRepository: pristine,
  });
  expect(executable.id).not.toBe(before.id);
  await writeAt(root, 'fireforge.json', JSON.stringify({ ...config, build: { jobs: 2 } }));
  const configured = await captureAuthoredSnapshot({
    projectRoot: root,
    intendedPaths: ['src'],
    pristineRepository: pristine,
  });
  expect(configured.id).not.toBe(executable.id);
  await expect(
    authenticateAuthoredSnapshot({ ...configured, gitVersion: 'git version fabricated' }, pristine)
  ).rejects.toThrow('authored-snapshot-mismatch');
});

it('rolls a failed materialization back before advancing its ledger', async () => {
  const { root, pristine, declaration } = await sourceFixture();
  directories.push(dirname(root));
  await writeAt(root, 'src/browser/manifest.txt', 'local\n');
  await writeAt(
    root,
    '.fireforge-sources/overrides/browser/manifest.txt.json',
    JSON.stringify(declaration)
  );
  const snapshot = await captureAuthoredSnapshot({
    projectRoot: root,
    intendedPaths: ['src'],
    pristineRepository: pristine,
  });
  const runtime = join(dirname(root), 'runtime');
  const ledgerPath = join(dirname(root), 'ledger.json');
  await exportPristineTree(pristine, snapshot.pin.commit, runtime);
  const { rename } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  let refused = false;
  vi.spyOn(filesystem, 'rename').mockImplementation(async (from, to) => {
    if (!refused && String(to) === join(runtime, 'browser/new.js')) {
      refused = true;
      throw new Error('injected output failure');
    }
    await rename(from, to);
  });
  await expect(
    materializeAuthoredSnapshot({
      snapshot,
      engineDir: runtime,
      ledgerPath,
      pristineRepository: pristine,
    })
  ).rejects.toThrow('injected output failure');
  expect(await filesystem.readFile(join(runtime, 'browser/manifest.txt'), 'utf8')).toContain(
    'second'
  );
  await expect(filesystem.readFile(join(runtime, 'browser/new.js'))).rejects.toThrow();
  await expect(filesystem.readFile(ledgerPath)).rejects.toThrow();
  await expect(filesystem.readFile(`${ledgerPath}.journal`)).rejects.toThrow();
});

it('rejects source roots that alias runtime state or collide under filesystem case folding', () => {
  const base = {
    schemaVersion: 1,
    mode: 'authored',
    root: 'src',
    metadataRoot: '.fireforge-sources',
    pristineCommit: 'a'.repeat(40),
  };
  expect(() => {
    validateAuthoredConfig({ ...base, root: '.FireForge' });
  }).toThrow('authored-invalid-config: sources.root overlaps a reserved directory');
  expect(() => {
    validateAuthoredConfig({ ...base, metadataRoot: 'SRC/metadata' });
  }).toThrow('authored-invalid-config');
  expect(() => {
    validateAuthoredConfig({ ...base, root: '../src' });
  }).toThrow('authored-invalid-config: sources.root must be a contained');
});

it('reconciles only an explicitly authorized active derived generation before slot reuse', async () => {
  const { root, pristine } = await sourceFixture();
  directories.push(dirname(root));
  const snapshot = await captureAuthoredSnapshot({
    projectRoot: root,
    intendedPaths: ['src'],
    pristineRepository: pristine,
  });
  const runtime = join(dirname(root), 'runtime');
  const ledgerPath = join(dirname(root), 'ledger.json');
  await exportPristineTree(pristine, snapshot.pin.commit, runtime);
  const options = { snapshot, engineDir: runtime, ledgerPath, pristineRepository: pristine };
  await materializeAuthoredSnapshot(options);
  await writeAt(runtime, 'browser/new.js', 'sanctioned derived output\n');
  const { recordAuthoredDerivedOutputs } = await import('../materialize.js');
  await expect(
    recordAuthoredDerivedOutputs({
      engineDir: runtime,
      ledgerPath,
      snapshotId: 'wrong',
      paths: ['browser/new.js'],
    })
  ).rejects.toThrow('authored-derived-generation-mismatch');
  await expect(
    recordAuthoredDerivedOutputs({
      engineDir: runtime,
      ledgerPath,
      snapshotId: snapshot.id,
      paths: ['unmanaged.js'],
    })
  ).rejects.toThrow('authored-derived-unmanaged');
  await recordAuthoredDerivedOutputs({
    engineDir: runtime,
    ledgerPath,
    snapshotId: snapshot.id,
    paths: ['browser/new.js'],
  });
  expect((await materializeAuthoredSnapshot(options)).changed).toEqual(['browser/new.js']);
  expect(await filesystem.readFile(join(runtime, 'browser/new.js'), 'utf8')).toContain('value = 1');
});

it('exports contained pristine links and engine-named upstream directories without following external links', async () => {
  const { root, pristine } = await sourceFixture();
  directories.push(dirname(root));
  await filesystem.symlink('manifest.txt', join(pristine, 'browser/contained-link'));
  await writeAt(pristine, 'gfx/engine/module.cpp', 'pristine code\n');
  const { commitFixture } = await import('./fixtures.js');
  await commitFixture(pristine);
  const commit = (await gitTransport.sourceGit(pristine, ['rev-parse', 'HEAD']))
    .toString('utf8')
    .trim();
  const output = join(dirname(root), 'pristine-export');
  await exportPristineTree(pristine, commit, output);
  expect(await filesystem.readlink(join(output, 'browser/contained-link'))).toBe('manifest.txt');
  expect(await filesystem.readFile(join(output, 'gfx/engine/module.cpp'), 'utf8')).toContain(
    'pristine code'
  );
  await filesystem.symlink('../../external', join(pristine, 'browser/external-link'));
  await commitFixture(pristine);
  const escaped = (await gitTransport.sourceGit(pristine, ['rev-parse', 'HEAD']))
    .toString('utf8')
    .trim();
  await expect(
    exportPristineTree(pristine, escaped, join(dirname(root), 'escaped-export'))
  ).rejects.toThrow('authored-pristine-link-escape');
});
