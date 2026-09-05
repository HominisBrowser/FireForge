// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import {
  extractAffectedFiles,
  extractConflictingFiles,
  extractOrder,
  isNewFileInPatch,
  parseDiffGitHeader,
  parseDiffSections,
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

describe('patch parsing — order, hunks, and diff headers', () => {
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

  it('parses a CRLF-saved patch file identically to its LF twin', () => {
    // A patch file saved with CRLF endings (Windows editor, autocrlf
    // checkout) has \r on every line. The historical '\n'-only walkers
    // failed target-file matching (captured path kept the trailing \r)
    // and never saw the `\ No newline` marker.
    const crlfPatch = MULTI_HUNK_PATCH.split('\n').join('\r\n');

    expect(extractAffectedFiles(crlfPatch)).toEqual(['browser/a.js', 'browser/b.css']);
    const hunks = parseHunksForFile(crlfPatch, 'browser/a.js');
    expect(hunks).toHaveLength(2);
    expect(hunks[0]?.lines).toEqual([' old-one', '-old-two', '+new-two']);
    expect(hunks[1]?.noNewlineAtEndNew).toBe(true);
  });

  it('preserves payload \\r when only the content is CRLF (LF patch file)', () => {
    // An LF-saved patch of a CRLF-content file has \r only on payload
    // lines, where it is significant and must survive parsing.
    const patch = [
      'diff --git a/win/file.txt b/win/file.txt',
      '--- a/win/file.txt',
      '+++ b/win/file.txt',
      '@@ -1,1 +1,1 @@',
      '-old\r',
      '+new\r',
      '',
    ].join('\n');

    const hunks = parseHunksForFile(patch, 'win/file.txt');
    expect(hunks[0]?.lines).toEqual(['-old\r', '+new\r']);
  });

  it('parses quoted diff --git headers (special characters in paths)', () => {
    expect(parseDiffGitHeader('diff --git "a/dir/sp ace.js" "b/dir/sp ace.js"')).toEqual({
      sourcePath: 'dir/sp ace.js',
      targetPath: 'dir/sp ace.js',
    });
    // core.quotePath octal-escapes non-ASCII bytes: ü = \303\274.
    expect(parseDiffGitHeader('diff --git "a/f\\303\\274r.js" "b/f\\303\\274r.js"')).toEqual({
      sourcePath: 'für.js',
      targetPath: 'für.js',
    });
  });

  it('splits an unquoted header whose path itself contains " b/"', () => {
    // The historical greedy regex split at the last ' b/', truncating the
    // path to 'x.js'. The symmetric split recovers the real path.
    expect(parseDiffGitHeader('diff --git a/lib b/x.js b/lib b/x.js')).toEqual({
      sourcePath: 'lib b/x.js',
      targetPath: 'lib b/x.js',
    });
  });

  it('marks binary sections and never yields hunks for them', () => {
    const patch = [
      'diff --git a/icons/logo.png b/icons/logo.png',
      'new file mode 100644',
      'index 0000000..1111111',
      'GIT binary patch',
      'literal 5',
      // base85 payload legitimately starts with '+', so it must not parse
      // as an added line.
      '+K}0e#0ssI2',
      '',
      'diff --git a/readme.txt b/readme.txt',
      '--- a/readme.txt',
      '+++ b/readme.txt',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '',
    ].join('\n');

    const sections = parseDiffSections(patch);
    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatchObject({
      targetPath: 'icons/logo.png',
      isBinary: true,
      isNewFile: true,
      hunks: [],
    });
    expect(sections[1]?.hunks[0]?.lines).toEqual(['-old', '+new']);
  });

  it('parses index-line blob hashes in the metadata zone', () => {
    const patch = [
      'diff --git a/icons/logo.png b/icons/logo.png',
      'index 1234567890abcdef1234567890abcdef12345678..fedcba0987654321fedcba0987654321fedcba09 100644',
      'GIT binary patch',
      'literal 100',
      '+K}0e#0ssI2',
      '',
      'diff --git a/readme.txt b/readme.txt',
      'index abc1234..def5678 100644',
      '--- a/readme.txt',
      '+++ b/readme.txt',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '',
      'diff --git a/no-index.txt b/no-index.txt',
      '--- a/no-index.txt',
      '+++ b/no-index.txt',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '',
    ].join('\n');

    const sections = parseDiffSections(patch);
    expect(sections[0]).toMatchObject({
      indexOldHash: '1234567890abcdef1234567890abcdef12345678',
      indexNewHash: 'fedcba0987654321fedcba0987654321fedcba09',
      isBinary: true,
    });
    // Abbreviated hashes (text sections) parse too, with an optional mode
    // suffix.
    expect(sections[1]).toMatchObject({ indexOldHash: 'abc1234', indexNewHash: 'def5678' });
    expect(sections[2]?.indexOldHash).toBeUndefined();
    expect(sections[2]?.indexNewHash).toBeUndefined();
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

describe('parseDiffSections binary payload detection', () => {
  const DELTA_SECTION = [
    'diff --git a/res/cert.der b/res/cert.der',
    'index 1d94f88ad7bb4e5e1b1a0c9a0f0e6d4c3b2a1908..37ae6960c3aa1b2c3d4e5f60718293a4b5c6d7e8 100644',
    'GIT binary patch',
    'literal 8',
    'PcmZQzWX><iNG$>Y29N?L',
    '',
    'literal 9',
    'QcmZQzWJ=1+ODw7c00^)Gi2wiq',
    '',
  ].join('\n');

  const STUB_SECTION = [
    'diff --git a/res/cert.der b/res/cert.der',
    'index 1d94f88ad7..37ae6960c3 100644',
    'Binary files a/res/cert.der and b/res/cert.der differ',
  ].join('\n');

  it('marks a GIT binary patch section as carrying a reconstructable delta', () => {
    const [section] = parseDiffSections(DELTA_SECTION);
    expect(section?.isBinary).toBe(true);
    expect(section?.hasBinaryDelta).toBe(true);
    expect(section?.hunks).toEqual([]);
  });

  it('marks a "Binary files … differ" stub as binary WITHOUT a delta', () => {
    const [section] = parseDiffSections(STUB_SECTION);
    expect(section?.isBinary).toBe(true);
    expect(section?.hasBinaryDelta).toBe(false);
  });

  it('still parses the index hashes off a stub, which is why hasBinaryDelta is needed', () => {
    // The stub carries a correct new-side hash. Any check keyed on the hash
    // alone concludes the recorded bytes match the live file, for a body that
    // cannot produce those bytes. That is the trap `hasBinaryDelta` closes.
    const [section] = parseDiffSections(STUB_SECTION);
    expect(section?.indexOldHash).toBe('1d94f88ad7');
    expect(section?.indexNewHash).toBe('37ae6960c3');
  });

  it('leaves hasBinaryDelta false for ordinary text sections', () => {
    const sections = parseDiffSections(MULTI_HUNK_PATCH);
    expect(sections.every((section) => !section.isBinary && !section.hasBinaryDelta)).toBe(true);
  });
});
