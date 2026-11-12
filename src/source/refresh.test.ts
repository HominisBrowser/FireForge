// SPDX-License-Identifier: EUPL-1.2
import { chmod, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { git, gitBytes } from '../testing/git.js';
import { createSourceFixture, type SourceFixture } from '../testing/source.js';
import { useTempDir } from '../testing/temp.js';
import { override, refreshPin, verifySource } from './index.js';

const dir = useTempDir();
const TEXT = Array.from({ length: 15 }, (_, index) => `line ${index + 1}\n`).join('');
const NEW_PIN = { version: '153.7.0esr', product: 'firefox-esr' } as const;

async function failureCode(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => 'none',
    (error: unknown) => (error as { code: string }).code
  );
}

const names = [
  'clean',
  'reduced',
  'conflict',
  'mode',
  'removed',
  'deleted-edit',
  'unchanged',
  'gone-edited',
];

async function fixture(): Promise<SourceFixture> {
  const pristine = Object.fromEntries(names.map((name) => [`browser/${name}.txt`, TEXT]));
  return createSourceFixture(dir(), {
    pristine: { ...pristine, 'browser/binary.bin': Buffer.from([0, 1]), 'browser/kept.txt': TEXT },
  });
}

const owned = (value: SourceFixture, path: string): Promise<string> =>
  readFile(join(value.root, 'src', path), 'utf8');

describe('refreshPin', () => {
  it('merges three ways in place, retires what upstream absorbed, and leaves conflicts as git does', async () => {
    const value = await fixture();
    const project = await value.load();
    const old = value.pristine;
    for (const name of [...names, 'binary', 'kept']) {
      const path = `browser/${name}.${name === 'binary' ? 'bin' : 'txt'}`;
      await override(project, old, path, {
        component: 'fixture',
        delete: name === 'removed' || name === 'deleted-edit',
      });
    }
    const local = TEXT.replace('line 4\n', 'local line 4\n');
    await value.write({
      'src/browser/clean.txt': local,
      'src/browser/reduced.txt': local,
      'src/browser/conflict.txt': local,
      'src/browser/gone-edited.txt': local,
      'src/browser/kept.txt': local,
      'src/browser/binary.bin': Buffer.from([0, 2]),
      'src/browser/new.js': 'export const ours = true;\n',
      'src/browser/stays.js': 'export const stays = true;\n',
    });
    await chmod(join(value.root, 'src/browser/mode.txt'), 0o755);
    await value.commit('owned changes');
    const next = await value.advance(
      {
        'browser/clean.txt': TEXT.replace('line 12\n', 'upstream line 12\n'),
        'browser/reduced.txt': TEXT.replace('line 1\n', 'upstream line 1\n'),
        'browser/conflict.txt': TEXT.replace('line 4\n', 'upstream line 4\n'),
        'browser/mode.txt': TEXT.replace('line 12\n', 'upstream line 12\n'),
        'browser/deleted-edit.txt': `${TEXT}upstream addition\n`,
        'browser/unchanged.txt': `${TEXT}upstream addition\n`,
        'browser/binary.bin': Buffer.from([0, 3]),
        'browser/new.js': 'export const upstream = true;\n',
      },
      ['browser/removed.txt', 'browser/gone-edited.txt']
    );

    const result = await refreshPin(project, old, next, NEW_PIN);
    expect(
      Object.fromEntries(result.paths.map((path) => [path.path, path.reason ?? path.outcome]))
    ).toEqual({
      'browser/binary.bin': 'binary',
      'browser/clean.txt': 'merged',
      'browser/conflict.txt': 'content',
      'browser/deleted-edit.txt': 'delete-edit',
      'browser/gone-edited.txt': 'delete-edit',
      'browser/kept.txt': 'kept',
      // Ours differs from upstream by its executable bit alone, which Windows cannot hold.
      'browser/mode.txt': process.platform === 'win32' ? 'retired' : 'merged',
      'browser/new.js': 'upstream-collision',
      'browser/reduced.txt': 'merged',
      'browser/removed.txt': 'retired',
      'browser/stays.js': 'kept',
      'browser/unchanged.txt': 'retired',
    });
    expect(result.conflicts).toEqual([
      'browser/binary.bin',
      'browser/conflict.txt',
      'browser/deleted-edit.txt',
      'browser/gone-edited.txt',
      'browser/new.js',
    ]);

    // Clean merges are in the owned files, with records on the new base.
    expect(await owned(value, 'browser/clean.txt')).toBe(
      local.replace('line 12\n', 'upstream line 12\n')
    );
    // Windows has no executable bit.
    if (process.platform !== 'win32') {
      expect((await stat(join(value.root, 'src/browser/mode.txt'))).mode & 0o111).not.toBe(0);
    }
    const record = JSON.parse(
      await readFile(
        join(value.root, '.fireforge-sources/overrides/browser/clean.txt.json'),
        'utf8'
      )
    ) as { base: { commit: string } };
    expect(record.base.commit).toBe(next.commit);
    await expect(readFile(join(value.root, 'src/browser/unchanged.txt'))).rejects.toThrow();
    await expect(
      readFile(join(value.root, '.fireforge-sources/overrides/browser/removed.txt.json'))
    ).rejects.toThrow();

    // Conflicts: markers in text, our bytes for binary, three stages in the index.
    const markers = await owned(value, 'browser/conflict.txt');
    expect(markers).toContain('<<<<<<< local');
    expect(markers).toContain('local line 4');
    expect(markers).toContain('upstream line 4');
    expect(markers).toContain('>>>>>>> new pristine');
    expect(await readFile(join(value.root, 'src/browser/binary.bin'))).toEqual(Buffer.from([0, 2]));
    expect(await gitBytes(value.root, ['show', ':3:src/browser/binary.bin'])).toEqual(
      Buffer.from([0, 3])
    );
    const unmerged = (await git(value.root, ['diff', '--name-only', '--diff-filter=U']))
      .trim()
      .split('\n');
    expect(unmerged).toEqual(result.conflicts.map((path) => `src/${path}`));

    // The pin moved, and the result judges cleanly against the new pristine once resolved.
    const moved = await value.load();
    expect(moved.config.source.pristineCommit).toBe(next.commit);
    expect(moved.config.firefox.version).toBe('153.7.0esr');
    expect(
      (await verifySource(moved, next)).map((problem) => [problem.kind, problem.path])
    ).toEqual(result.conflicts.map((path) => ['unmerged', path]));
  });

  it('refuses a dirty source, an unchanged pin, and paths the new tree leaves no place for', async () => {
    const value = await fixture();
    const project = await value.load();
    await override(project, value.pristine, 'browser/kept.txt');
    await value.write({ 'src/browser/created/a.js': 'export const a = 1;\n' });
    expect(await failureCode(refreshPin(project, value.pristine, value.pristine, NEW_PIN))).toBe(
      'refresh-pin-unchanged'
    );
    const next = await value.advance({
      'browser/created': 'an upstream file where a directory was\n',
    });
    expect(await failureCode(refreshPin(project, value.pristine, next, NEW_PIN))).toBe(
      'refresh-dirty'
    );
    await value.commit('owned changes');
    expect(await failureCode(refreshPin(project, value.pristine, next, NEW_PIN))).toBe(
      'refresh-blocked'
    );
    expect((await git(value.root, ['status', '--porcelain'])).trim()).toBe('');
  });
});
