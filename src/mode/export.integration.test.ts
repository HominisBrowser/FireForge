// SPDX-License-Identifier: EUPL-1.2
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ExitCode } from '../kernel/errors.js';
import { exists } from '../kernel/fs.js';
import { makeSourceProject, useMachSandbox } from '../testing/engine.js';
import { useTempDir, writeTree } from '../testing/temp.js';
import { exportChanges, replaceDirectory } from './export.js';

const dir = useTempDir();
useMachSandbox();

const REQUEST = { paths: [], all: false } as const;

describe('export in source mode', () => {
  it('replaces an earlier generated queue and refuses entries that are not part of it', async () => {
    const project = await makeSourceProject(dir(), {
      files: { 'src/browser/base/content/panel.mjs': 'export const panel = 1;\n' },
    });
    const first = await exportChanges(project, REQUEST);
    expect(first.kind).toBe('queue');
    const out = project.paths.patches;
    const written = await readdir(out);
    expect(written).toContain('patches.json');

    await writeTree(out, { 'notes.txt': 'keep me\n' });
    await expect(exportChanges(project, REQUEST)).rejects.toMatchObject({
      code: 'export-target-has-other-files',
      exitCode: ExitCode.INVALID_ARGUMENT,
      message: expect.stringContaining('notes.txt') as unknown,
    });
    expect(await exists(join(out, 'notes.txt'))).toBe(true);
    expect((await readdir(out)).sort()).toEqual([...written, 'notes.txt'].sort());

    await rm(join(out, 'notes.txt'));

    await writeTree(project.root, {
      'src/browser/base/content/panel.mjs': 'export const panel = 2;\n',
    });
    await exportChanges(project, { ...REQUEST, out: join(dir(), 'second') });
    await exportChanges(project, { ...REQUEST, out: join(dir(), 'second') });
    expect((await readdir(dir())).filter((name) => name.includes('fireforge-tmp'))).toEqual([]);
  }, 60_000);
});

describe('export over a queue that holds a file named like a patch to come', () => {
  it('refuses, and keeps the file', async () => {
    const project = await makeSourceProject(dir(), { files: {} });
    const out = join(dir(), 'queue');
    await exportChanges(project, { ...REQUEST, out });
    await writeTree(project.root, {
      'src/browser/base/content/panel.mjs': 'export const panel = 1;\n',
    });
    const elsewhere = join(dir(), 'elsewhere');
    await exportChanges(project, { ...REQUEST, out: elsewhere });
    const before = await readdir(out);
    const coming = (await readdir(elsewhere)).filter((name) => !before.includes(name));
    expect(coming.length).toBeGreaterThan(0);

    await writeTree(out, { [coming[0] ?? '']: 'mine\n' });
    await expect(exportChanges(project, { ...REQUEST, out })).rejects.toMatchObject({
      exitCode: ExitCode.INVALID_ARGUMENT,
    });
    expect(await readFile(join(out, coming[0] ?? ''), 'utf8')).toBe('mine\n');
  }, 60_000);
});

describe('replaceDirectory', () => {
  it('puts the staged directory in place and leaves nothing beside it', async () => {
    await writeTree(dir(), { 'out/old.txt': 'old\n', 'staged/new.txt': 'new\n' });
    await replaceDirectory(join(dir(), 'staged'), join(dir(), 'out'));
    expect(await readdir(join(dir(), 'out'))).toEqual(['new.txt']);
    expect((await readdir(dir())).sort()).toEqual(['out']);
  });

  it('keeps the previous directory when the new one cannot be moved in', async () => {
    await writeTree(dir(), { 'out/old.txt': 'old\n' });
    await expect(replaceDirectory(join(dir(), 'missing'), join(dir(), 'out'))).rejects.toThrow();
    expect(await readdir(join(dir(), 'out'))).toEqual(['old.txt']);
    expect((await readdir(dir())).sort()).toEqual(['out']);
  });
});
