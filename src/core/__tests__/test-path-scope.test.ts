// SPDX-License-Identifier: EUPL-1.2
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { analyzeTestPathScopes, formatScopeNotice } from '../test-path-scope.js';

describe('analyzeTestPathScopes', () => {
  let engineDir: string;

  beforeEach(async () => {
    engineDir = await mkdtemp(join(tmpdir(), 'ff-test-scope-'));
  });

  afterEach(async () => {
    await rm(engineDir, { recursive: true, force: true });
  });

  /** Builds the drill's shape: hominis with a prefix-named sibling. */
  async function writeDrillFixture(): Promise<void> {
    const base = join(engineDir, 'browser/base/content/test');
    await mkdir(join(base, 'hominis/nested'), { recursive: true });
    await mkdir(join(base, 'hominis-tiles'), { recursive: true });
    await mkdir(join(base, 'hominess'), { recursive: true }); // NOT prefix-matching
    await writeFile(join(base, 'hominis/browser_one.js'), '');
    await writeFile(join(base, 'hominis/nested/browser_two.js'), '');
    await writeFile(join(base, 'hominis/head.js'), ''); // support file, not counted
    await writeFile(join(base, 'hominis-tiles/browser_tile.js'), '');
    await writeFile(join(base, 'hominis-tiles/test_tile_unit.js'), '');
  }

  it('dispatches a directory argument as its explicit test-file list (prefix-proof) and reports prefix siblings', async () => {
    await writeDrillFixture();

    const [scope] = await analyzeTestPathScopes(engineDir, ['browser/base/content/test/hominis']);

    expect(scope).toMatchObject({
      requestedPath: 'browser/base/content/test/hominis',
      isDirectory: true,
      testFileCount: 2, // browser_one + nested browser_two; head.js not counted
    });
    // The explicit file list is what defeats mach's prefix matching — the
    // 0.35.0 trailing-slash form still swept in hominis-tiles on Firefox
    // 153. No sibling file can appear here by construction.
    expect(scope?.dispatchPaths).toEqual([
      'browser/base/content/test/hominis/browser_one.js',
      'browser/base/content/test/hominis/nested/browser_two.js',
    ]);
    expect(scope?.siblingPrefixMatches).toEqual([
      { path: 'browser/base/content/test/hominis-tiles', testFileCount: 2 },
    ]);
  });

  it('normalizes an operator-supplied trailing slash', async () => {
    await writeDrillFixture();

    const [scope] = await analyzeTestPathScopes(engineDir, ['browser/base/content/test/hominis/']);

    expect(scope?.dispatchPaths).toEqual([
      'browser/base/content/test/hominis/browser_one.js',
      'browser/base/content/test/hominis/nested/browser_two.js',
    ]);
    expect(scope?.siblingPrefixMatches).toHaveLength(1);
  });

  it('reports no siblings when none share the name prefix', async () => {
    await writeDrillFixture();

    const [scope] = await analyzeTestPathScopes(engineDir, [
      'browser/base/content/test/hominis-tiles',
    ]);

    expect(scope?.dispatchPaths).toEqual([
      'browser/base/content/test/hominis-tiles/browser_tile.js',
      'browser/base/content/test/hominis-tiles/test_tile_unit.js',
    ]);
    expect(scope?.siblingPrefixMatches).toEqual([]);
  });

  it('enumerates MochiKit HTML/XHTML tests instead of falling back to prefix-matched directory dispatch', async () => {
    const base = join(engineDir, 'toolkit/content/tests/widgets');
    await mkdir(base, { recursive: true });
    await writeFile(join(base, 'test_moz-widget.html'), '');
    await writeFile(join(base, 'test_moz-panel.xhtml'), '');
    await writeFile(join(base, 'chrome.toml'), '');

    const [scope] = await analyzeTestPathScopes(engineDir, ['toolkit/content/tests/widgets']);

    expect(scope).toMatchObject({
      isDirectory: true,
      testFileCount: 2,
    });
    expect(scope?.dispatchPaths).toEqual([
      'toolkit/content/tests/widgets/test_moz-panel.xhtml',
      'toolkit/content/tests/widgets/test_moz-widget.html',
    ]);
  });

  it('falls back to the trailing-slash directory form when no test files are enumerable', async () => {
    const base = join(engineDir, 'browser/base/content/test');
    await mkdir(join(base, 'hominis'), { recursive: true });
    await writeFile(join(base, 'hominis/head.js'), ''); // support file only

    const [scope] = await analyzeTestPathScopes(engineDir, ['browser/base/content/test/hominis']);

    expect(scope).toMatchObject({
      dispatchPaths: ['browser/base/content/test/hominis/'],
      isDirectory: true,
      testFileCount: 0,
    });
  });

  it('ignores prefix siblings that contain no test files', async () => {
    const base = join(engineDir, 'browser/base/content/test');
    await mkdir(join(base, 'hominis'), { recursive: true });
    await mkdir(join(base, 'hominis-assets'), { recursive: true });
    await writeFile(join(base, 'hominis/browser_one.js'), '');
    await writeFile(join(base, 'hominis-assets/icon.svg'), '');

    const [scope] = await analyzeTestPathScopes(engineDir, ['browser/base/content/test/hominis']);

    expect(scope?.siblingPrefixMatches).toEqual([]);
  });

  it('passes file arguments through untouched', async () => {
    const base = join(engineDir, 'browser/base/content/test/hominis');
    await mkdir(base, { recursive: true });
    await writeFile(join(base, 'browser_one.js'), '');

    const [scope] = await analyzeTestPathScopes(engineDir, [
      'browser/base/content/test/hominis/browser_one.js',
    ]);

    expect(scope).toMatchObject({
      dispatchPaths: ['browser/base/content/test/hominis/browser_one.js'],
      isDirectory: false,
      siblingPrefixMatches: [],
    });
  });

  it('passes non-existent paths through untouched (existence is asserted elsewhere)', async () => {
    const [scope] = await analyzeTestPathScopes(engineDir, ['no/such/dir']);

    expect(scope).toMatchObject({ dispatchPaths: ['no/such/dir'], isDirectory: false });
  });
});

describe('formatScopeNotice', () => {
  it('describes the explicit-file-list mechanism and the excluded siblings with counts', () => {
    const notice = formatScopeNotice({
      requestedPath: 'browser/base/content/test/hominis',
      dispatchPaths: ['browser/base/content/test/hominis/browser_one.js'],
      isDirectory: true,
      testFileCount: 198,
      siblingPrefixMatches: [
        { path: 'browser/base/content/test/hominis-tiles', testFileCount: 1026 },
      ],
    });

    expect(notice).toContain('Selected exactly browser/base/content/test/hominis/');
    expect(notice).toContain('198 test files');
    expect(notice).toContain('explicitly to mach');
    expect(notice).toContain('hominis-tiles/ (1026 test files)');
    expect(notice).toContain('separate paths');
  });

  it('does not claim exclusion on the zero-file directory fallback, where prefix matching still applies', () => {
    const notice = formatScopeNotice({
      requestedPath: 'a/dir',
      dispatchPaths: ['a/dir/'],
      isDirectory: true,
      testFileCount: 0,
      siblingPrefixMatches: [{ path: 'a/dir-extras', testFileCount: 5 }],
    });

    expect(notice).not.toContain('Excluded');
    expect(notice).toContain('may also select');
    expect(notice).toContain('a/dir-extras/ (5 test files)');
  });

  it('returns undefined for file arguments and directories without prefix siblings', () => {
    expect(
      formatScopeNotice({
        requestedPath: 'a/browser_x.js',
        dispatchPaths: ['a/browser_x.js'],
        isDirectory: false,
        testFileCount: 0,
        siblingPrefixMatches: [],
      })
    ).toBeUndefined();
    expect(
      formatScopeNotice({
        requestedPath: 'a/dir',
        dispatchPaths: ['a/dir/x_browser_one.js'],
        isDirectory: true,
        testFileCount: 3,
        siblingPrefixMatches: [],
      })
    ).toBeUndefined();
  });
});
