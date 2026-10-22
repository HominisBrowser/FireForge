// SPDX-License-Identifier: EUPL-1.2
/**
 * Pins the `mozbuild-unsorted-list` per-patch check: without it an unsorted
 * `EXTRA_JS_MODULES` insertion surfaces only as
 * `mozbuild.util.UnsortedError` at configure time, after a multi-minute
 * build has already been dispatched.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeFiles } from '../../test-utils/index.js';
import { lintMozBuildSortedLists } from '../patch-lint-mozbuild.js';

describe('lintMozBuildSortedLists', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), 'ff-mozbuild-lint-'));
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('passes a sorted EXTRA_JS_MODULES list', async () => {
    await writeFiles(repoDir, {
      'browser/modules/moz.build': [
        'EXTRA_JS_MODULES += [',
        '    "Alpha.sys.mjs",',
        '    "Beta.sys.mjs",',
        ']',
        '',
      ].join('\n'),
    });

    const issues = await lintMozBuildSortedLists(repoDir, ['browser/modules/moz.build']);
    expect(issues).toEqual([]);
  });

  it('reports the exact expected/got pair for an unsorted insertion', async () => {
    await writeFiles(repoDir, {
      'browser/modules/moz.build': [
        'EXTRA_JS_MODULES += [',
        '    "Beta.sys.mjs",',
        '    "Alpha.sys.mjs",',
        ']',
        '',
      ].join('\n'),
    });

    const issues = await lintMozBuildSortedLists(repoDir, ['browser/modules/moz.build']);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe('mozbuild-unsorted-list');
    expect(issues[0]?.severity).toBe('error');
    expect(issues[0]?.message).toContain(
      'EXTRA_JS_MODULES is not alphabetically sorted: expected "Alpha.sys.mjs" but got "Beta.sys.mjs"'
    );
    expect(issues[0]?.message).toContain('UnsortedError');
  });

  it('compares case-insensitively, matching mozbuild semantics', async () => {
    // Byte order would demand "HominisAppMenu" ('M' = 0x4D) before
    // "HominisAppearance" ('e' = 0x65). Mozbuild compares case-insensitively
    // ("appe" < "appm"), so this list is correctly sorted and must pass.
    await writeFiles(repoDir, {
      'moz.build': [
        'EXTRA_JS_MODULES += [',
        '    "HominisAppearance.sys.mjs",',
        '    "HominisAppMenu.sys.mjs",',
        ']',
        '',
      ].join('\n'),
    });

    const issues = await lintMozBuildSortedLists(repoDir, ['moz.build']);
    expect(issues).toEqual([]);
  });

  it('flags dotted-namespace lists and names the full variable', async () => {
    await writeFiles(repoDir, {
      'browser/modules/moz.build': [
        'EXTRA_JS_MODULES.hominis += [',
        '    "Zeta.sys.mjs",',
        '    "Alpha.sys.mjs",',
        ']',
        '',
      ].join('\n'),
    });

    const issues = await lintMozBuildSortedLists(repoDir, ['browser/modules/moz.build']);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('EXTRA_JS_MODULES.hominis');
  });

  it('checks every list in a file independently', async () => {
    await writeFiles(repoDir, {
      'moz.build': [
        'EXTRA_JS_MODULES += [',
        '    "Alpha.sys.mjs",',
        '    "Beta.sys.mjs",',
        ']',
        '',
        'TESTING_JS_MODULES += [',
        '    "ZTest.sys.mjs",',
        '    "ATest.sys.mjs",',
        ']',
        '',
      ].join('\n'),
    });

    const issues = await lintMozBuildSortedLists(repoDir, ['moz.build']);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('TESTING_JS_MODULES');
  });

  it('handles single-line and empty lists without noise', async () => {
    await writeFiles(repoDir, {
      'moz.build': [
        'EXTRA_JS_MODULES += []',
        'TESTING_JS_MODULES += ["B.sys.mjs", "A.sys.mjs"]',
        '',
      ].join('\n'),
    });

    const issues = await lintMozBuildSortedLists(repoDir, ['moz.build']);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('expected "A.sys.mjs" but got "B.sys.mjs"');
  });

  it('does not flag DIRS (order-meaningful, not strict-ordered)', async () => {
    await writeFiles(repoDir, {
      'moz.build': ['DIRS += [', '    "zebra",', '    "alpha",', ']', ''].join('\n'),
    });

    const issues = await lintMozBuildSortedLists(repoDir, ['moz.build']);
    expect(issues).toEqual([]);
  });

  it('ignores an unterminated list instead of misreporting it', async () => {
    await writeFiles(repoDir, {
      'moz.build': ['EXTRA_JS_MODULES += [', '    "B.sys.mjs",', '    "A.sys.mjs",', ''].join('\n'),
    });

    const issues = await lintMozBuildSortedLists(repoDir, ['moz.build']);
    expect(issues).toEqual([]);
  });

  it('handles items starting on the opener line with a multi-line tail', async () => {
    await writeFiles(repoDir, {
      'moz.build': ['EXTRA_JS_MODULES += ["B.sys.mjs",', '    "A.sys.mjs",', ']', ''].join('\n'),
    });

    const issues = await lintMozBuildSortedLists(repoDir, ['moz.build']);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('expected "A.sys.mjs" but got "B.sys.mjs"');
  });

  it('skips non-moz.build files and missing files', async () => {
    await writeFiles(repoDir, {
      'browser/modules/Foo.sys.mjs': 'EXTRA_JS_MODULES += ["B", "A"]\n',
    });

    const issues = await lintMozBuildSortedLists(repoDir, [
      'browser/modules/Foo.sys.mjs',
      'browser/missing/moz.build',
    ]);
    expect(issues).toEqual([]);
  });

  it('ignores quoted strings inside trailing comments (phantom items)', async () => {
    // `"Beta.sys.mjs"` lives in a comment, not the list. Scraping it in produced
    // an unsorted-list report naming a file that is not in the list, with a
    // fingerprint that could never stabilise because the item does not exist
    // to be moved.
    await writeFiles(repoDir, {
      'browser/modules/moz.build': [
        'EXTRA_JS_MODULES += [',
        '    "Alpha.sys.mjs",',
        '    "Zeta.sys.mjs",  # replaces "Beta.sys.mjs" upstream',
        ']',
        '',
      ].join('\n'),
    });

    const issues = await lintMozBuildSortedLists(repoDir, ['browser/modules/moz.build']);
    expect(issues).toEqual([]);
  });

  it('does not let a bracket inside a comment truncate the list', async () => {
    // `foo[0]` in a comment must not close the list early, or `Alpha.cpp`
    // never enters the item set and the real disorder goes unreported.
    await writeFiles(repoDir, {
      'browser/modules/moz.build': [
        'EXTRA_JS_MODULES += [',
        '    "Zeta.sys.mjs",  # see foo[0] for context',
        '    "Alpha.sys.mjs",',
        ']',
        '',
      ].join('\n'),
    });

    const issues = await lintMozBuildSortedLists(repoDir, ['browser/modules/moz.build']);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('Alpha.sys.mjs');
  });

  it('does not let a bracket inside a quoted item close the list', async () => {
    // `"icons[2x].png"` is filename text. Reading its `]` as the list close
    // truncated the item set, so the out-of-order `Alpha.png` below it never
    // entered the comparison and the disorder went unreported.
    await writeFiles(repoDir, {
      'browser/modules/moz.build': [
        'EXTRA_JS_MODULES += [',
        '    "icons[2x].png",',
        '    "Alpha.png",',
        ']',
        '',
      ].join('\n'),
    });

    const issues = await lintMozBuildSortedLists(repoDir, ['browser/modules/moz.build']);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('Alpha.png');
  });

  it('pairs quote types, so an apostrophe inside a double-quoted item is not a delimiter', async () => {
    // The old single character-class regex closed the match at the apostrophe,
    // scraping in a phantom `don` item that reported a disorder against an
    // item the list does not contain.
    await writeFiles(repoDir, {
      'browser/modules/moz.build': [
        'EXTRA_JS_MODULES += [',
        '    "don\'t.sys.mjs",',
        '    "later.sys.mjs",',
        ']',
        '',
      ].join('\n'),
    });

    const issues = await lintMozBuildSortedLists(repoDir, ['browser/modules/moz.build']);
    expect(issues).toEqual([]);
  });

  it('keeps a # inside a quoted item', async () => {
    await writeFiles(repoDir, {
      'browser/modules/moz.build': [
        'EXTRA_JS_MODULES += [',
        '    "Alpha#1.sys.mjs",',
        '    "Beta.sys.mjs",',
        ']',
        '',
      ].join('\n'),
    });

    const issues = await lintMozBuildSortedLists(repoDir, ['browser/modules/moz.build']);
    expect(issues).toEqual([]);
  });

  it('still checks lists that follow an unterminated one', async () => {
    // An unterminated list must not advance the outer loop counter past
    // end-of-file, or every later list in the file is skipped.
    await writeFiles(repoDir, {
      'browser/modules/moz.build': [
        'EXTRA_JS_MODULES += [',
        '    "Broken.sys.mjs",',
        '',
        'EXTRA_JS_MODULES += [',
        '    "Zeta.sys.mjs",',
        '    "Alpha.sys.mjs",',
        ']',
        '',
      ].join('\n'),
    });

    const issues = await lintMozBuildSortedLists(repoDir, ['browser/modules/moz.build']);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('Alpha.sys.mjs');
  });

  it('does not let an unterminated list borrow the next list’s bracket', async () => {
    // Two different variables, and the second list is correctly sorted. A
    // forward scan that reads straight through the second opener merges its
    // items into the first list and accepts its `]` as the first list's
    // close. That reports a sorting error against EXTRA_COMPONENTS for items
    // that only ever belong to EXTRA_JS_MODULES, and skips the second list.
    // The test above cannot catch this because both of its lists share one
    // variable name and it only asserts on an item name.
    await writeFiles(repoDir, {
      'browser/modules/moz.build': [
        'EXTRA_COMPONENTS += [',
        '    "Broken.js",',
        '',
        'EXTRA_JS_MODULES += [',
        '    "Alpha.sys.mjs",',
        '    "Zeta.sys.mjs",',
        ']',
        '',
      ].join('\n'),
    });

    const issues = await lintMozBuildSortedLists(repoDir, ['browser/modules/moz.build']);
    expect(issues).toEqual([]);
  });

  it('reports the SECOND list against its own variable when the first never closes', async () => {
    await writeFiles(repoDir, {
      'browser/modules/moz.build': [
        'EXTRA_COMPONENTS += [',
        '    "Broken.js",',
        '',
        'EXTRA_JS_MODULES += [',
        '    "Zeta.sys.mjs",',
        '    "Alpha.sys.mjs",',
        ']',
        '',
      ].join('\n'),
    });

    const issues = await lintMozBuildSortedLists(repoDir, ['browser/modules/moz.build']);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('moz.build list EXTRA_JS_MODULES');
    expect(issues[0]?.fingerprint).toContain('|EXTRA_JS_MODULES|');
  });
});
