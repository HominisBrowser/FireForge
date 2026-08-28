// SPDX-License-Identifier: EUPL-1.2
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureDir, writeText } from '../../utils/fs.js';
import {
  countTrailingSegmentMatches,
  findAllByBasename,
  isTestPath,
  resolveBestArtifact,
  scoreCandidate,
} from '../build-audit-resolve.js';

describe('isTestPath', () => {
  it.each([
    ['browser/modules/mybrowser/test/browser_startup.js', true],
    ['browser/components/tests/unit/test_loader.js', true],
    ['toolkit/components/tests/xpcshell/test_observer.js', true],
    ['browser/base/content/test/general/browser_foo.js', true],
    ['browser/base/content/test/widgets/xpcshell.toml', true],
    ['browser/base/content/test/widgets/browser.ini', true],
    // `testing/` subtree — mochitest / marionette / xpcshell harness
    // sources ship under `_tests/`, not `dist/`. Without these matches,
    // patches that touch e.g. `testing/mochitest/api.js` produce
    // "no packaged artifact under dist/" warnings on every build.
    ['testing/mochitest/BrowserTestUtils/BrowserTestUtils.sys.mjs', true],
    ['testing/mochitest/api.js', true],
    ['testing/marionette/client/marionette_driver/foo.py', true],
    ['testing/xpcshell/head.js', true],
    // Interior `/testing/` segment — vendored harness trees should also
    // route to `_tests/` rather than the package bundle.
    ['third_party/foo/testing/harness.js', true],
  ])('returns true for test-shaped path %s', (path) => {
    expect(isTestPath(path)).toBe(true);
  });

  it.each([
    ['browser/app/profile/mybrowser.js', false],
    ['browser/branding/mybrowser/content/aboutDialog.css', false],
    ['toolkit/locales/en-US/global/strings.ftl', false],
    ['browser/base/content/main.xhtml', false],
    // `testing-tools/` is not the `testing/` subtree — only an exact
    // segment match qualifies. Guards against over-broad substring match.
    ['testing-tools/lint/eslint.config.js', false],
  ])('returns false for non-test path %s', (path) => {
    expect(isTestPath(path)).toBe(false);
  });
});

describe('countTrailingSegmentMatches', () => {
  it('returns 1 when only basenames match', () => {
    expect(
      countTrailingSegmentMatches(
        'browser/branding/mybrowser/content/aboutDialog.css',
        'dist/bin/browser/chrome/browser/content/browser/aboutDialog.css'
      )
    ).toBe(1);
  });

  it('returns more when multiple trailing segments match', () => {
    expect(
      countTrailingSegmentMatches(
        'browser/branding/mybrowser/content/aboutDialog.css',
        'dist/bin/browser/chrome/branding/content/aboutDialog.css'
      )
    ).toBe(2);
  });

  it('returns 0 when basenames differ', () => {
    expect(countTrailingSegmentMatches('a/b/c.js', 'd/e/f.js')).toBe(0);
  });

  // The candidate side is built by `join()` over a `readdir` walk, so on
  // Windows it arrives backslash-separated. A `/`-only split makes the whole
  // candidate ONE segment, which scores every same-basename hit identically
  // and lets the resolver pick an arbitrary artifact.
  it('counts segments the same when a path arrives backslash-separated', () => {
    expect(
      countTrailingSegmentMatches(
        'browser/branding/mybrowser/content/aboutDialog.css',
        'dist\\bin\\browser\\chrome\\branding\\content\\aboutDialog.css'
      )
    ).toBe(2);
  });
});

describe('scoreCandidate', () => {
  it('rewards a candidate whose path contains a meaningful source segment', () => {
    const source = 'browser/branding/mybrowser/content/aboutDialog.css';
    const correctCandidate = '/dist/bin/browser/chrome/browser/content/branding/aboutDialog.css';
    const wrongCandidate = '/dist/bin/browser/chrome/browser/content/browser/aboutDialog.css';

    expect(scoreCandidate(source, correctCandidate)).toBeGreaterThan(
      scoreCandidate(source, wrongCandidate)
    );
  });

  it('ranks a backslash-separated candidate exactly as its POSIX form', () => {
    const source = 'browser/branding/mybrowser/content/aboutDialog.css';
    const posixCandidate = '/dist/bin/browser/chrome/browser/content/branding/aboutDialog.css';
    const windowsCandidate =
      '\\dist\\bin\\browser\\chrome\\browser\\content\\branding\\aboutDialog.css';

    expect(scoreCandidate(source, windowsCandidate)).toBe(scoreCandidate(source, posixCandidate));
  });

  it('does not boost generic segments like "content" or "chrome"', () => {
    const source = 'browser/foo/bar.js';
    // Both candidates include the generic "content" segment but neither
    // should get a unique-segment bonus from it.
    const a = '/dist/bin/content/x/bar.js';
    const b = '/dist/bin/content/y/bar.js';
    expect(scoreCandidate(source, a)).toBe(scoreCandidate(source, b));
  });
});

describe('findAllByBasename', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ff-resolve-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('finds every file with a matching basename', async () => {
    await ensureDir(join(root, 'a/b'));
    await ensureDir(join(root, 'a/c'));
    await writeText(join(root, 'a/b/foo.js'), '');
    await writeText(join(root, 'a/c/foo.js'), '');
    await writeText(join(root, 'a/c/bar.js'), '');

    const found = await findAllByBasename(root, 'foo.js');
    expect(found).toHaveLength(2);
    expect(found.every((p) => p.endsWith('foo.js'))).toBe(true);
  });

  it('skips dotfile directories', async () => {
    await ensureDir(join(root, '.cache/sub'));
    await ensureDir(join(root, 'visible'));
    await writeText(join(root, '.cache/sub/foo.js'), '');
    await writeText(join(root, 'visible/foo.js'), '');

    const found = await findAllByBasename(root, 'foo.js');
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('visible');
  });

  it('returns empty when the root does not exist', async () => {
    const found = await findAllByBasename(join(root, 'missing'), 'foo.js');
    expect(found).toEqual([]);
  });
});

describe('resolveBestArtifact', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ff-resolve-best-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('picks the highest-scoring candidate when basenames collide', async () => {
    await ensureDir(join(root, 'chrome/browser/content/branding'));
    await ensureDir(join(root, 'chrome/browser/content/browser'));
    const correct = join(root, 'chrome/browser/content/branding/aboutDialog.css');
    const wrong = join(root, 'chrome/browser/content/browser/aboutDialog.css');
    await writeText(correct, 'a');
    await writeText(wrong, 'b');

    const best = await resolveBestArtifact('browser/branding/mybrowser/content/aboutDialog.css', [
      root,
    ]);
    expect(best).toBe(correct);
  });

  it('returns undefined when no candidate exists', async () => {
    const best = await resolveBestArtifact('browser/foo/bar.js', [root]);
    expect(best).toBeUndefined();
  });

  it('returns the only candidate without invoking the scorer', async () => {
    await ensureDir(join(root, 'sub'));
    const only = join(root, 'sub/unique.js');
    await writeText(only, 'x');
    const best = await resolveBestArtifact('engine/path/unique.js', [root]);
    expect(best).toBe(only);
  });

  it('searches multiple roots in order', async () => {
    const second = join(root, 'second');
    await ensureDir(join(root, 'first'));
    await ensureDir(second);
    await writeText(join(second, 'only.js'), 'x');

    const best = await resolveBestArtifact('engine/foo/only.js', [join(root, 'first'), second]);
    expect(best).toContain('second');
  });
});
