// SPDX-License-Identifier: EUPL-1.2
/**
 * The ownership/status scan spends O(1) git processes, not one per managed
 * file. Real git throughout; `node:child_process.spawn` is wrapped only to
 * count what the exec layer launches.
 */
import type * as ChildProcess from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawned = vi.hoisted(() => ({ commands: [] as string[][] }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: ((command: string, args: readonly string[], options: ChildProcess.SpawnOptions) => {
      spawned.commands.push([command, ...args]);
      return actual.spawn(command, args, options);
    }) as typeof actual.spawn,
  };
});

import { GitError } from '../../errors/git.js';
import {
  createTempProject,
  initCommittedRepo,
  runGit,
  writeFiles,
} from '../../test-utils/index.js';
import { getFileContentAtRef, getFilesContentAtRef } from '../git-file-ops.js';
import {
  expandUntrackedDirectoryEntries,
  getUntrackedFilesInDir,
  getWorkingTreeStatus,
  listUntrackedFilesInDirs,
} from '../git-status.js';
import { classifyFiles } from '../status-classify.js';

const N = 50;

function modifyPatch(file: string, oldLine: string, newLine: string): string {
  return [
    `diff --git a/${file} b/${file}`,
    'index 1111111..2222222 100644',
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1 +1 @@',
    `-${oldLine}`,
    `+${newLine}`,
    '',
  ].join('\n');
}

function manifestJson(rows: Array<{ filename: string; filesAffected: string[] }>): string {
  return `${JSON.stringify(
    {
      version: 1,
      patches: rows.map((row, index) => ({
        filename: row.filename,
        order: index + 1,
        category: 'ui',
        name: `fixture-${index}`,
        description: 'fixture',
        createdAt: '2026-01-01T00:00:00.000Z',
        sourceEsrVersion: '140.9.0esr',
        filesAffected: row.filesAffected,
      })),
    },
    null,
    2
  )}\n`;
}

const gitSpawns = (): string[][] => spawned.commands.filter(([command]) => command === 'git');

describe('status scan batching', () => {
  let projectRoot: string;
  let engineDir: string;
  let patchesDir: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-status-batching-');
    engineDir = join(projectRoot, 'engine');
    patchesDir = join(projectRoot, 'patches');
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('classifies N managed files with O(1) git processes and the same verdicts', async () => {
    const files = Array.from({ length: N }, (_, i) => `browser/f${String(i).padStart(2, '0')}.txt`);
    await initCommittedRepo(engineDir, Object.fromEntries(files.map((file) => [file, 'line1\n'])));
    await writeFiles(projectRoot, {
      ...Object.fromEntries(
        files.map((file, i) => [
          `patches/${String(i + 1).padStart(3, '0')}-ui-f.patch`,
          modifyPatch(file, 'line1', 'line2'),
        ])
      ),
      'patches/patches.json': manifestJson(
        files.map((file, i) => ({
          filename: `${String(i + 1).padStart(3, '0')}-ui-f.patch`,
          filesAffected: [file],
        }))
      ),
    });
    // Even files carry the patch (patch-backed), odd ones drifted.
    for (const [i, file] of files.entries()) {
      await writeFile(join(engineDir, file), i % 2 === 0 ? 'line2\n' : 'drifted\n');
    }

    spawned.commands.length = 0;
    const classified = await classifyFiles(
      files.map((file) => ({ status: ' M', file })),
      engineDir,
      patchesDir,
      'testbrowser',
      new Set()
    );

    expect(classified.map((entry) => entry.classification)).toEqual(
      files.map((_, i) => (i % 2 === 0 ? 'patch-backed' : 'patch-owned-drift'))
    );
    // One cat-file for the HEAD blobs; 0.47.1 spawned a `git show` per file.
    expect(gitSpawns().length).toBeLessThanOrEqual(3);
    expect(gitSpawns().filter(([, sub]) => sub === 'show')).toHaveLength(0);
  });

  it('hashes every binary managed file in one hash-object', async () => {
    const binaries = ['a.bin', 'b.bin', 'c.bin'];
    await initCommittedRepo(engineDir, { 'placeholder.txt': 'x\n' });
    const patchText: Record<string, string> = {};
    for (const [i, file] of binaries.entries()) {
      await writeFile(join(engineDir, file), Buffer.from([0, 1, 2, i]));
      await runGit(engineDir, ['add', '-N', file]);
      patchText[`patches/00${i + 1}-ui-bin.patch`] = await runGit(engineDir, [
        'diff',
        '--binary',
        '--',
        file,
      ]);
    }
    await writeFiles(projectRoot, {
      ...patchText,
      'patches/patches.json': manifestJson(
        binaries.map((file, i) => ({ filename: `00${i + 1}-ui-bin.patch`, filesAffected: [file] }))
      ),
    });

    spawned.commands.length = 0;
    const classified = await classifyFiles(
      binaries.map((file) => ({ status: '??', file })),
      engineDir,
      patchesDir,
      'testbrowser',
      new Set()
    );

    expect(classified.map((entry) => entry.classification)).toEqual([
      'patch-backed',
      'patch-backed',
      'patch-backed',
    ]);
    expect(gitSpawns().filter(([, sub]) => sub === 'hash-object')).toHaveLength(1);
  });

  it('lists every collapsed untracked directory with one ls-files, in per-directory order', async () => {
    await initCommittedRepo(engineDir, { 'tracked.txt': 'x\n' });
    await writeFiles(engineDir, {
      'one/a.txt': 'a',
      'one/nested/b.txt': 'b',
      'two/c.txt': 'c',
      'three/d.txt': 'd',
    });
    const status = await getWorkingTreeStatus(engineDir);
    expect(status.map((entry) => entry.file).sort()).toEqual(['one/', 'three/', 'two/']);

    spawned.commands.length = 0;
    const expanded = await expandUntrackedDirectoryEntries(engineDir, status);

    expect(gitSpawns().filter(([, sub]) => sub === 'ls-files')).toHaveLength(1);
    const perDirectory: string[] = [];
    for (const entry of status) {
      perDirectory.push(...(await getUntrackedFilesInDir(engineDir, entry.file)));
    }
    expect(expanded.map((entry) => entry.file)).toEqual(perDirectory);
  });

  it('keeps non-ASCII untracked names literal', async () => {
    await initCommittedRepo(engineDir, { 'tracked.txt': 'x\n' });
    await writeFiles(engineDir, { 'dir/café.txt': 'x' });

    const byDir = await listUntrackedFilesInDirs(engineDir, ['dir/']);

    expect(byDir.get('dir/')).toEqual(['dir/café.txt']);
  });
});

describe('getFilesContentAtRef', () => {
  let projectRoot: string;
  let engineDir: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-cat-file-batch-');
    engineDir = join(projectRoot, 'engine');
    await initCommittedRepo(engineDir, {
      'multi.txt': 'one\ntwo\n\nfour\n',
      'empty.txt': '',
      'no-newline.txt': 'tail',
      'utf8.txt': 'café — \u{1F525}\n',
      'dir/inner.txt': 'inner\n',
    });
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('returns what getFileContentAtRef returns for every path, in one git process', async () => {
    const paths = [
      'multi.txt',
      'empty.txt',
      'no-newline.txt',
      'utf8.txt',
      'dir/inner.txt',
      'absent.txt',
    ];
    spawned.commands.length = 0;

    const batch = await getFilesContentAtRef(engineDir, paths);

    expect(gitSpawns()).toHaveLength(1);
    for (const path of paths) {
      expect(batch.get(path)).toBe(await getFileContentAtRef(engineDir, path));
    }
    expect(batch.get('absent.txt')).toBeNull();
  });

  it('falls back per file for a non-blob path', async () => {
    const batch = await getFilesContentAtRef(engineDir, ['dir']);
    await expect(getFileContentAtRef(engineDir, 'dir')).resolves.toBe(batch.get('dir'));
  });

  it('throws like the per-file helper when the ref does not resolve', async () => {
    await expect(
      getFilesContentAtRef(engineDir, ['multi.txt'], 'no-such-ref')
    ).rejects.toBeInstanceOf(GitError);
  });
});
