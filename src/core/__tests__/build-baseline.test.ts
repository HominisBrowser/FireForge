// SPDX-License-Identifier: EUPL-1.2
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureDir, writeJson } from '../../utils/fs.js';
import {
  BUILD_BASELINE_FILENAME,
  getBuildBaselinePath,
  readBuildBaseline,
  writeBuildBaseline,
} from '../build-baseline.js';
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

  it('resolves the canonical marker path under .fireforge/', () => {
    const path = getBuildBaselinePath('/some/project');
    expect(path).toBe(join('/some/project', FIREFORGE_DIR, BUILD_BASELINE_FILENAME));
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
    await writeBuildBaseline(projectRoot, '/engine', 'mybrowser');
    const stored = await readBuildBaseline(projectRoot);
    expect(stored).toBeDefined();
    expect(stored?.engineHeadSha).toBe('deadbeef1234');
    expect(stored?.binaryName).toBe('mybrowser');
    expect(() => new Date(stored?.builtAt ?? '').toISOString()).not.toThrow();
  });

  it('writes an empty SHA when the engine has no HEAD yet', async () => {
    const missingHeadError = Object.assign(new Error("ambiguous argument 'HEAD'"), {});
    vi.spyOn(git, 'getHead').mockRejectedValue(missingHeadError);
    await writeBuildBaseline(projectRoot, '/engine', 'mybrowser');
    const stored = await readBuildBaseline(projectRoot);
    expect(stored?.engineHeadSha).toBe('');
  });

  it('propagates non-missing-HEAD git errors rather than writing garbage', async () => {
    const realError = new Error('git executable not found in PATH');
    vi.spyOn(git, 'getHead').mockRejectedValue(realError);
    await expect(writeBuildBaseline(projectRoot, '/engine', 'mybrowser')).rejects.toThrow(
      'git executable not found in PATH'
    );
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
    await writeBuildBaseline(projectRoot, '/engine', 'mybrowser', 'full');
    const stored = await readBuildBaseline(projectRoot);
    expect(stored?.testPackagingCoverage).toBe('full');
  });

  it('round-trips a scoped testPackagingCoverage path list', async () => {
    vi.spyOn(git, 'getHead').mockResolvedValue('deadbeef');
    const scoped = ['browser/components/tiles/test/browser', 'toolkit/content/tests/chrome/a.js'];
    await writeBuildBaseline(projectRoot, '/engine', 'mybrowser', scoped);
    const stored = await readBuildBaseline(projectRoot);
    expect(stored?.testPackagingCoverage).toEqual(scoped);
  });

  it('omits testPackagingCoverage from the marker when not provided', async () => {
    // Legacy-shape preservation: callers that never pass a coverage claim
    // must keep producing pre-0.37.0-shaped markers.
    vi.spyOn(git, 'getHead').mockResolvedValue('deadbeef');
    await writeBuildBaseline(projectRoot, '/engine', 'mybrowser');
    const raw = await readFile(getBuildBaselinePath(projectRoot), 'utf8');
    expect(raw).not.toContain('testPackagingCoverage');
  });

  it('omits packageableFingerprints when the outer git probe fails', async () => {
    // Defensive case: a broken `hasChanges` / `git diff` probe must not
    // corrupt the on-disk baseline with `{}` — the fingerprint field is
    // left undefined so the stale-check falls back to the path-only
    // comparison on the next test run.
    vi.spyOn(git, 'getHead').mockResolvedValue('deadbeef');
    const gitModule = await import('../git.js');
    vi.spyOn(gitModule, 'hasChanges').mockRejectedValue(new Error('git unavailable'));

    await writeBuildBaseline(projectRoot, '/engine-does-not-exist', 'mybrowser');
    const stored = await readBuildBaseline(projectRoot);
    expect(stored?.packageableFingerprints).toBeUndefined();
  });

  it('skips per-file fingerprint when readFile throws but completes overall', async () => {
    // Concurrency case: a file that is enumerated by `git diff` can be
    // deleted between the enumeration and the hash. The per-file try
    // block catches that specific error and moves on, so the rest of
    // the fingerprint set still lands.
    const engineDir = await mkdtemp(join(tmpdir(), 'ff-build-baseline-engine-'));
    try {
      vi.spyOn(git, 'getHead').mockResolvedValue('deadbeef');
      const gitModule = await import('../git.js');
      const gitBase = await import('../git-base.js');
      const gitStatus = await import('../git-status.js');
      vi.spyOn(gitModule, 'hasChanges').mockResolvedValue(true);
      vi.spyOn(gitBase, 'git').mockResolvedValue(
        'browser/base/content/vanishing.js\nbrowser/base/content/present.js\n'
      );
      vi.spyOn(gitStatus, 'getUntrackedFiles').mockResolvedValue([]);

      // `present.js` exists, `vanishing.js` doesn't — readFile will
      // throw ENOENT on the second but the writer must still produce a
      // fingerprint for the first.
      const { writeText, ensureDir: ensureDirLocal } = await import('../../utils/fs.js');
      await ensureDirLocal(join(engineDir, 'browser/base/content'));
      await writeText(join(engineDir, 'browser/base/content/present.js'), 'present\n');

      await writeBuildBaseline(projectRoot, engineDir, 'mybrowser');
      const stored = await readBuildBaseline(projectRoot);
      const recorded = stored?.packageableFingerprints ?? {};
      expect(Object.keys(recorded)).toContain('browser/base/content/present.js');
      expect(Object.keys(recorded)).not.toContain('browser/base/content/vanishing.js');
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
        'browser/components/mybrowser/components.conf\nbrowser/base/content/browser-main.js\n'
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

      await writeBuildBaseline(projectRoot, engineDir, 'mybrowser', 'full');
      const stored = await readBuildBaseline(projectRoot);

      expect(stored?.staticComponentsBaseline).toBeDefined();
      expect(stored?.staticComponentsBaseline?.engineHeadSha).toBe('full-sha');
      const fingerprints = stored?.staticComponentsBaseline?.fingerprints ?? {};
      // Only the XPCOM manifest is anchored — the packageable .js path
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
    // rebake components.conf — the last FULL build stays the honest anchor.
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

    await writeBuildBaseline(projectRoot, '/engine', 'mybrowser', ['browser/foo/test'], previous);
    const stored = await readBuildBaseline(projectRoot);
    expect(stored?.engineHeadSha).toBe('scoped-sha');
    expect(stored?.staticComponentsBaseline).toEqual(anchor);
  });

  it('omits the staticComponentsBaseline on a scoped write with no previous baseline', async () => {
    vi.spyOn(git, 'getHead').mockResolvedValue('scoped-sha');
    const gitModule = await import('../git.js');
    vi.spyOn(gitModule, 'hasChanges').mockResolvedValue(false);

    await writeBuildBaseline(projectRoot, '/engine', 'mybrowser', ['browser/foo/test']);
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

    await writeBuildBaseline(projectRoot, '/engine-does-not-exist', 'mybrowser', 'full');
    const stored = await readBuildBaseline(projectRoot);
    expect(stored?.staticComponentsBaseline).toBeUndefined();
    expect(stored?.packageableFingerprints).toBeUndefined();
  });

  it('records packageableFingerprints when the engine workdir has dirty packageable paths', async () => {
    // Finding #18: without per-file fingerprints, a project with
    // persistently-applied patches + furnace-applied components always
    // shows those files as "changed since last build" on the stale
    // check, even immediately after a successful build. `writeBuildBaseline`
    // now captures a sha256 per dirty packageable path so the stale
    // check can distinguish "same content as build time" from "edited
    // since build".
    const engineDir = await mkdtemp(join(tmpdir(), 'ff-build-baseline-engine-'));
    try {
      // Emulate a dirty-but-committed-against-HEAD packageable file by
      // stubbing the git helpers the baseline writer consults.
      vi.spyOn(git, 'getHead').mockResolvedValue('deadbeef');
      const gitModule = await import('../git.js');
      const gitBase = await import('../git-base.js');
      const gitStatus = await import('../git-status.js');
      vi.spyOn(gitModule, 'hasChanges').mockResolvedValue(true);
      vi.spyOn(gitBase, 'git').mockResolvedValue('browser/base/content/browser-main.js\n');
      vi.spyOn(gitStatus, 'getUntrackedFiles').mockResolvedValue([]);

      // Create the packageable file so the fingerprint hash has content
      // to read.
      const { writeText, ensureDir: ensureDirLocal } = await import('../../utils/fs.js');
      await ensureDirLocal(join(engineDir, 'browser/base/content'));
      await writeText(
        join(engineDir, 'browser/base/content/browser-main.js'),
        '// content of browser-main.js used for fingerprint hashing\n'
      );

      await writeBuildBaseline(projectRoot, engineDir, 'mybrowser');
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
});
