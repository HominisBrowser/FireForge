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
    await ensureDir(dist);
    await ensureDir(join(engineDir, 'browser/app/profile'));

    const source = 'browser/app/profile/p.js';
    await writeText(join(engineDir, source), 'new');
    await writeText(join(dist, 'p.js'), 'old');

    // Make the artifact older than the source.
    const past = new Date(Date.now() - 10_000);
    const future = new Date();
    await utimes(join(dist, 'p.js'), past, past);
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
});
