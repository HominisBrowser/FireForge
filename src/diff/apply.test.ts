// SPDX-License-Identifier: EUPL-1.2
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { git, gitBytes, initRepo } from '../testing/git.js';
import { useTempDir, writeTree } from '../testing/temp.js';
import { applyFileDiff, type FileDiff, parsePatch } from './index.js';

/** The one section of a diff for `path`, built from its hunk lines. */
function section(body: string[], header: string[] = []): FileDiff {
  const text = ['diff --git a/f b/f', ...header, '--- a/f', '+++ b/f', ...body, ''].join('\n');
  const file = parsePatch(text).files[0];
  if (file === undefined) throw new Error('fixture must parse');
  return file;
}

function hunk(lines: string[], oldStart: number, newStart: number): string[] {
  const oldCount = lines.filter((line) => !line.startsWith('+')).length;
  const newCount = lines.filter((line) => !line.startsWith('-')).length;
  return [`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...lines];
}

function applyText(
  file: FileDiff,
  content: string | undefined,
  reverse = false
): string | undefined {
  return applyFileDiff(file, content === undefined ? undefined : Buffer.from(content), {
    reverse,
  })?.toString('utf8');
}

describe('applyFileDiff', () => {
  it('applies several hunks and honours a final no-newline marker', () => {
    const file = section([
      ...hunk(['-line1', '+line1-updated', ' line2'], 1, 1),
      ...hunk([' line4', '-line5', '+line5a', '+line5b'], 4, 4),
      '\\ No newline at end of file',
    ]);
    expect(applyText(file, 'line1\nline2\nline3\nline4\nline5\n')).toBe(
      'line1-updated\nline2\nline3\nline4\nline5a\nline5b'
    );
  });

  it.each([
    { before: 'old\n', after: 'new', old: ['-old'], add: ['+new', '\\ No newline at end of file'] },
    { before: 'old', after: 'new\n', old: ['-old', '\\ No newline at end of file'], add: ['+new'] },
    {
      before: 'same\n',
      after: 'same',
      old: ['-same'],
      add: ['+same', '\\ No newline at end of file'],
    },
    {
      before: 'same',
      after: 'same\n',
      old: ['-same', '\\ No newline at end of file'],
      add: ['+same'],
    },
  ])(
    'keeps exact end-of-file newlines both ways: $before -> $after',
    ({ before, after, old, add }) => {
      const file = section(['@@ -1 +1 @@', ...old, ...add]);
      expect(applyText(file, before)).toBe(after);
      expect(applyText(file, after, true)).toBe(before);
    }
  );

  it('refuses content whose end-of-file newline the hunk does not expect', () => {
    const file = section(['@@ -1 +1 @@', '-old', '+new']);
    expect(() => applyText(file, 'old')).toThrow(/newline at the end/);
  });

  it('places a hunk by its context when lines above it moved', () => {
    const file = section(hunk([' a', '+n', ' b'], 1, 1));
    expect(applyText(file, 'x\ny\na\nb\nc\n')).toBe('x\ny\na\nn\nb\nc\n');
  });

  it('carries the offset of one hunk to the next', () => {
    const file = section([...hunk([' a', '+a2'], 1, 1), ...hunk([' c', '-d', '+D'], 3, 4)]);
    expect(applyText(file, 'top\na\nb\nc\nd\n')).toBe('top\na\na2\nb\nc\nD\n');
  });

  it('prefers the exact line over an earlier identical block', () => {
    const file = section(hunk([' k', '-v', '+w'], 4, 4));
    expect(applyText(file, 'k\nv\nx\nk\nv\n')).toBe('k\nv\nx\nk\nw\n');
  });

  it('reverses a hunk and refuses one whose lines are gone', () => {
    const file = section(hunk([' a', '+n', ' b'], 1, 1));
    expect(applyText(file, 'a\nn\nb\n', true)).toBe('a\nb\n');
    expect(() => applyText(file, 'q\n')).toThrow(/does not apply/);
  });

  it('inserts at the top, at a named line and into an empty file', () => {
    expect(applyText(section(['@@ -0,0 +1 @@', '+first']), 'a\nb\n')).toBe('first\na\nb\n');
    expect(applyText(section(['@@ -1,0 +2 @@', '+second']), 'a\nb\n')).toBe('a\nsecond\nb\n');
    expect(applyText(section(['@@ -2,0 +3 @@', '+third']), 'a\nb\n')).toBe('a\nb\nthird\n');
    expect(applyText(section(['@@ -0,0 +1 @@', '+only']), '')).toBe('only\n');
  });

  it('verifies hunk counts against the body', () => {
    const file = section(['@@ -1,3 +1,2 @@', ' line1', '-line2']);
    expect(() => applyText(file, 'line1\nline2\nline3\n')).toThrow(
      expect.objectContaining({ code: 'diff-corrupt' })
    );
  });

  it('creates, deletes and refuses the wrong starting state', () => {
    const created = section(
      ['@@ -0,0 +1,2 @@', '+export const a = 1;', '+a();'],
      ['new file mode 100644']
    );
    expect(applyText(created, undefined)).toBe('export const a = 1;\na();\n');
    expect(() => applyText(created, 'x\n')).toThrow(/already exists/);
    expect(applyText(created, 'export const a = 1;\na();\n', true)).toBeUndefined();

    const bare = section(
      ['@@ -0,0 +1 @@', '+bare', '\\ No newline at end of file'],
      ['new file mode 100644']
    );
    expect(applyText(bare, undefined)).toBe('bare');
    const empty = parsePatch('diff --git a/e b/e\nnew file mode 100644\nindex 0000000..e69de29\n')
      .files[0];
    if (empty === undefined) throw new Error('fixture must parse');
    expect(applyFileDiff(empty, undefined)?.length).toBe(0);

    const deleted = section(['@@ -1 +0,0 @@', '-bye'], ['deleted file mode 100644']);
    expect(applyText(deleted, 'bye\n')).toBeUndefined();
    expect(() => applyText(deleted, 'bye\nmore\n')).toThrow(/more than the patch removes/);
    expect(() => applyText(section(['@@ -1 +1 @@', '-a', '+b']), undefined)).toThrow(
      /does not exist/
    );
  });

  it('leaves content alone for a mode-only section and refuses a binary one', () => {
    const mode = parsePatch('diff --git a/f b/f\nold mode 100644\nnew mode 100755\n').files[0];
    if (mode === undefined) throw new Error('fixture must parse');
    expect(applyText(mode, 'same\n')).toBe('same\n');
    const binary = parsePatch(
      'diff --git a/i b/i\nindex 1..2 100644\nGIT binary patch\nliteral 1\nIcmZPo000\n\n'
    ).files[0];
    if (binary === undefined) throw new Error('fixture must parse');
    expect(() => applyFileDiff(binary, Buffer.from('x'))).toThrow(
      expect.objectContaining({ code: 'diff-binary' })
    );
  });

  it('keeps bytes exact for a Latin-1 file under a UTF-8 or a Latin-1 patch', () => {
    const content = Buffer.from('caf\xe9\nkeep\n', 'latin1');
    const ascii = section(hunk([' keep', '+added'], 2, 2));
    expect(applyFileDiff(ascii, content)).toEqual(Buffer.from('caf\xe9\nkeep\nadded\n', 'latin1'));
    const latin = parsePatch(
      Buffer.from(
        'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-caf\xe9\n+th\xe9\n',
        'latin1'
      )
    ).files[0];
    if (latin === undefined) throw new Error('fixture must parse');
    expect(applyFileDiff(latin, content)).toEqual(Buffer.from('th\xe9\nkeep\n', 'latin1'));
    const utf8 = section(['@@ -1 +1 @@', '-grüße', '+grüß']);
    expect(applyFileDiff(utf8, Buffer.from('grüße\n'))?.toString('utf8')).toBe('grüß\n');
  });
});

describe('applyFileDiff against real git diffs', () => {
  const dir = useTempDir();

  it('turns each old file into the new one exactly as git does', async () => {
    const repo = dir();
    const lines = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n') + '\n';
    const before: Record<string, string> = {
      'a.txt': lines,
      'b.txt': 'no newline',
      'c.txt': 'x\r\ny\r\nz\r\n',
      'gone.txt': 'g\n',
    };
    const after: Record<string, string> = {
      'a.txt': lines.replace('line 3\n', 'line three\n').replace('line 30\n', '') + 'tail\n',
      'b.txt': 'no newline\nnow two',
      'c.txt': 'x\r\nY\r\nz\r\n',
      'new.txt': 'fresh\n',
    };
    await initRepo(repo, before);
    await rm(join(repo, 'gone.txt'));
    await writeTree(repo, after);
    await git(repo, ['add', '-A']);
    const patch = parsePatch(await gitBytes(repo, ['diff', '--cached', '--no-renames', 'HEAD']));
    expect(patch.files).toHaveLength(5);
    for (const file of patch.files) {
      const old = before[file.path];
      const result = applyFileDiff(file, old === undefined ? undefined : Buffer.from(old));
      const expected = after[file.path];
      expect(result?.toString('utf8')).toBe(expected);
      if (expected !== undefined) {
        expect(result).toEqual(await readFile(join(repo, file.path)));
      }
    }
  });
});
