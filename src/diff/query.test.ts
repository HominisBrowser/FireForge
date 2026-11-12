// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { addedLines, affectedPaths, hunkSides, parsePatch } from './index.js';

const PATCH = parsePatch(
  [
    'diff --git a/z.js b/z.js',
    '--- a/z.js',
    '+++ b/z.js',
    '@@ -2,3 +2,4 @@',
    ' two',
    '-three',
    '+THREE',
    '+three-and-a-half',
    ' four',
    '@@ -10 +11,2 @@',
    ' ten',
    '+eleven',
    '\\ No newline at end of file',
    'diff --git a/old.js b/new.js',
    'rename from old.js',
    'rename to new.js',
    'diff --git a/a.js b/a.js',
    'deleted file mode 100644',
    '--- a/a.js',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-gone',
    'diff --git a/link b/link',
    'deleted file mode 120000',
    'diff --git a/link b/link',
    'new file mode 100644',
    '',
  ].join('\n')
);

describe('patch queries', () => {
  it('lists affected paths sorted and unique, both sides of a rename', () => {
    expect(affectedPaths(PATCH)).toEqual(['a.js', 'link', 'new.js', 'old.js', 'z.js']);
  });

  it('numbers added lines on the new side', () => {
    const first = PATCH.files[0];
    if (first === undefined) throw new Error('fixture must parse');
    expect(addedLines(first)).toEqual([
      { line: 3, text: 'THREE' },
      { line: 4, text: 'three-and-a-half' },
      { line: 12, text: 'eleven' },
    ]);
  });

  it('splits a hunk into sides and assigns no-newline markers to the right one', () => {
    const [first, second] = PATCH.files[0]?.hunks ?? [];
    if (first === undefined || second === undefined) throw new Error('fixture must parse');
    expect(hunkSides(first)).toEqual({
      old: ['two', 'three', 'four'],
      new: ['two', 'THREE', 'three-and-a-half', 'four'],
      oldNoNewline: false,
      newNoNewline: false,
    });
    expect(hunkSides(second)).toMatchObject({ oldNoNewline: false, newNoNewline: true });
    const context = parsePatch(
      'diff --git a/f b/f\n@@ -1,2 +1 @@\n-x\n y\n\\ No newline at end of file\n'
    ).files[0]?.hunks[0];
    if (context === undefined) throw new Error('fixture must parse');
    expect(hunkSides(context)).toMatchObject({ oldNoNewline: true, newNoNewline: true });
  });
});
