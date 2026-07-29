// SPDX-License-Identifier: EUPL-1.2
/**
 * Pins the `mozbuild-unsorted-list` per-patch check (FORGE F2): an unsorted
 * `EXTRA_JS_MODULES` insertion previously surfaced only as
 * `mozbuild.util.UnsortedError` at configure time, after a multi-minute
 * build had already been dispatched.
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
    // "HominisAppearance" ('e' = 0x65); mozbuild compares case-insensitively
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
});
