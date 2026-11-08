// SPDX-License-Identifier: EUPL-1.2
import { expect, it } from 'vitest';

import { parseDiffSections } from '../../core/patch-parse.js';
import { applyHunksByContext } from '../re-export-hunks.js';

it.each([
  { before: 'old\n', after: 'new', old: '-old', add: '+new\n\\ No newline at end of file' },
  { before: 'old', after: 'new\n', old: '-old\n\\ No newline at end of file', add: '+new' },
  { before: 'same\n', after: 'same', old: '-same', add: '+same\n\\ No newline at end of file' },
  { before: 'same', after: 'same\n', old: '-same\n\\ No newline at end of file', add: '+same' },
])(
  'preserves exact selected EOF semantics in both directions: %j',
  ({ before, after, old, add }) => {
    const diff = `diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n${old}\n${add}\n`;
    const hunks = parseDiffSections(diff)[0]?.hunks;
    if (!hunks?.length) throw new Error('Fixture must parse actual EOF markers');
    expect(applyHunksByContext(before, hunks, false, 'a')).toBe(after);
    expect(applyHunksByContext(after, hunks, true, 'a')).toBe(before);
  }
);

it('refuses stale EOF bytes instead of silently consuming an unrelated terminator edit', () => {
  const diff = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n';
  const hunks = parseDiffSections(diff)[0]?.hunks;
  if (!hunks?.length) throw new Error('Fixture must parse');
  expect(() => applyHunksByContext('old', hunks, false, 'a')).toThrow('EOF newline');
});
