// SPDX-License-Identifier: EUPL-1.2
/**
 * Pure-function tests for the re-export foreign-drift comparison: offset
 * shifts are not drift, new payload lines are, scan adoptions are excluded,
 * and binary sections compare by recorded hash.
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
});
