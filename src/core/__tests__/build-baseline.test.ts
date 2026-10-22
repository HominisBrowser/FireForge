// SPDX-License-Identifier: EUPL-1.2
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureDir, writeJson } from '../../utils/fs.js';
import { getBuildBaselinePath, readBuildBaseline, writeBuildBaseline } from '../build-baseline.js';
import { DELETED_FILE_FINGERPRINT } from '../build-baseline-types.js';
import { FIREFORGE_DIR } from '../config-paths.js';
import * as git from '../git.js';

describe('build-baseline', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'ff-build-baseline-'));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns undefined when no baseline has been written yet', async () => {
    await expect(readBuildBaseline(projectRoot)).resolves.toBeUndefined();
  });

  it('returns undefined on a corrupt marker rather than throwing', async () => {
    const path = getBuildBaselinePath(projectRoot);
    await ensureDir(join(projectRoot, FIREFORGE_DIR));
    const { writeText } = await import('../../utils/fs.js');
    await writeText(path, '{not json');
    await expect(readBuildBaseline(projectRoot)).resolves.toBeUndefined();
  });

  it('persists the engine HEAD SHA, timestamp, and binaryName on write', async () => {
    vi.spyOn(git, 'getHead').mockResolvedValue('deadbeef1234');
    await writeBuildBaseline({ projectRoot, engineDir: '/engine', binaryName: 'mybrowser' });
    const stored = await readBuildBaseline(projectRoot);
    expect(stored).toBeDefined();
    expect(stored?.engineHeadSha).toBe('deadbeef1234');
    expect(stored?.binaryName).toBe('mybrowser');
    expect(() => new Date(stored?.builtAt ?? '').toISOString()).not.toThrow();
  });

  it('writes an empty SHA when the engine has no HEAD yet', async () => {
    const missingHeadError = Object.assign(new Error("ambiguous argument 'HEAD'"), {});
    vi.spyOn(git, 'getHead').mockRejectedValue(missingHeadError);
    await writeBuildBaseline({ projectRoot, engineDir: '/engine', binaryName: 'mybrowser' });
    const stored = await readBuildBaseline(projectRoot);
    expect(stored?.engineHeadSha).toBe('');
  });

  it('propagates non-missing-HEAD git errors rather than writing garbage', async () => {
    const realError = new Error('git executable not found in PATH');
    vi.spyOn(git, 'getHead').mockRejectedValue(realError);
    await expect(
      writeBuildBaseline({ projectRoot, engineDir: '/engine', binaryName: 'mybrowser' })
    ).rejects.toThrow('git executable not found in PATH');
  });

  it('round-trips a pre-written baseline verbatim', async () => {
    const path = getBuildBaselinePath(projectRoot);
    await ensureDir(join(projectRoot, FIREFORGE_DIR));
    const baseline = {
      engineHeadSha: 'abc123',
      builtAt: '2026-04-18T00:00:00.000Z',
      binaryName: 'mybrowser',
    };
    await writeJson(path, baseline);
    const loaded = await readBuildBaseline(projectRoot);
    expect(loaded).toEqual(baseline);
    const raw = await readFile(path, 'utf8');
    expect(raw).toContain('abc123');
  });

  it('round-trips a full testPackagingCoverage claim', async () => {
    vi.spyOn(git, 'getHead').mockResolvedValue('deadbeef');
    await writeBuildBaseline({
      projectRoot,
      engineDir: '/engine',
      binaryName: 'mybrowser',
      testPackagingCoverage: 'full',
    });
    const stored = await readBuildBaseline(projectRoot);
    expect(stored?.testPackagingCoverage).toBe('full');
  });

  it('round-trips a scoped testPackagingCoverage path list', async () => {
    vi.spyOn(git, 'getHead').mockResolvedValue('deadbeef');
    const scoped = ['browser/components/tiles/test/browser', 'toolkit/content/tests/chrome/a.js'];
    await writeBuildBaseline({
      projectRoot,
      engineDir: '/engine',
      binaryName: 'mybrowser',
      testPackagingCoverage: scoped,
    });
    const stored = await readBuildBaseline(projectRoot);
    expect(stored?.testPackagingCoverage).toEqual(scoped);
  });

  it('round-trips per-path coverage records and a carried full anchor', async () => {
    vi.spyOn(git, 'getHead').mockResolvedValue('deadbeef');
    const anchor = { engineHeadSha: 'deadbeef', mozconfigHash: 'a'.repeat(64), fingerprints: {} };
    const records = { 'a/test': { ...anchor, inputs: ['a/test'] } };
    await writeBuildBaseline({
      projectRoot,
      engineDir: '/engine',
      binaryName: 'mybrowser',
      testPackagingCoverage: ['a/test'],
      testCoverageRecords: records,
      fullCoverageAnchor: anchor,
    });
    const stored = await readBuildBaseline(projectRoot);
    expect(stored?.testCoverageRecords).toEqual(records);
    expect(stored?.fullCoverageAnchor).toEqual(anchor);
  });

  it('omits testPackagingCoverage from the marker when not provided', async () => {
    // Callers that never pass a coverage claim must keep producing markers
    // without the field.
    vi.spyOn(git, 'getHead').mockResolvedValue('deadbeef');
    await writeBuildBaseline({ projectRoot, engineDir: '/engine', binaryName: 'mybrowser' });
    const raw = await readFile(getBuildBaselinePath(projectRoot), 'utf8');
    expect(raw).not.toContain('testPackagingCoverage');
  });

  it('omits packageableFingerprints when the outer git probe fails', async () => {
    // Defensive case: a broken `hasChanges` / `git diff` probe must not
    // corrupt the on-disk baseline with `{}`. The fingerprint field is
    // left undefined so the stale-check falls back to the path-only
    // comparison on the next test run.
    vi.spyOn(git, 'getHead').mockResolvedValue('deadbeef');
    const gitModule = await import('../git.js');
    vi.spyOn(gitModule, 'hasChanges').mockRejectedValue(new Error('git unavailable'));

    await writeBuildBaseline({
      projectRoot,
      engineDir: '/engine-does-not-exist',
      binaryName: 'mybrowser',
    });
    const stored = await readBuildBaseline(projectRoot);
    expect(stored?.packageableFingerprints).toBeUndefined();
  });

  it('records an explicit tombstone for a dirty path missing at build completion', async () => {
    const engineDir = await mkdtemp(join(tmpdir(), 'ff-build-baseline-engine-'));
    try {
      vi.spyOn(git, 'getHead').mockResolvedValue('deadbeef');
      const gitModule = await import('../git.js');
      const gitBase = await import('../git-base.js');
      const gitStatus = await import('../git-status.js');
      vi.spyOn(gitModule, 'hasChanges').mockResolvedValue(true);
      vi.spyOn(gitBase, 'git').mockResolvedValue(
        'browser/base/content/vanishing.js\0browser/base/content/present.js\0'
      );
      vi.spyOn(gitStatus, 'getUntrackedFiles').mockResolvedValue([]);

      // `present.js` exists, `vanishing.js` doesn't. The missing path is a
      // tracked deletion from the baseline's point of view and must remain
      // representable after a successful build.
      const { writeText, ensureDir: ensureDirLocal } = await import('../../utils/fs.js');
      await ensureDirLocal(join(engineDir, 'browser/base/content'));
      await writeText(join(engineDir, 'browser/base/content/present.js'), 'present\n');

      await writeBuildBaseline({ projectRoot, engineDir, binaryName: 'mybrowser' });
      const stored = await readBuildBaseline(projectRoot);
      const recorded = stored?.packageableFingerprints ?? {};
      expect(Object.keys(recorded)).toContain('browser/base/content/present.js');
      expect(recorded['browser/base/content/vanishing.js']).toBe(DELETED_FILE_FINGERPRINT);
    } finally {
      await rm(engineDir, { recursive: true, force: true });
    }
  });

  it('records a staticComponentsBaseline anchor on a full-coverage write', async () => {
    // A full build just recompiled the StaticComponents table, so the
    // write anchors the table to the current engine HEAD plus the content
    // of every dirty components.conf.
    const engineDir = await mkdtemp(join(tmpdir(), 'ff-build-baseline-engine-'));
    try {
      vi.spyOn(git, 'getHead').mockResolvedValue('full-sha');
      const gitModule = await import('../git.js');
      const gitBase = await import('../git-base.js');
      const gitStatus = await import('../git-status.js');
      vi.spyOn(gitModule, 'hasChanges').mockResolvedValue(true);
      vi.spyOn(gitBase, 'git').mockResolvedValue(
        'browser/components/mybrowser/components.conf\0browser/base/content/browser-main.js\0'
      );
      vi.spyOn(gitStatus, 'getUntrackedFiles').mockResolvedValue([]);

      const { writeText, ensureDir: ensureDirLocal } = await import('../../utils/fs.js');
      await ensureDirLocal(join(engineDir, 'browser/components/mybrowser'));
      await writeText(
        join(engineDir, 'browser/components/mybrowser/components.conf'),
        "Classes = [{'cid': '{deadbeef}'}]\n"
      );
      await ensureDirLocal(join(engineDir, 'browser/base/content'));
      await writeText(join(engineDir, 'browser/base/content/browser-main.js'), '// js\n');

      await writeBuildBaseline({
        projectRoot,
        engineDir,
        binaryName: 'mybrowser',
        testPackagingCoverage: 'full',
      });
      const stored = await readBuildBaseline(projectRoot);

      expect(stored?.staticComponentsBaseline).toBeDefined();
      expect(stored?.staticComponentsBaseline?.engineHeadSha).toBe('full-sha');
      const fingerprints = stored?.staticComponentsBaseline?.fingerprints ?? {};
      // Only the XPCOM manifest is anchored. The packageable .js path
      // belongs to packageableFingerprints, not the components anchor.
      expect(Object.keys(fingerprints)).toEqual(['browser/components/mybrowser/components.conf']);
      expect(fingerprints['browser/components/mybrowser/components.conf']).toMatch(
        /^[0-9a-f]{64}$/
      );
    } finally {
      await rm(engineDir, { recursive: true, force: true });
    }
  });

  it('carries the previous staticComponentsBaseline forward verbatim on a scoped write', async () => {
    // A scoped `test --build` runs `mach build faster`, which does not
    // rebake components.conf, so the last full build stays the honest anchor.
    vi.spyOn(git, 'getHead').mockResolvedValue('scoped-sha');
    const gitModule = await import('../git.js');
    vi.spyOn(gitModule, 'hasChanges').mockResolvedValue(false);

    const anchor = {
      engineHeadSha: 'full-sha',
      fingerprints: { 'browser/components/mybrowser/components.conf': 'ab'.repeat(32) },
    };
    const previous = {
      engineHeadSha: 'full-sha',
      builtAt: '2026-07-01T00:00:00.000Z',
      binaryName: 'mybrowser',
      staticComponentsBaseline: anchor,
    };

    await writeBuildBaseline({
      projectRoot,
      engineDir: '/engine',
      binaryName: 'mybrowser',
      testPackagingCoverage: ['browser/foo/test'],
      previousBaseline: previous,
    });
    const stored = await readBuildBaseline(projectRoot);
    expect(stored?.engineHeadSha).toBe('scoped-sha');
    expect(stored?.staticComponentsBaseline).toEqual(anchor);
  });

  it('omits the staticComponentsBaseline on a scoped write with no previous baseline', async () => {
    vi.spyOn(git, 'getHead').mockResolvedValue('scoped-sha');
    const gitModule = await import('../git.js');
    vi.spyOn(gitModule, 'hasChanges').mockResolvedValue(false);

    await writeBuildBaseline({
      projectRoot,
      engineDir: '/engine',
      binaryName: 'mybrowser',
      testPackagingCoverage: ['browser/foo/test'],
    });
    const raw = await readFile(getBuildBaselinePath(projectRoot), 'utf8');
    expect(raw).not.toContain('staticComponentsBaseline');
  });

  it('omits the staticComponentsBaseline when the dirty-path probe fails on a full write', async () => {
    // Same defensive contract as packageableFingerprints: a broken probe
    // omits the field so the static-components check degrades to fresh
    // instead of anchoring to a garbage record.
    vi.spyOn(git, 'getHead').mockResolvedValue('full-sha');
    const gitModule = await import('../git.js');
    vi.spyOn(gitModule, 'hasChanges').mockRejectedValue(new Error('git unavailable'));

    await writeBuildBaseline({
      projectRoot,
      engineDir: '/engine-does-not-exist',
      binaryName: 'mybrowser',
      testPackagingCoverage: 'full',
    });
    const stored = await readBuildBaseline(projectRoot);
    expect(stored?.staticComponentsBaseline).toBeUndefined();
    expect(stored?.packageableFingerprints).toBeUndefined();
  });

  describe('buildInputFingerprints', () => {
    const JAR = 'toolkit/content/jar.mn';
    const MOZBUILD = 'browser/base/moz.build';

    async function stubDirtyBuildInputs(engineDir: string): Promise<void> {
      vi.spyOn(git, 'getHead').mockResolvedValue('sha');
      const gitModule = await import('../git.js');
      const gitBase = await import('../git-base.js');
      const gitStatus = await import('../git-status.js');
      vi.spyOn(gitModule, 'hasChanges').mockResolvedValue(true);
      vi.spyOn(gitBase, 'git').mockResolvedValue(
        `${JAR}\0${MOZBUILD}\0browser/base/content/x.js\0`
      );
      vi.spyOn(gitStatus, 'getUntrackedFiles').mockResolvedValue([]);
      const { writeText, ensureDir: ensureDirLocal } = await import('../../utils/fs.js');
      await ensureDirLocal(join(engineDir, 'toolkit/content'));
      await ensureDirLocal(join(engineDir, 'browser/base/content'));
      await writeText(join(engineDir, JAR), 'toolkit.jar:\n  content/global/x.css\n');
      await writeText(join(engineDir, MOZBUILD), 'JAR_MANIFESTS += ["jar.mn"]\n');
      await writeText(join(engineDir, 'browser/base/content/x.js'), '// x\n');
    }

    it('records every dirty build input after a full build', async () => {
      const engineDir = await mkdtemp(join(tmpdir(), 'ff-build-baseline-engine-'));
      try {
        await stubDirtyBuildInputs(engineDir);
        await writeBuildBaseline({
          projectRoot,
          engineDir,
          binaryName: 'mybrowser',
          testPackagingCoverage: 'full',
        });
        const stored = await readBuildBaseline(projectRoot);
        const recorded = stored?.buildInputFingerprints ?? {};
        expect(Object.keys(recorded).sort()).toEqual([MOZBUILD, JAR].sort());
        expect(recorded[JAR]).toMatch(/^[0-9a-f]{64}$/);
        // The packageable .js path belongs to packageableFingerprints.
        expect(stored?.packageableFingerprints?.['browser/base/content/x.js']).toBeDefined();
      } finally {
        await rm(engineDir, { recursive: true, force: true });
      }
    });

    it('refreshes backend inputs but carries jar.mn forward on a faster build', async () => {
      // `mach build faster` never installs a new jar.mn destination (it is
      // the build the escalation bypasses), so its write must not claim the
      // live jar.mn was built. The previous record's entry stays.
      const engineDir = await mkdtemp(join(tmpdir(), 'ff-build-baseline-engine-'));
      try {
        await stubDirtyBuildInputs(engineDir);
        const previous = {
          engineHeadSha: 'sha',
          builtAt: '2026-08-01T00:00:00.000Z',
          binaryName: 'mybrowser',
          buildInputFingerprints: { [JAR]: 'ab'.repeat(32), [MOZBUILD]: 'cd'.repeat(32) },
        };
        await writeBuildBaseline({
          projectRoot,
          engineDir,
          binaryName: 'mybrowser',
          testPackagingCoverage: 'full',
          previousBaseline: previous,
          recordedBy: 'fireforge build --ui',
          staticComponentsHandling: 'auto',
          buildKind: 'faster',
        });
        const stored = await readBuildBaseline(projectRoot);
        const recorded = stored?.buildInputFingerprints ?? {};
        expect(recorded[JAR]).toBe('ab'.repeat(32));
        expect(recorded[MOZBUILD]).toMatch(/^[0-9a-f]{64}$/);
        expect(recorded[MOZBUILD]).not.toBe('cd'.repeat(32));
      } finally {
        await rm(engineDir, { recursive: true, force: true });
      }
    });

    it('records no jar.mn entry on a faster build with no previous record', async () => {
      const engineDir = await mkdtemp(join(tmpdir(), 'ff-build-baseline-engine-'));
      try {
        await stubDirtyBuildInputs(engineDir);
        await writeBuildBaseline({
          projectRoot,
          engineDir,
          binaryName: 'mybrowser',
          testPackagingCoverage: ['browser/foo/test'],
          previousBaseline: undefined,
          recordedBy: 'fireforge test --build browser/foo/test',
          staticComponentsHandling: 'auto',
          buildKind: 'faster',
        });
        const stored = await readBuildBaseline(projectRoot);
        const recorded = stored?.buildInputFingerprints ?? {};
        expect(Object.keys(recorded)).toEqual([MOZBUILD]);
        // The writing process is stamped, so a coverage refusal can name it.
        expect(stored?.recorder).toEqual({
          pid: process.pid,
          invocationId: expect.any(String) as string,
        });
      } finally {
        await rm(engineDir, { recursive: true, force: true });
      }
    });

    it('omits the field when the dirty-path probe fails', async () => {
      // Same contract as packageableFingerprints: a broken probe leaves the
      // field off rather than writing `{}`, and build-prepare then falls
      // back to the path-only comparison.
      vi.spyOn(git, 'getHead').mockResolvedValue('sha');
      const gitModule = await import('../git.js');
      vi.spyOn(gitModule, 'hasChanges').mockRejectedValue(new Error('git unavailable'));
      await writeBuildBaseline({
        projectRoot,
        engineDir: '/engine-does-not-exist',
        binaryName: 'mybrowser',
        testPackagingCoverage: 'full',
      });
      const raw = await readFile(getBuildBaselinePath(projectRoot), 'utf8');
      expect(raw).not.toContain('buildInputFingerprints');
    });
  });

  it('records packageableFingerprints when the engine workdir has dirty packageable paths', async () => {
    // Without per-file fingerprints, a project with persistently-applied
    // patches plus furnace-applied components always shows those files as
    // "changed since last build" on the stale check, even immediately after
    // a successful build. `writeBuildBaseline` captures a sha256 per dirty
    // packageable path so the stale check can distinguish "same content as
    // build time" from "edited since build".
    const engineDir = await mkdtemp(join(tmpdir(), 'ff-build-baseline-engine-'));
    try {
      // Emulate a dirty-but-committed-against-HEAD packageable file by
      // stubbing the git helpers the baseline writer consults.
      vi.spyOn(git, 'getHead').mockResolvedValue('deadbeef');
      const gitModule = await import('../git.js');
      const gitBase = await import('../git-base.js');
      const gitStatus = await import('../git-status.js');
      vi.spyOn(gitModule, 'hasChanges').mockResolvedValue(true);
      vi.spyOn(gitBase, 'git').mockResolvedValue('browser/base/content/browser-main.js\0');
      vi.spyOn(gitStatus, 'getUntrackedFiles').mockResolvedValue([]);

      // Create the packageable file so the fingerprint hash has content
      // to read.
      const { writeText, ensureDir: ensureDirLocal } = await import('../../utils/fs.js');
      await ensureDirLocal(join(engineDir, 'browser/base/content'));
      await writeText(
        join(engineDir, 'browser/base/content/browser-main.js'),
        '// content of browser-main.js used for fingerprint hashing\n'
      );

      await writeBuildBaseline({ projectRoot, engineDir, binaryName: 'mybrowser' });
      const stored = await readBuildBaseline(projectRoot);

      expect(stored?.packageableFingerprints).toBeDefined();
      const recorded = stored?.packageableFingerprints ?? {};
      expect(Object.keys(recorded)).toContain('browser/base/content/browser-main.js');
      // Fingerprints are hex-encoded sha256 digests.
      expect(recorded['browser/base/content/browser-main.js']).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await rm(engineDir, { recursive: true, force: true });
    }
  });

  it('omits the complete staging anchor when one dirty input cannot be read', async () => {
    const engineDir = join(projectRoot, 'engine');
    await ensureDir(join(engineDir, 'browser/tests/broken.js'));
    vi.spyOn(git, 'getHead').mockResolvedValue('deadbeef');
    vi.spyOn(git, 'hasChanges').mockResolvedValue(true);
    const gitBase = await import('../git-base.js');
    const gitStatus = await import('../git-status.js');
    vi.spyOn(gitBase, 'git').mockResolvedValue('browser/tests/broken.js\0');
    vi.spyOn(gitStatus, 'getUntrackedFiles').mockResolvedValue([]);
    await writeBuildBaseline({ projectRoot, engineDir, binaryName: 'mybrowser' });
    const stored = await readBuildBaseline(projectRoot, 'refuse');
    expect(stored?.testInputFingerprints).toBeUndefined();
  });

  it('names the failing coverage field and offers --build when refusing a scoped baseline', async () => {
    // A baseline whose coverage holds a raw trailing-slash request path, as
    // `test --build browser/base/content/test/hominis/` would record it.
    await ensureDir(join(projectRoot, FIREFORGE_DIR));
    await writeJson(getBuildBaselinePath(projectRoot), {
      engineHeadSha: 'abc',
      builtAt: '2026-10-22T00:00:00.000Z',
      binaryName: 'mybrowser',
      testPackagingCoverage: ['browser/base/content/test/hominis/'],
    });
    const refusal = readBuildBaseline(projectRoot, 'refuse');
    await expect(refusal).rejects.toThrow(
      'testPackagingCoverage[0] = "browser/base/content/test/hominis/"'
    );
    await expect(readBuildBaseline(projectRoot, 'refuse')).rejects.toThrow(/with --build/);
  });

  it('keeps advising fireforge build for a non-coverage field', async () => {
    await ensureDir(join(projectRoot, FIREFORGE_DIR));
    await writeJson(getBuildBaselinePath(projectRoot), {
      engineHeadSha: 'abc',
      builtAt: 'not a date',
      binaryName: 'mybrowser',
    });
    const refusal = readBuildBaseline(projectRoot, 'refuse');
    await expect(refusal).rejects.toThrow('builtAt = "not a date"');
    await expect(readBuildBaseline(projectRoot, 'refuse')).rejects.toThrow(/Run "fireforge build"/);
  });

  it('fingerprints non-ASCII dirty paths unquoted, so the baseline stays valid', async () => {
    const engineDir = join(projectRoot, 'engine');
    const path = 'browser/base/content/caf\u00e9.js';
    await ensureDir(join(engineDir, 'browser/base/content'));
    const { writeText } = await import('../../utils/fs.js');
    await writeText(join(engineDir, path), '// cafe\n');
    vi.spyOn(git, 'getHead').mockResolvedValue('deadbeef');
    vi.spyOn(git, 'hasChanges').mockResolvedValue(true);
    const gitBase = await import('../git-base.js');
    const gitSpy = vi
      .spyOn(gitBase, 'git')
      .mockImplementation((args) => Promise.resolve(args.includes('diff') ? `${path}\0` : ''));
    await writeBuildBaseline({ projectRoot, engineDir, binaryName: 'mybrowser' });
    expect(gitSpy).toHaveBeenCalledWith(
      expect.arrayContaining(['-c', 'core.quotePath=false', '-z']),
      engineDir
    );
    const stored = await readBuildBaseline(projectRoot, 'refuse');
    expect(Object.keys(stored?.packageableFingerprints ?? {})).toEqual([path]);
  });

  it('records a controlBuild stamp only when given one', async () => {
    vi.spyOn(git, 'getHead').mockResolvedValue('deadbeef');
    const stamp = {
      diffFile: 'controls/first-key.diff',
      targets: ['gfx/layers/apz/src/APZCTreeManager.cpp'],
      appliedAt: '2026-10-22T10:00:00.000Z',
    };
    await writeBuildBaseline({
      projectRoot,
      engineDir: '/engine',
      binaryName: 'mybrowser',
      controlBuild: stamp,
    });
    expect((await readBuildBaseline(projectRoot, 'refuse'))?.controlBuild).toEqual(stamp);
    await writeBuildBaseline({ projectRoot, engineDir: '/engine', binaryName: 'mybrowser' });
    expect((await readBuildBaseline(projectRoot, 'refuse'))?.controlBuild).toBeUndefined();
  });
});
