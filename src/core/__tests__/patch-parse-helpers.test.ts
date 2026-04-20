// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import {
  extractAffectedFiles,
  extractConflictingFiles,
  extractOrder,
  isNewFileInPatch,
  parseHunksForFile,
} from '../patch-parse.js';

const MULTI_HUNK_PATCH = [
  'diff --git a/browser/a.js b/browser/a.js',
  '--- a/browser/a.js',
  '+++ b/browser/a.js',
  '@@ -1,2 +1,2 @@',
  ' old-one',
  '-old-two',
  '+new-two',
  '@@ -8,1 +8,2 @@',
  ' context-eight',
  '+new-nine',
  '\\ No newline at end of file',
  'diff --git a/browser/b.css b/browser/b.css',
  '--- a/browser/b.css',
  '+++ b/browser/b.css',
  '@@ -1 +1 @@',
  '-red',
  '+blue',
  '',
].join('\n');

describe('patch parse helper coverage', () => {
  it('extracts numeric patch order and falls back to Infinity for non-prefixed names', () => {
    expect(extractOrder('001-test.patch')).toBe(1);
    expect(extractOrder('patch.patch')).toBe(Number.POSITIVE_INFINITY);
  });

  it('detects new-file sections only for the requested target file', () => {
    const patch = [
      'diff --git a/browser/existing.js b/browser/existing.js',
      '--- a/browser/existing.js',
      '+++ b/browser/existing.js',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/browser/brand-new.js b/browser/brand-new.js',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/browser/brand-new.js',
      '@@ -0,0 +1 @@',
      '+created',
      '',
    ].join('\n');

    expect(isNewFileInPatch(patch, 'browser/existing.js')).toBe(false);
    expect(isNewFileInPatch(patch, 'browser/brand-new.js')).toBe(true);
    expect(isNewFileInPatch(patch, 'browser/missing.js')).toBe(false);
  });

  it('extracts affected files in sorted order without duplicates', () => {
    const patch = [
      'diff --git a/browser/z.js b/browser/z.js',
      '--- a/browser/z.js',
      '+++ b/browser/z.js',
      'diff --git a/browser/a.js b/browser/a.js',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/browser/a.js',
      '+++ b/browser/z.js',
      '',
    ].join('\n');

    expect(extractAffectedFiles(patch)).toEqual(['browser/a.js', 'browser/z.js']);
  });

  it('extracts only the hunks for the requested file and tracks no-newline markers', () => {
    const hunks = parseHunksForFile(MULTI_HUNK_PATCH, 'browser/a.js');

    expect(hunks).toEqual([
      {
        oldStart: 1,
        oldCount: 2,
        newStart: 1,
        newCount: 2,
        lines: [' old-one', '-old-two', '+new-two'],
        noNewlineAtEndOld: false,
        noNewlineAtEndNew: false,
      },
      {
        oldStart: 8,
        oldCount: 1,
        newStart: 8,
        newCount: 2,
        // The no-newline marker follows `+new-nine`, so it annotates only
        // the new side. The old side still terminates with a newline.
        lines: [' context-eight', '+new-nine'],
        noNewlineAtEndOld: false,
        noNewlineAtEndNew: true,
      },
    ]);
  });

  it('returns no hunks when the requested file is not present in the patch', () => {
    expect(parseHunksForFile(MULTI_HUNK_PATCH, 'browser/missing.js')).toEqual([]);
  });

  it('defaults omitted hunk counts to one line', () => {
    const patch = [
      'diff --git a/browser/simple.js b/browser/simple.js',
      '--- a/browser/simple.js',
      '+++ b/browser/simple.js',
      '@@ -4 +4 @@',
      '-before',
      '+after',
      '',
    ].join('\n');

    expect(parseHunksForFile(patch, 'browser/simple.js')).toEqual([
      {
        oldStart: 4,
        oldCount: 1,
        newStart: 4,
        newCount: 1,
        lines: ['-before', '+after'],
        noNewlineAtEndOld: false,
        noNewlineAtEndNew: false,
      },
    ]);
  });

  it('annotates the old side only when the marker follows a removed line', () => {
    // Removing the trailing-newlineless last line and replacing it with
    // a line that does have a terminating newline. A single boolean
    // would confuse this with the symmetric case and cause the projected
    // content to disagree with `git apply` on the new-side newline.
    const patch = [
      'diff --git a/browser/asym.js b/browser/asym.js',
      '--- a/browser/asym.js',
      '+++ b/browser/asym.js',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '-old-last',
      '\\ No newline at end of file',
      '+new-last',
      '',
    ].join('\n');

    expect(parseHunksForFile(patch, 'browser/asym.js')).toEqual([
      {
        oldStart: 1,
        oldCount: 2,
        newStart: 1,
        newCount: 2,
        lines: [' keep', '-old-last', '+new-last'],
        noNewlineAtEndOld: true,
        noNewlineAtEndNew: false,
      },
    ]);
  });

  it('annotates both sides when independent markers trail both removed and added lines', () => {
    // Both the old and new versions end without a trailing newline. Each
    // `\ No newline at end of file` marker is independent and applies to
    // the side of the preceding body line.
    const patch = [
      'diff --git a/browser/both.js b/browser/both.js',
      '--- a/browser/both.js',
      '+++ b/browser/both.js',
      '@@ -1 +1 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file',
      '',
    ].join('\n');

    expect(parseHunksForFile(patch, 'browser/both.js')).toEqual([
      {
        oldStart: 1,
        oldCount: 1,
        newStart: 1,
        newCount: 1,
        lines: ['-old', '+new'],
        noNewlineAtEndOld: true,
        noNewlineAtEndNew: true,
      },
    ]);
  });

  it('annotates both sides when the marker follows a context line', () => {
    // A context line is shared between both sides, so a marker that
    // trails one is asserting that the line is the terminal line of
    // both files and lacks a trailing newline on both.
    const patch = [
      'diff --git a/browser/ctx.js b/browser/ctx.js',
      '--- a/browser/ctx.js',
      '+++ b/browser/ctx.js',
      '@@ -1,2 +1,1 @@',
      '-dropped',
      ' kept',
      '\\ No newline at end of file',
      '',
    ].join('\n');

    expect(parseHunksForFile(patch, 'browser/ctx.js')).toEqual([
      {
        oldStart: 1,
        oldCount: 2,
        newStart: 1,
        newCount: 1,
        lines: ['-dropped', ' kept'],
        noNewlineAtEndOld: true,
        noNewlineAtEndNew: true,
      },
    ]);
  });

  it('extracts all conflicting files from git apply error output', () => {
    const errorOutput = [
      'error: patch failed: browser/a.js:12',
      'error: patch failed: browser/b.css:3',
      'hint: use --reject to continue',
    ].join('\n');

    expect(extractConflictingFiles(errorOutput)).toEqual(['browser/a.js', 'browser/b.css']);
    expect(extractConflictingFiles(undefined)).toEqual([]);
  });
});
