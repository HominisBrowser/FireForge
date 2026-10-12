// SPDX-License-Identifier: EUPL-1.2
/**
 * Pure-function tests for the re-export foreign-drift comparison: offset
 * shifts are not drift, new and dropped payload lines are, scan adoptions
 * and retirements are excluded, and binary sections compare by recorded hash.
 */
import { describe, expect, it } from 'vitest';

import { computeForeignDrift } from '../re-export-drift.js';

function textBody(file: string, hunks: string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    'index abc1234..def5678 100644',
    `--- a/${file}`,
    `+++ b/${file}`,
    ...hunks,
    '',
  ].join('\n');
}

function binaryBody(file: string, oldHash: string, newHash: string): string {
  return [
    `diff --git a/${file} b/${file}`,
    `index ${oldHash}..${newHash} 100644`,
    'GIT binary patch',
    'literal 10',
    '+K}0e#0ssI2',
    '',
  ].join('\n');
}

const FILE = 'browser/base/content/browser.js';

describe('computeForeignDrift', () => {
  it('reports no drift when only hunk offsets and context shifted', () => {
    const oldBody = textBody(FILE, ['@@ -10,3 +10,4 @@', ' before', '+added line', ' after']);
    const newBody = textBody(FILE, ['@@ -42,3 +42,4 @@', ' other-context', '+added line', ' tail']);
    expect(computeForeignDrift(oldBody, newBody, [FILE])).toEqual([]);
  });

  it('reports a + line absent from the old body as foreign drift', () => {
    const oldBody = textBody(FILE, ['@@ -10,3 +10,4 @@', ' ctx', '+mine', ' ctx2']);
    const newBody = textBody(FILE, [
      '@@ -10,3 +10,5 @@',
      ' ctx',
      '+mine',
      '+foreign registration line',
      ' ctx2',
    ]);
    const drift = computeForeignDrift(oldBody, newBody, [FILE]);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ file: FILE, addedLines: 1, removedLines: 0 });
    expect(drift[0]?.hunkSummaries[0]).toContain('(+1/-0)');
  });

  it('reports a - line absent from the old body as foreign drift', () => {
    const oldBody = textBody(FILE, ['@@ -10,2 +10,3 @@', ' ctx', '+mine']);
    const newBody = textBody(FILE, ['@@ -10,3 +10,3 @@', ' ctx', '+mine', '-deleted by someone']);
    const drift = computeForeignDrift(oldBody, newBody, [FILE]);
    expect(drift[0]).toMatchObject({ addedLines: 0, removedLines: 1 });
  });

  it('accounts for duplicate payload lines as a multiset, not a set', () => {
    const oldBody = textBody(FILE, ['@@ -1,2 +1,3 @@', ' ctx', '+dup']);
    const newBody = textBody(FILE, ['@@ -1,2 +1,4 @@', ' ctx', '+dup', '+dup']);
    const drift = computeForeignDrift(oldBody, newBody, [FILE]);
    expect(drift[0]?.addedLines).toBe(1);
  });

  it('ignores files not previously owned (scan adoptions are intentional)', () => {
    const adopted = 'browser/base/content/new-widget.js';
    const oldBody = textBody(FILE, ['@@ -1,2 +1,3 @@', ' ctx', '+mine']);
    const newBody =
      textBody(FILE, ['@@ -1,2 +1,3 @@', ' ctx', '+mine']) +
      textBody(adopted, ['@@ -0,0 +1,1 @@', '+brand new']);
    expect(computeForeignDrift(oldBody, newBody, [FILE])).toEqual([]);
  });

  it('flags a binary section whose recorded new-side hash changed', () => {
    const oldBody = binaryBody(FILE, '1'.repeat(40), '2'.repeat(40));
    const newBody = binaryBody(FILE, '1'.repeat(40), '3'.repeat(40));
    const drift = computeForeignDrift(oldBody, newBody, [FILE]);
    expect(drift[0]).toMatchObject({ file: FILE, binaryChanged: true });
  });

  it('does not flag a binary section whose hash is unchanged', () => {
    const body = binaryBody(FILE, '1'.repeat(40), '2'.repeat(40));
    expect(computeForeignDrift(body, body, [FILE])).toEqual([]);
  });

  it('treats a file newly present in the body but already owned as drift', () => {
    // Owned file had no section before (body unchanged from HEAD then).
    // Now the refreshed body carries content for it.
    const oldBody = '';
    const newBody = textBody(FILE, ['@@ -1,1 +1,2 @@', ' ctx', '+foreign']);
    const drift = computeForeignDrift(oldBody, newBody, [FILE]);
    expect(drift[0]?.addedLines).toBe(1);
  });

  it('counts a dropped + line (a deletion-only engine edit) as a removed line', () => {
    const oldBody = textBody(FILE, ['@@ -10,2 +10,4 @@', ' ctx', '+mine', '+peer deleted this']);
    const newBody = textBody(FILE, ['@@ -10,2 +10,3 @@', ' ctx', '+mine']);
    const drift = computeForeignDrift(oldBody, newBody, [FILE]);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ file: FILE, addedLines: 0, removedLines: 1 });
    expect(drift[0]?.hunkSummaries[0]).toContain('in the old body, dropped (+0/-1)');
  });

  it('counts a dropped - line (an upstream line restored) as an added line', () => {
    const oldBody = textBody(FILE, ['@@ -10,3 +10,3 @@', ' ctx', '+mine', '-upstream line']);
    const newBody = textBody(FILE, ['@@ -10,2 +10,3 @@', ' ctx', '+mine']);
    const drift = computeForeignDrift(oldBody, newBody, [FILE]);
    expect(drift[0]).toMatchObject({ addedLines: 1, removedLines: 0 });
    expect(drift[0]?.hunkSummaries[0]).toContain('dropped (+1/-0)');
  });

  it('counts an edited line as one added and one removed', () => {
    const oldBody = textBody(FILE, ['@@ -1,1 +1,2 @@', ' ctx', '+value = 1;']);
    const newBody = textBody(FILE, ['@@ -1,1 +1,2 @@', ' ctx', '+value = 2;']);
    const drift = computeForeignDrift(oldBody, newBody, [FILE]);
    expect(drift[0]).toMatchObject({ addedLines: 1, removedLines: 1 });
    expect(drift[0]?.hunkSummaries).toHaveLength(2);
  });

  it('reports an owned file whose section left the body (engine copy back at HEAD)', () => {
    const other = 'browser/base/content/other.js';
    const oldBody =
      textBody(FILE, ['@@ -1,1 +1,2 @@', ' ctx', '+mine']) +
      textBody(other, ['@@ -1,1 +1,3 @@', ' ctx', '+a', '+b']);
    const newBody = textBody(FILE, ['@@ -1,1 +1,2 @@', ' ctx', '+mine']);
    const drift = computeForeignDrift(oldBody, newBody, [FILE, other]);
    expect(drift).toEqual([
      expect.objectContaining({ file: other, addedLines: 0, removedLines: 2 }),
    ]);
  });

  it('skips a dropped file that is not in the compared set (an --expect-removed retirement)', () => {
    const other = 'browser/base/content/other.js';
    const oldBody =
      textBody(FILE, ['@@ -1,1 +1,2 @@', ' ctx', '+mine']) +
      textBody(other, ['@@ -1,1 +1,2 @@', ' ctx', '+a']);
    const newBody = textBody(FILE, ['@@ -1,1 +1,2 @@', ' ctx', '+mine']);
    expect(computeForeignDrift(oldBody, newBody, [FILE])).toEqual([]);
  });

  it('flags a binary section that left the body', () => {
    const oldBody = binaryBody(FILE, '1'.repeat(40), '2'.repeat(40));
    const drift = computeForeignDrift(oldBody, '', [FILE]);
    expect(drift[0]).toMatchObject({ file: FILE, binaryChanged: true });
  });
});
