// SPDX-License-Identifier: EUPL-1.2
import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/logger.js', () => ({
  info: vi.fn(),
  warn: vi.fn(),
  verbose: vi.fn(),
}));

import { ensureDir, writeText } from '../../utils/fs.js';
import { info, verbose, warn } from '../../utils/logger.js';
import { auditBuildArtifacts, isPackageablePath } from '../build-audit.js';
import type { BuildBaseline } from '../build-baseline.js';
import * as git from '../git.js';
import * as gitBase from '../git-base.js';
import * as gitStatus from '../git-status.js';

describe('isPackageablePath', () => {
  it.each([
    ['browser/app/profile/mybrowser.js', true],
    ['browser/components/foo.mjs', true],
    ['browser/themes/shared/mybrowser.css', true],
    ['toolkit/locales/en-US/toolkit/global/strings.ftl', true],
    ['browser/base/content/main.xhtml', true],
    ['browser/app/profile/README', true], // path fragment hits /app/profile/
  ])('returns true for packaged path %s', (path, expected) => {
    expect(isPackageablePath(path)).toBe(expected);
  });

  it.each([
    ['obj-debug/dist/mybrowser.app/something.js', false],
    ['browser/node_modules/lib.js', false],
    ['.git/index', false],
    ['tools/script.py', false],
    ['docs/readme.md', false],
    // Build inputs are consumed by the build, never themselves packaged.
    // Auditing them used to false-flag every edit and, worse, false-match
    // unrelated upstream files of the same basename as "stale".
    ['browser/branding/mybrowser/locales/jar.mn', false],
    ['browser/branding/mybrowser/locales/moz.build', false],
    ['browser/moz.build', false],
    ['browser/app/Makefile.in', false],
    ['build/moz.configure', false],
    // `.inc.xhtml` fragments are consumed via `#include` from a
    // registered chrome document; they never ship as a standalone
    // packaged artifact. 2026-04-21 eval (Finding #11): `wire --dom`
    // generated a `.inc.xhtml`, the build audit then flagged it as
    // "missing packaged artifact" on the next UI build. The carve-out
    // keeps the two sibling checks (`register` + `build audit`)
    // consistent about this file type.
    ['browser/base/content/freshforge-sidebar.inc.xhtml', false],
  ])('returns false for non-packaged path %s', (path, expected) => {
    expect(isPackageablePath(path)).toBe(expected);
  });
});

describe('auditBuildArtifacts', () => {
  let engineDir: string;
  const warnMock = vi.mocked(warn);
  const infoMock = vi.mocked(info);
  const verboseMock = vi.mocked(verbose);

  beforeEach(async () => {
    engineDir = await mkdtemp(join(tmpdir(), 'ff-audit-'));
    warnMock.mockClear();
    infoMock.mockClear();
    verboseMock.mockClear();
  });

  afterEach(async () => {
    await rm(engineDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns zeroed summary when there is no dist tree', async () => {
    const summary = await auditBuildArtifacts('/project', engineDir, undefined);
    expect(summary).toEqual({ updated: 0, stale: 0, missing: 0, skipped: 0, entries: [] });
  });

  it('warns when a packageable source has no matching artifact in the bundle', async () => {
    // Create the unpacked source plus a packaged source first, then the dist
    // copy AFTER so the dist mtime is newer than the source (the "updated"
    // post-build state). Otherwise the packaged source counts as "stale".
    await ensureDir(join(engineDir, 'browser/app/profile'));
    const unpackaged = 'browser/app/profile/unpackaged.js';
    const packaged = 'browser/app/profile/already-packaged.js';
    await writeText(join(engineDir, unpackaged), 'const y = 2;');
    await writeText(join(engineDir, packaged), 'const x = 1;');

    const dist = join(engineDir, 'obj-debug', 'dist');
    await ensureDir(dist);
    await writeText(join(dist, 'already-packaged.js'), 'const x = 1;');
    // Ensure dist artifact mtime is strictly newer than the source.
    const now = new Date();
    const pastSource = new Date(now.getTime() - 5_000);
    await utimes(join(engineDir, packaged), pastSource, pastSource);
    await utimes(join(engineDir, unpackaged), pastSource, pastSource);
    await utimes(join(dist, 'already-packaged.js'), now, now);

    // Stub out git so the file list is deterministic.
    vi.spyOn(git, 'hasChanges').mockResolvedValue(true);
    vi.spyOn(gitStatus, 'getUntrackedFiles').mockResolvedValue([unpackaged, packaged]);
    vi.spyOn(gitBase, 'git').mockResolvedValue('');

    const summary = await auditBuildArtifacts('/project', engineDir, undefined);
    expect(summary.missing).toBe(1);
    expect(summary.updated).toBe(1);
    expect(summary.entries.some((e) => e.source === unpackaged && e.status === 'missing')).toBe(
      true
    );
    expect(warnMock).toHaveBeenCalled();
  });

  it('flags a stale artifact when engine source is newer than the packaged file', async () => {
    const dist = join(engineDir, 'obj-debug', 'dist');
    // Place the packaged artifact under a subtree that shares the source's
    // immediate parent directory so the confident-match check keeps the
    // `stale` classification rather than downgrading to `missing`.
    await ensureDir(join(dist, 'profile'));
    await ensureDir(join(engineDir, 'browser/app/profile'));

    const source = 'browser/app/profile/p.js';
    await writeText(join(engineDir, source), 'new');
    await writeText(join(dist, 'profile/p.js'), 'old');

    // Make the artifact older than the source.
    const past = new Date(Date.now() - 10_000);
    const future = new Date();
    await utimes(join(dist, 'profile/p.js'), past, past);
    await utimes(join(engineDir, source), future, future);

    vi.spyOn(git, 'hasChanges').mockResolvedValue(true);
    vi.spyOn(gitStatus, 'getUntrackedFiles').mockResolvedValue([source]);
    vi.spyOn(gitBase, 'git').mockResolvedValue('');

    const summary = await auditBuildArtifacts('/project', engineDir, undefined);
    expect(summary.stale).toBe(1);
    expect(summary.updated).toBe(0);
    expect(summary.missing).toBe(0);
    expect(warnMock).toHaveBeenCalledWith(
      expect.stringMatching(/stale|newer than its packaged artifact/)
    );
  });

  it('skips files whose path is not packageable', async () => {
    const dist = join(engineDir, 'obj-debug', 'dist');
    await ensureDir(dist);

    const nonPackageable = 'tools/ci.py';
    vi.spyOn(git, 'hasChanges').mockResolvedValue(true);
    vi.spyOn(gitStatus, 'getUntrackedFiles').mockResolvedValue([nonPackageable]);
    vi.spyOn(gitBase, 'git').mockResolvedValue('');

    const summary = await auditBuildArtifacts('/project', engineDir, undefined);
    expect(summary.skipped).toBe(1);
  });

  it('skips a file that disappeared after the diff was computed', async () => {
    const dist = join(engineDir, 'obj-debug', 'dist');
    await ensureDir(dist);
    await ensureDir(join(engineDir, 'browser/app/profile'));

    const ghost = 'browser/app/profile/deleted.js';
    // Do NOT create the file on disk.
    vi.spyOn(git, 'hasChanges').mockResolvedValue(true);
    vi.spyOn(gitStatus, 'getUntrackedFiles').mockResolvedValue([ghost]);
    vi.spyOn(gitBase, 'git').mockResolvedValue('');

    const summary = await auditBuildArtifacts('/project', engineDir, undefined);
    expect(summary.skipped).toBe(1);
    expect(summary.missing).toBe(0);
    expect(summary.stale).toBe(0);
  });

  it('falls back to workdir-only diff when git sub-calls throw', async () => {
    const dist = join(engineDir, 'obj-debug', 'dist');
    await ensureDir(dist);

    vi.spyOn(git, 'hasChanges').mockRejectedValue(new Error('git unavailable'));
    vi.spyOn(gitBase, 'git').mockRejectedValue(new Error('git unavailable'));
    vi.spyOn(gitStatus, 'getUntrackedFiles').mockRejectedValue(new Error('git unavailable'));

    const baseline: BuildBaseline = {
      engineHeadSha: 'abc',
      builtAt: new Date().toISOString(),
      binaryName: 'mybrowser',
    };
    const summary = await auditBuildArtifacts('/project', engineDir, baseline);
    expect(summary).toEqual({ updated: 0, stale: 0, missing: 0, skipped: 0, entries: [] });
    expect(verboseMock).toHaveBeenCalled();
  });

  it('uses the baseline SHA to diff when provided', async () => {
    const dist = join(engineDir, 'obj-debug', 'dist');
    await ensureDir(dist);

    const gitMock = vi.spyOn(gitBase, 'git').mockImplementation((args: string[]) => {
      if (args.includes('abc..HEAD')) {
        return Promise.resolve('browser/app/profile/committed.js\n');
      }
      return Promise.resolve('');
    });
    vi.spyOn(git, 'hasChanges').mockResolvedValue(false);
    vi.spyOn(gitStatus, 'getUntrackedFiles').mockResolvedValue([]);

    await ensureDir(join(engineDir, 'browser/app/profile'));
    await writeText(join(engineDir, 'browser/app/profile/committed.js'), 'x');

    const baseline: BuildBaseline = {
      engineHeadSha: 'abc',
      builtAt: new Date().toISOString(),
      binaryName: 'mybrowser',
    };
    const summary = await auditBuildArtifacts('/project', engineDir, baseline);
    expect(gitMock).toHaveBeenCalledWith(
      expect.arrayContaining(['diff', '--name-only', 'abc..HEAD']),
      engineDir
    );
    expect(summary.missing).toBe(1);
  });

  it('skips build-input files (jar.mn, moz.build) instead of false-flagging them as missing', async () => {
    const dist = join(engineDir, 'obj-debug', 'dist');
    await ensureDir(dist);
    await ensureDir(join(engineDir, 'browser/branding/mybrowser/locales'));

    const jarMn = 'browser/branding/mybrowser/locales/jar.mn';
    const mozBuild = 'browser/branding/mybrowser/locales/moz.build';
    await writeText(join(engineDir, jarMn), 'browser.jar:');
    await writeText(join(engineDir, mozBuild), '');

    // A coincidentally-named upstream moz.build that the OLD basename
    // matcher would have found and false-flagged as the artifact for
    // the branding moz.build above.
    await writeText(join(dist, 'moz.build'), '');

    vi.spyOn(git, 'hasChanges').mockResolvedValue(true);
    vi.spyOn(gitStatus, 'getUntrackedFiles').mockResolvedValue([jarMn, mozBuild]);
    vi.spyOn(gitBase, 'git').mockResolvedValue('');

    const summary = await auditBuildArtifacts('/project', engineDir, undefined);
    expect(summary.skipped).toBe(2);
    expect(summary.missing).toBe(0);
    expect(summary.stale).toBe(0);
    // No warnings about jar.mn or moz.build should have fired.
    const warnings = warnMock.mock.calls.map(([m]) => m);
    expect(warnings.some((m) => m.includes('jar.mn'))).toBe(false);
    expect(warnings.some((m) => m.includes('moz.build'))).toBe(false);
  });

  it('disambiguates same-basename collisions by trailing-segment overlap', async () => {
    // Source: branding override at branding/<name>/content/aboutDialog.css
    // Two artifact candidates in dist/:
    //   (a) chrome/browser/content/branding/aboutDialog.css  ← correct
    //   (b) chrome/browser/content/browser/aboutDialog.css   ← unrelated upstream
    // The OLD audit took whichever the directory walk happened to hit first.
    await ensureDir(join(engineDir, 'browser/branding/mybrowser/content'));
    const source = 'browser/branding/mybrowser/content/aboutDialog.css';
    await writeText(join(engineDir, source), 'branded');

    const distRoot = join(engineDir, 'obj-debug', 'dist');
    await ensureDir(join(distRoot, 'bin/browser/chrome/browser/content/branding'));
    await ensureDir(join(distRoot, 'bin/browser/chrome/browser/content/browser'));
    const correctArtifact = join(
      distRoot,
      'bin/browser/chrome/browser/content/branding/aboutDialog.css'
    );
    const wrongArtifact = join(
      distRoot,
      'bin/browser/chrome/browser/content/browser/aboutDialog.css'
    );
    await writeText(correctArtifact, 'branded');
    await writeText(wrongArtifact, 'upstream');

    // Make both artifacts newer than the source so neither would be stale.
    const past = new Date(Date.now() - 5_000);
    const now = new Date();
    await utimes(join(engineDir, source), past, past);
    await utimes(correctArtifact, now, now);
    await utimes(wrongArtifact, now, now);

    vi.spyOn(git, 'hasChanges').mockResolvedValue(true);
    vi.spyOn(gitStatus, 'getUntrackedFiles').mockResolvedValue([source]);
    vi.spyOn(gitBase, 'git').mockResolvedValue('');

    const summary = await auditBuildArtifacts('/project', engineDir, undefined);
    expect(summary.updated).toBe(1);
    expect(summary.entries[0]?.artifact).toBe(correctArtifact);
  });

  it('routes test sources to _tests/ instead of dist/', async () => {
    // Test files (browser_*.js, test_*.js) live under _tests/ after mach
    // copies them. Looking only in dist/ produced a guaranteed false positive
    // for every registered test.
    const distRoot = join(engineDir, 'obj-debug', 'dist');
    const testsRoot = join(engineDir, 'obj-debug', '_tests');
    await ensureDir(distRoot);
    await ensureDir(join(testsRoot, 'testing/mochitest/browser/browser/modules/mybrowser/test'));
    await ensureDir(join(engineDir, 'browser/modules/mybrowser/test'));
    // `mach package-tests` leaves `all-tests.json` at the _tests root.
    // The audit uses its presence as the signal that the full test-packaging
    // step ran this build; without it, test-path audits are skipped.
    await writeText(join(testsRoot, 'all-tests.json'), '{}');

    const source = 'browser/modules/mybrowser/test/browser_mybrowser_startup.js';
    await writeText(join(engineDir, source), 'test');
    const artifact = join(
      testsRoot,
      'testing/mochitest/browser/browser/modules/mybrowser/test/browser_mybrowser_startup.js'
    );
    await writeText(artifact, 'test');

    const past = new Date(Date.now() - 5_000);
    const now = new Date();
    await utimes(join(engineDir, source), past, past);
    await utimes(artifact, now, now);

    vi.spyOn(git, 'hasChanges').mockResolvedValue(true);
    vi.spyOn(gitStatus, 'getUntrackedFiles').mockResolvedValue([source]);
    vi.spyOn(gitBase, 'git').mockResolvedValue('');

    const summary = await auditBuildArtifacts('/project', engineDir, undefined);
    expect(summary.updated).toBe(1);
    expect(summary.missing).toBe(0);
    expect(summary.entries[0]?.artifact).toBe(artifact);
  });

  it('skips files gated off by an enclosing if-CONFIG block in moz.build', async () => {
    // Windows-only stubinstaller CSS is referenced from a moz.build block
    // gated on `if CONFIG["MAKENSISU"]:`. On macOS the file never appears
    // in dist/, but the audit should not warn about it — it is
    // platform-excluded, not silently dropped.
    const dist = join(engineDir, 'obj-debug', 'dist');
    await ensureDir(dist);
    await ensureDir(join(engineDir, 'browser/branding/mybrowser/stubinstaller'));
    await writeText(
      join(engineDir, 'browser/branding/mybrowser/moz.build'),
      `if CONFIG["MAKENSISU"]:
    BRANDING_FILES += [
        "stubinstaller/installing_page.css",
    ]
`
    );

    const source = 'browser/branding/mybrowser/stubinstaller/installing_page.css';
    await writeText(join(engineDir, source), 'stub');

    // Force the host to be a non-Windows platform regardless of test runner.
    const platformModule = await import('../../utils/platform.js');
    vi.spyOn(platformModule, 'getPlatform').mockReturnValue('darwin');

    vi.spyOn(git, 'hasChanges').mockResolvedValue(true);
    vi.spyOn(gitStatus, 'getUntrackedFiles').mockResolvedValue([source]);
    vi.spyOn(gitBase, 'git').mockResolvedValue('');

    const summary = await auditBuildArtifacts('/project', engineDir, undefined);
    expect(summary.skipped).toBe(1);
    expect(summary.missing).toBe(0);
    expect(summary.stale).toBe(0);
  });

  it('reports test-file misses against _tests/, not dist/', async () => {
    // When a test file is touched but not registered, the warning should
    // point at _tests/ — directing the operator to xpcshell.toml or
    // BROWSER_CHROME_MANIFESTS rather than package-manifest.in.
    const distRoot = join(engineDir, 'obj-debug', 'dist');
    const testsRoot = join(engineDir, 'obj-debug', '_tests');
    await ensureDir(distRoot);
    await ensureDir(testsRoot);
    await ensureDir(join(engineDir, 'browser/components/tests/unit'));
    // Full test packaging has run: emit the marker so test-path audits
    // are not pre-emptively skipped.
    await writeText(join(testsRoot, 'all-tests.json'), '{}');

    const source = 'browser/components/tests/unit/test_mybrowser_unregistered.js';
    await writeText(join(engineDir, source), 'test');

    vi.spyOn(git, 'hasChanges').mockResolvedValue(true);
    vi.spyOn(gitStatus, 'getUntrackedFiles').mockResolvedValue([source]);
    vi.spyOn(gitBase, 'git').mockResolvedValue('');

    const summary = await auditBuildArtifacts('/project', engineDir, undefined);
    expect(summary.missing).toBe(1);
    const warnings = warnMock.mock.calls.map(([m]) => m);
    expect(warnings.some((m) => m.includes('_tests/'))).toBe(true);
  });

  it('skips test sources when `_tests/all-tests.json` is not present', async () => {
    // Plain `mach build` populates a partial `_tests/` subtree but does
    // NOT run `mach package-tests`, so registered tests are absent even
    // when moz.build entries are correct. Without the marker we would
    // warn on every registered test every build — pure noise. The audit
    // now defers to `fireforge test` / `mach package-tests` for the
    // packaged-tests check and silently skips test-path sources.
    const distRoot = join(engineDir, 'obj-debug', 'dist');
    const testsRoot = join(engineDir, 'obj-debug', '_tests');
    await ensureDir(distRoot);
    await ensureDir(testsRoot); // Exists but WITHOUT the marker.
    await ensureDir(join(engineDir, 'browser/components/tests/unit'));

    const source = 'browser/components/tests/unit/test_mybrowser_registered.js';
    await writeText(join(engineDir, source), 'test');

    vi.spyOn(git, 'hasChanges').mockResolvedValue(true);
    vi.spyOn(gitStatus, 'getUntrackedFiles').mockResolvedValue([source]);
    vi.spyOn(gitBase, 'git').mockResolvedValue('');

    const summary = await auditBuildArtifacts('/project', engineDir, undefined);
    expect(summary.skipped).toBe(1);
    expect(summary.missing).toBe(0);
    const warnings = warnMock.mock.calls.map(([m]) => m);
    expect(warnings.some((m) => m.includes('_tests/'))).toBe(false);
  });

  it('downgrades a stale-match to missing when the only same-basename candidate is in an unrelated subtree', async () => {
    // Source: `browser/modules/mybrowser/test/head.js`.
    // The correct `_tests/testing/mochitest/browser/…/mybrowser/test/head.js`
    // does not exist (test packaging was scoped / skipped), but an unrelated
    // upstream `_tests/xpcshell/dom/quota/test/xpcshell/common/head.js`
    // remains in place from a prior run and trail-matches on the basename
    // only. The old audit reported it as "stale against an unrelated file";
    // the fix downgrades to `missing` with a warning that names the
    // unrelated candidate so the operator is not misled.
    const distRoot = join(engineDir, 'obj-debug', 'dist');
    const testsRoot = join(engineDir, 'obj-debug', '_tests');
    await ensureDir(distRoot);
    await ensureDir(join(testsRoot, 'xpcshell/dom/quota/test/xpcshell/common'));
    await ensureDir(join(engineDir, 'browser/modules/mybrowser/test'));
    await writeText(join(testsRoot, 'all-tests.json'), '{}');

    const source = 'browser/modules/mybrowser/test/head.js';
    const unrelated = join(testsRoot, 'xpcshell/dom/quota/test/xpcshell/common/head.js');
    await writeText(join(engineDir, source), 'fork-head');
    await writeText(unrelated, 'upstream-head');

    // Source newer than candidate so the stale path is exercised.
    const past = new Date(Date.now() - 10_000);
    const now = new Date();
    await utimes(unrelated, past, past);
    await utimes(join(engineDir, source), now, now);

    vi.spyOn(git, 'hasChanges').mockResolvedValue(true);
    vi.spyOn(gitStatus, 'getUntrackedFiles').mockResolvedValue([source]);
    vi.spyOn(gitBase, 'git').mockResolvedValue('');

    const summary = await auditBuildArtifacts('/project', engineDir, undefined);
    expect(summary.missing).toBe(1);
    expect(summary.stale).toBe(0);
    expect(summary.updated).toBe(0);
    expect(summary.entries[0]?.artifact).toBeUndefined();
    const warnings = warnMock.mock.calls.map(([m]) => m);
    expect(warnings.some((m) => /unrelated subtree/.test(m))).toBe(true);
  });

  it('keeps the stale classification when the match shares the source parent directory', async () => {
    // Same setup but the candidate lives under a matching parent
    // (`.../mybrowser/test/head.js`) — the confident-match heuristic
    // correctly keeps it classified as `stale` so the packaging
    // regression surfaces.
    const distRoot = join(engineDir, 'obj-debug', 'dist');
    const testsRoot = join(engineDir, 'obj-debug', '_tests');
    await ensureDir(distRoot);
    await ensureDir(join(testsRoot, 'testing/mochitest/browser/browser/modules/mybrowser/test'));
    await ensureDir(join(engineDir, 'browser/modules/mybrowser/test'));
    await writeText(join(testsRoot, 'all-tests.json'), '{}');

    const source = 'browser/modules/mybrowser/test/head.js';
    const related = join(
      testsRoot,
      'testing/mochitest/browser/browser/modules/mybrowser/test/head.js'
    );
    await writeText(join(engineDir, source), 'fork-head');
    await writeText(related, 'fork-head-older');

    const past = new Date(Date.now() - 10_000);
    const now = new Date();
    await utimes(related, past, past);
    await utimes(join(engineDir, source), now, now);

    vi.spyOn(git, 'hasChanges').mockResolvedValue(true);
    vi.spyOn(gitStatus, 'getUntrackedFiles').mockResolvedValue([source]);
    vi.spyOn(gitBase, 'git').mockResolvedValue('');

    const summary = await auditBuildArtifacts('/project', engineDir, undefined);
    expect(summary.stale).toBe(1);
    expect(summary.missing).toBe(0);
    expect(summary.entries[0]?.artifact).toBe(related);
  });

  it('keeps stale classification via the non-generic-segment bonus when trailing overlap is 1', async () => {
    // Branding re-root case: `branding/<name>/content/aboutDialog.css`
    // lands at `chrome/<area>/content/branding/aboutDialog.css`. Only the
    // basename trail-matches (trailing=1), but `branding` is a meaningful,
    // non-generic source segment that appears mid-candidate. The bonus
    // path of `isConfidentMatch` accepts the pair so the audit surfaces
    // a real staleness rather than reclassifying to missing.
    const distRoot = join(engineDir, 'obj-debug', 'dist');
    await ensureDir(join(distRoot, 'bin/browser/chrome/browser/content/branding'));
    await ensureDir(join(engineDir, 'browser/branding/mybrowser/content'));

    const source = 'browser/branding/mybrowser/content/aboutDialog.css';
    const artifact = join(distRoot, 'bin/browser/chrome/browser/content/branding/aboutDialog.css');
    await writeText(join(engineDir, source), 'branded-new');
    await writeText(artifact, 'branded-old');

    const past = new Date(Date.now() - 10_000);
    const now = new Date();
    await utimes(artifact, past, past);
    await utimes(join(engineDir, source), now, now);

    vi.spyOn(git, 'hasChanges').mockResolvedValue(true);
    vi.spyOn(gitStatus, 'getUntrackedFiles').mockResolvedValue([source]);
    vi.spyOn(gitBase, 'git').mockResolvedValue('');

    const summary = await auditBuildArtifacts('/project', engineDir, undefined);
    expect(summary.stale).toBe(1);
    expect(summary.missing).toBe(0);
    expect(summary.entries[0]?.artifact).toBe(artifact);
  });

  it('skips files under path-convention installer-tree gates on non-matching hosts', async () => {
    // Windows stub-installer branding CSS lands through
    // `browser/installer/windows/Makefile.in` FILES lists and `nsis/stub.nsh`,
    // not through an `if CONFIG[…]:` block in any ancestor moz.build. Before
    // this fix the audit warned on every touched stubinstaller CSS on every
    // non-Windows build. The `/stubinstaller/` path fragment now counts as
    // a Windows-only gate on convention alone.
    const dist = join(engineDir, 'obj-debug', 'dist');
    await ensureDir(dist);
    await ensureDir(join(engineDir, 'browser/branding/mybrowser/stubinstaller'));
    // No moz.build gate wraps these files — registration is via Makefile.in.
    await writeText(
      join(engineDir, 'browser/branding/mybrowser/moz.build'),
      `BRANDING_FILES += [
    "icon.png",
]
`
    );

    const source = 'browser/branding/mybrowser/stubinstaller/installing_page.css';
    await writeText(join(engineDir, source), 'stub');

    const platformModule = await import('../../utils/platform.js');
    vi.spyOn(platformModule, 'getPlatform').mockReturnValue('darwin');

    vi.spyOn(git, 'hasChanges').mockResolvedValue(true);
    vi.spyOn(gitStatus, 'getUntrackedFiles').mockResolvedValue([source]);
    vi.spyOn(gitBase, 'git').mockResolvedValue('');

    const summary = await auditBuildArtifacts('/project', engineDir, undefined);
    expect(summary.skipped).toBe(1);
    expect(summary.missing).toBe(0);
    expect(summary.stale).toBe(0);
  });

  it('uses jar.mn registration to pick the correct artifact across a basename collision', async () => {
    // Motivating case: the fork adds `engine/browser/base/content/mybrowser.js`
    // and registers it in `browser/base/jar.mn` as
    // `content/browser/mybrowser.js (content/mybrowser.js)`. A separate
    // patch puts an unrelated pref file of the same basename under
    // `browser/defaults/preferences/`. Before this fix the basename-
    // similarity heuristic could not distinguish them and "1 missing"
    // fired against the correctly-packaged chrome resource. The
    // registration-aware resolver probes the dist tree for files whose
    // path ends with `/content/browser/mybrowser.js` and correctly
    // selects the chrome artifact over the pref file.
    await ensureDir(join(engineDir, 'browser/base/content'));
    await writeText(
      join(engineDir, 'browser/base/jar.mn'),
      `browser.jar:
%  content browser  %content/browser/
        content/browser/mybrowser.js  (content/mybrowser.js)
`
    );
    const source = 'browser/base/content/mybrowser.js';
    await writeText(join(engineDir, source), 'content');

    const distRoot = join(engineDir, 'obj-debug', 'dist');
    await ensureDir(join(distRoot, 'bin/browser/chrome/browser/content/browser'));
    await ensureDir(join(distRoot, 'bin/browser/defaults/preferences'));
    const correct = join(distRoot, 'bin/browser/chrome/browser/content/browser/mybrowser.js');
    const unrelated = join(distRoot, 'bin/browser/defaults/preferences/mybrowser.js');
    await writeText(correct, 'content');
    await writeText(unrelated, 'pref');

    const past = new Date(Date.now() - 10_000);
    const now = new Date();
    await utimes(join(engineDir, source), past, past);
    await utimes(correct, now, now);
    await utimes(unrelated, now, now);

    vi.spyOn(git, 'hasChanges').mockResolvedValue(true);
    vi.spyOn(gitStatus, 'getUntrackedFiles').mockResolvedValue([source]);
    vi.spyOn(gitBase, 'git').mockResolvedValue('');

    const summary = await auditBuildArtifacts('/project', engineDir, undefined);
    expect(summary.updated).toBe(1);
    expect(summary.missing).toBe(0);
    expect(summary.entries[0]?.artifact).toBe(correct);
  });

  it('reports a registered-but-not-packaged miss distinct from an unregistered one', async () => {
    // Registration is correct but packaging never copied the file into
    // dist — plausibly because the build step was interrupted or a macro
    // filter excluded the jar. The warning should cite the jar.mn entry
    // so the operator can tell "registration is intact, packaging is
    // broken" from "registration is missing".
    await ensureDir(join(engineDir, 'browser/base/content'));
    await writeText(
      join(engineDir, 'browser/base/jar.mn'),
      `browser.jar:
        content/browser/mybrowser.js  (content/mybrowser.js)
`
    );
    const source = 'browser/base/content/mybrowser.js';
    await writeText(join(engineDir, source), 'content');

    const distRoot = join(engineDir, 'obj-debug', 'dist');
    // A wrongly-located same-basename file (pref patch) is the only
    // dist candidate; the correctly-registered chrome path is absent.
    await ensureDir(join(distRoot, 'bin/browser/defaults/preferences'));
    await writeText(join(distRoot, 'bin/browser/defaults/preferences/mybrowser.js'), 'pref');

    vi.spyOn(git, 'hasChanges').mockResolvedValue(true);
    vi.spyOn(gitStatus, 'getUntrackedFiles').mockResolvedValue([source]);
    vi.spyOn(gitBase, 'git').mockResolvedValue('');

    const summary = await auditBuildArtifacts('/project', engineDir, undefined);
    expect(summary.missing).toBe(1);
    expect(summary.entries[0]?.artifact).toBeUndefined();
    const warnings = warnMock.mock.calls.map(([m]) => m);
    expect(
      warnings.some((m) => /is registered in .*jar\.mn.*but no packaged artifact/.test(m))
    ).toBe(true);
    expect(warnings.some((m) => /same-basename hits:/.test(m))).toBe(true);
  });

  it('enumerates every same-basename candidate when the heuristic downgrades to missing', async () => {
    // Unregistered source (no jar.mn anywhere) whose basename collides
    // with several files under dist/ that live in unrelated subtrees.
    // The old warning named only "the nearest" candidate; the new warning
    // surfaces all of them so the operator can triage the registration
    // bug against the full set of confounders.
    const distRoot = join(engineDir, 'obj-debug', 'dist');
    await ensureDir(join(distRoot, 'bin/one'));
    await ensureDir(join(distRoot, 'bin/two'));
    await ensureDir(join(distRoot, 'bin/three'));
    await ensureDir(join(engineDir, 'browser/modules/mybrowser'));

    const source = 'browser/modules/mybrowser/helper.js';
    await writeText(join(engineDir, source), 'new');
    const c1 = join(distRoot, 'bin/one/helper.js');
    const c2 = join(distRoot, 'bin/two/helper.js');
    const c3 = join(distRoot, 'bin/three/helper.js');
    await writeText(c1, 'a');
    await writeText(c2, 'b');
    await writeText(c3, 'c');

    const past = new Date(Date.now() - 10_000);
    const now = new Date();
    await utimes(c1, past, past);
    await utimes(c2, past, past);
    await utimes(c3, past, past);
    await utimes(join(engineDir, source), now, now);

    vi.spyOn(git, 'hasChanges').mockResolvedValue(true);
    vi.spyOn(gitStatus, 'getUntrackedFiles').mockResolvedValue([source]);
    vi.spyOn(gitBase, 'git').mockResolvedValue('');

    const summary = await auditBuildArtifacts('/project', engineDir, undefined);
    expect(summary.missing).toBe(1);
    const warnings = warnMock.mock.calls.map(([m]) => m);
    const missing = warnings.find((m) => /unrelated subtrees/.test(m));
    expect(missing).toBeDefined();
    expect(missing).toContain('helper.js');
    // The enumeration should include ALL three candidates, not just one.
    expect(missing).toContain('one/helper.js');
    expect(missing).toContain('two/helper.js');
    expect(missing).toContain('three/helper.js');
  });

  it('resolves chrome-tree artifacts via known packaging transforms when jar.mn is bare', async () => {
    // Motivating case from dogfooding: `engine/browser/base/content/hominis.js`
    // is packaged to `chrome/browser/content/browser/hominis.js` under dist/,
    // but an unrelated `browser/defaults/preferences/hominis.js` pref file
    // from an earlier patch also lands under dist/. The source's jar.mn has
    // no `(source)` annotation (a bare target line), so the
    // registration-aware resolver cannot help. Before this fix the scorer
    // tied both candidates at score=10, the structural-relation check
    // rejected every candidate (all source segments are in the "generic"
    // list), and the correctly-packaged chrome file was reported as missing.
    //
    // The known-transform resolver now matches the expected
    // `chrome/browser/content/browser/<basename>` suffix and returns the
    // chrome artifact before the scorer runs.
    await ensureDir(join(engineDir, 'browser/base/content'));
    const source = 'browser/base/content/hominis.js';
    await writeText(join(engineDir, source), 'content');

    const distRoot = join(engineDir, 'obj-debug', 'dist');
    await ensureDir(join(distRoot, 'bin/browser/chrome/browser/content/browser'));
    await ensureDir(join(distRoot, 'bin/browser/defaults/preferences'));
    const correct = join(distRoot, 'bin/browser/chrome/browser/content/browser/hominis.js');
    const unrelated = join(distRoot, 'bin/browser/defaults/preferences/hominis.js');
    await writeText(correct, 'content');
    await writeText(unrelated, 'pref');

    const past = new Date(Date.now() - 10_000);
    const now = new Date();
    await utimes(join(engineDir, source), past, past);
    await utimes(correct, now, now);
    await utimes(unrelated, now, now);

    vi.spyOn(git, 'hasChanges').mockResolvedValue(true);
    vi.spyOn(gitStatus, 'getUntrackedFiles').mockResolvedValue([source]);
    vi.spyOn(gitBase, 'git').mockResolvedValue('');

    const summary = await auditBuildArtifacts('/project', engineDir, undefined);
    expect(summary.updated).toBe(1);
    expect(summary.missing).toBe(0);
    expect(summary.entries[0]?.artifact).toBe(correct);
  });
});
