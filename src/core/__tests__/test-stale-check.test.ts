// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('../build-baseline.js', () => ({
  readBuildBaseline: vi.fn(),
}));

vi.mock('../git.js', () => ({
  hasChanges: vi.fn(),
  isMissingHeadError: vi.fn(() => false),
}));

vi.mock('../git-base.js', () => ({
  git: vi.fn(),
}));

vi.mock('../git-status.js', () => ({
  getUntrackedFiles: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => createLoggerMock());

import { warn } from '../../utils/logger.js';
import { isXpcomManifestPath } from '../build-audit.js';
import { readBuildBaseline } from '../build-baseline.js';
import { type BuildBaseline, DELETED_FILE_FINGERPRINT } from '../build-baseline-types.js';
import { hasChanges } from '../git.js';
import { git } from '../git-base.js';
import { getUntrackedFiles } from '../git-status.js';
import {
  checkStaleBuildForTest,
  checkStaticComponentsStale,
  findChangedTestManifestsForPaths,
  findUncoveredRequestPaths,
  formatPostMutationStaticComponentsWarning,
  formatStaleBuildWarning,
  formatStaticComponentsRefusal,
  formatTestCoverageRefusal,
  FULL_SUITE_REQUEST,
  warnIfStaticComponentsStale,
} from '../test-stale-check.js';

const mockReadBaseline = vi.mocked(readBuildBaseline);
const mockGit = vi.mocked(git);
const mockHasChanges = vi.mocked(hasChanges);
const mockGetUntracked = vi.mocked(getUntrackedFiles);

describe('checkStaleBuildForTest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGit.mockResolvedValue('');
    mockHasChanges.mockResolvedValue(false);
    mockGetUntracked.mockResolvedValue([]);
  });

  it('returns not-stale when no baseline marker exists', async () => {
    // First run of a fresh workspace: no `.fireforge/last-build.json` exists
    // yet, so we have nothing to diff against. Returning `stale: true` in
    // that case would warn on every first test invocation.
    mockReadBaseline.mockResolvedValue(undefined);

    const result = await checkStaleBuildForTest('/project', '/project/engine');
    expect(result).toEqual({
      stale: false,
      changedPaths: [],
      truncated: 0,
      baseline: undefined,
    });
  });

  it('returns not-stale when git diff shows no packageable paths', async () => {
    mockReadBaseline.mockResolvedValue({
      engineHeadSha: 'abc',
      builtAt: new Date().toISOString(),
      binaryName: 'mybrowser',
    });
    // Only a non-packaged path changed (tools/, .py), not a bundle concern.
    mockGit.mockResolvedValueOnce('tools/ci.py\n');

    const result = await checkStaleBuildForTest('/project', '/project/engine');
    expect(result.stale).toBe(false);
    expect(result.changedPaths).toEqual([]);
  });

  it('flags packageable engine paths changed since the baseline', async () => {
    mockReadBaseline.mockResolvedValue({
      engineHeadSha: 'abc',
      builtAt: new Date().toISOString(),
      binaryName: 'mybrowser',
    });
    mockGit.mockResolvedValueOnce(
      'browser/base/content/mybrowser.xhtml\n' +
        'browser/base/content/mybrowser.js\n' +
        'tools/ci.py\n'
    );

    const result = await checkStaleBuildForTest('/project', '/project/engine');
    expect(result.stale).toBe(true);
    expect(result.changedPaths).toEqual([
      'browser/base/content/mybrowser.js',
      'browser/base/content/mybrowser.xhtml',
    ]);
    expect(result.truncated).toBe(0);
  });

  it('includes workdir modifications and untracked packageable files', async () => {
    mockReadBaseline.mockResolvedValue({
      engineHeadSha: 'abc',
      builtAt: new Date().toISOString(),
      binaryName: 'mybrowser',
    });
    mockGit
      .mockResolvedValueOnce('') // baseline..HEAD diff is empty
      .mockResolvedValueOnce('browser/base/content/workdir-edit.js\n'); // HEAD diff (workdir)
    mockHasChanges.mockResolvedValue(true);
    mockGetUntracked.mockResolvedValue(['browser/base/content/new-untracked.mjs']);

    const result = await checkStaleBuildForTest('/project', '/project/engine');
    expect(result.stale).toBe(true);
    expect(result.changedPaths).toEqual(
      expect.arrayContaining([
        'browser/base/content/workdir-edit.js',
        'browser/base/content/new-untracked.mjs',
      ])
    );
  });

  it('truncates the changedPaths list to the render cap and reports the remainder', async () => {
    mockReadBaseline.mockResolvedValue({
      engineHeadSha: 'abc',
      builtAt: new Date().toISOString(),
      binaryName: 'mybrowser',
    });
    // 12 packageable files: 10 should render inline, 2 should be truncated.
    const paths = Array.from(
      { length: 12 },
      (_, i) => `browser/base/content/file${String(i).padStart(2, '0')}.js`
    );
    mockGit.mockResolvedValueOnce(paths.join('\n') + '\n');

    const result = await checkStaleBuildForTest('/project', '/project/engine');
    expect(result.stale).toBe(true);
    expect(result.changedPaths).toHaveLength(10);
    expect(result.truncated).toBe(2);
  });

  it('degrades to not-stale when git diff throws (broken probe must not block tests)', async () => {
    mockReadBaseline.mockResolvedValue({
      engineHeadSha: 'abc',
      builtAt: new Date().toISOString(),
      binaryName: 'mybrowser',
    });
    mockGit.mockRejectedValueOnce(new Error('git unavailable'));
    mockHasChanges.mockRejectedValue(new Error('git unavailable'));

    const result = await checkStaleBuildForTest('/project', '/project/engine');
    expect(result.stale).toBe(false);
  });

  it('skips fingerprint-matching files when the baseline carries packageableFingerprints', async () => {
    // With per-file fingerprints in the baseline, the stale check must not
    // flag a path whose live content still matches what it was at build
    // time. That is the case for projects with persistent patch/furnace
    // workdir diffs that stay byte-identical between builds. Uses a real temp engine
    // directory because `node:fs/promises.readFile` is an ESM namespace
    // export that vitest cannot spy on.
    const { mkdtemp, writeFile: fsWriteFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const pathMod = await import('node:path');
    const joinPath = (...parts: string[]): string => pathMod.join(...parts);
    const { createHash } = await import('node:crypto');

    const engineDir = await mkdtemp(joinPath(tmpdir(), 'ff-stale-fp-'));
    try {
      const relPath = 'browser/base/content/stable.js';
      const absPath = joinPath(engineDir, relPath);
      const { ensureDir } = await import('../../utils/fs.js');
      await ensureDir(joinPath(engineDir, 'browser/base/content'));
      const content = 'hello world\n';
      await fsWriteFile(absPath, content);
      const stableHash = createHash('sha256').update(content).digest('hex');

      mockReadBaseline.mockResolvedValue({
        engineHeadSha: 'abc',
        builtAt: new Date().toISOString(),
        binaryName: 'mybrowser',
        packageableFingerprints: { [relPath]: stableHash },
      });
      mockGit.mockResolvedValueOnce(`${relPath}\n`);

      const result = await checkStaleBuildForTest('/project', engineDir);
      expect(result.stale).toBe(false);
      expect(result.changedPaths).toEqual([]);
    } finally {
      await rm(engineDir, { recursive: true, force: true });
    }
  });

  it('still flags packageable paths whose live content differs from the fingerprint', async () => {
    const { mkdtemp, writeFile: fsWriteFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const pathMod = await import('node:path');
    const joinPath = (...parts: string[]): string => pathMod.join(...parts);
    const { createHash } = await import('node:crypto');

    const engineDir = await mkdtemp(joinPath(tmpdir(), 'ff-stale-fp-'));
    try {
      const relPath = 'browser/base/content/edited.js';
      const absPath = joinPath(engineDir, relPath);
      const { ensureDir } = await import('../../utils/fs.js');
      await ensureDir(joinPath(engineDir, 'browser/base/content'));
      await fsWriteFile(absPath, 'edited content\n');
      const oldHash = createHash('sha256').update('old content\n').digest('hex');

      mockReadBaseline.mockResolvedValue({
        engineHeadSha: 'abc',
        builtAt: new Date().toISOString(),
        binaryName: 'mybrowser',
        packageableFingerprints: { [relPath]: oldHash },
      });
      mockGit.mockResolvedValueOnce(`${relPath}\n`);

      const result = await checkStaleBuildForTest('/project', engineDir);
      expect(result.stale).toBe(true);
      expect(result.changedPaths).toContain(relPath);
    } finally {
      await rm(engineDir, { recursive: true, force: true });
    }
  });

  it('treats a deletion recorded by a successful build as fresh', async () => {
    const relPath = 'browser/base/content/removed.js';
    mockReadBaseline.mockResolvedValue({
      engineHeadSha: 'abc',
      builtAt: new Date().toISOString(),
      binaryName: 'mybrowser',
      packageableFingerprints: { [relPath]: DELETED_FILE_FINGERPRINT },
    });
    mockGit.mockResolvedValueOnce(`${relPath}\n`);

    const result = await checkStaleBuildForTest('/project', '/project/engine');
    expect(result.stale).toBe(false);
    expect(result.changedPaths).toEqual([]);
  });
});

describe('formatStaleBuildWarning', () => {
  it('renders the list of changed paths and the recommended --build invocation', () => {
    const message = formatStaleBuildWarning({
      stale: true,
      changedPaths: ['browser/base/content/mybrowser.xhtml', 'browser/base/content/mybrowser.js'],
      truncated: 0,
      baseline: {
        engineHeadSha: 'abc',
        builtAt: new Date().toISOString(),
        binaryName: 'mybrowser',
      },
    });
    expect(message).toContain('browser/base/content/mybrowser.xhtml');
    expect(message).toContain('browser/base/content/mybrowser.js');
    expect(message).toContain('fireforge test --build');
  });

  it('appends a (+N more) tail when paths were truncated', () => {
    const message = formatStaleBuildWarning({
      stale: true,
      changedPaths: ['a.js', 'b.js'],
      truncated: 3,
      baseline: undefined,
    });
    expect(message).toContain('(+3 more)');
  });
});

describe('findUncoveredRequestPaths', () => {
  it('treats an absent coverage claim as full coverage', () => {
    expect(findUncoveredRequestPaths(undefined, ['browser/foo/test/unit/test_a.js'])).toEqual([]);
  });

  it('treats a full claim as covering everything, including a full-suite request', () => {
    expect(findUncoveredRequestPaths('full', ['browser/foo/test/unit/test_a.js'])).toEqual([]);
    expect(findUncoveredRequestPaths('full', [])).toEqual([]);
  });

  it('covers an exact-path match', () => {
    expect(
      findUncoveredRequestPaths(
        ['browser/foo/test/unit/test_a.js'],
        ['browser/foo/test/unit/test_a.js']
      )
    ).toEqual([]);
  });

  it('covers files beneath a covered directory entry', () => {
    expect(
      findUncoveredRequestPaths(['browser/foo/test'], ['browser/foo/test/unit/test_a.js'])
    ).toEqual([]);
  });

  it('does not cover a requested directory broader than a covered file', () => {
    expect(
      findUncoveredRequestPaths(['browser/foo/test/unit/test_a.js'], ['browser/foo/test'])
    ).toEqual(['browser/foo/test']);
  });

  it('reports disjoint manifests as uncovered', () => {
    // The item-3 field incident shape: a three-file scoped rebuild does not
    // cover a run over a different manifest whose support fixtures were
    // never packaged.
    expect(
      findUncoveredRequestPaths(
        ['browser/components/tiles/test/browser/browser_a.js'],
        ['browser/components/history/test/browser/browser_hist.js']
      )
    ).toEqual(['browser/components/history/test/browser/browser_hist.js']);
  });

  it('reports a full-suite request against scoped coverage as uncovered', () => {
    expect(findUncoveredRequestPaths(['browser/foo/test/unit/test_a.js'], [])).toEqual([
      FULL_SUITE_REQUEST,
    ]);
  });

  it('covers a same-manifest sibling of a covered file (item 5: manifest granularity)', () => {
    // The field-incident shape: a run scoped to file_A refuses file_B of
    // the same manifest, even though the scoped build staged the whole
    // manifest directory into obj-*/_tests/.
    expect(
      findUncoveredRequestPaths(
        ['browser/components/tiles/test/browser/browser_a.js'],
        ['browser/components/tiles/test/browser/browser_b.js']
      )
    ).toEqual([]);
  });

  it('covers a directory request equal to the covered file manifest directory', () => {
    expect(
      findUncoveredRequestPaths(['browser/foo/test/unit/test_a.js'], ['browser/foo/test/unit'])
    ).toEqual([]);
  });

  it('is not a prefix-string match: sibling paths sharing a prefix are uncovered', () => {
    expect(findUncoveredRequestPaths(['browser/foo/test'], ['browser/foo/tests/a.js'])).toEqual([
      'browser/foo/tests/a.js',
    ]);
  });

  it('normalizes backslash input and trailing slashes before comparing', () => {
    expect(
      findUncoveredRequestPaths(['browser/foo/test/'], ['browser\\foo\\test\\unit\\test_a.js'])
    ).toEqual([]);
  });
});

describe('formatTestCoverageRefusal', () => {
  it('names the uncovered paths, the recorded coverage, and both remediations', () => {
    const message = formatTestCoverageRefusal(
      ['browser/components/history/test/browser/browser_hist.js'],
      ['browser/components/tiles/test/browser/browser_a.js']
    );
    expect(message).toContain('browser/components/history/test/browser/browser_hist.js');
    expect(message).toContain('browser/components/tiles/test/browser/browser_a.js');
    expect(message).toContain(
      'fireforge test --build browser/components/history/test/browser/browser_hist.js'
    );
    expect(message).toContain('fireforge build');
    expect(message).toContain('not missing coverage');
  });

  it('names --extend-coverage, so the union is discoverable at the moment it is needed', () => {
    // A scoped build replaces the claim, so under concurrent sessions a
    // peer's build erases coverage you still hold. The flag that fixes that
    // is useless if the refusal never mentions it.
    const message = formatTestCoverageRefusal(
      ['browser/components/history/test/browser/browser_hist.js'],
      ['browser/components/tiles/test/browser/browser_a.js']
    );
    expect(message).toContain('--extend-coverage');
    expect(message).toContain('engine HEAD');
    expect(message).toContain('engine/mozconfig');
  });

  // The refusal was already correct. What it left to the reader was why
  // this run needs coverage. A manifest that gained an entry is the fact
  // that explains it, and FireForge already holds it.
  it('names the changed manifest that explains the uncovered path', () => {
    const message = formatTestCoverageRefusal(
      ['browser/modules/hominis/test/unit/test_Protection.js'],
      ['browser/base/content/test/browser/browser_a.js'],
      ['browser/modules/hominis/test/unit/xpcshell.toml']
    );
    expect(message).toContain('browser/modules/hominis/test/unit/xpcshell.toml');
    expect(message).toContain('a test manifest changed since it');
  });

  it('renders nothing extra when no manifest explains the refusal', () => {
    const message = formatTestCoverageRefusal(['browser/a/test_x.js'], ['browser/b/test']);
    expect(message).not.toContain('test manifest changed');
  });

  it('omits the --extend-coverage hint when there is no scoped rebuild to attach it to', () => {
    const message = formatTestCoverageRefusal([FULL_SUITE_REQUEST], ['browser/foo/test']);
    expect(message).not.toContain('--extend-coverage');
  });

  it('suggests a full rebuild for a full-suite request instead of an empty --build list', () => {
    const message = formatTestCoverageRefusal([FULL_SUITE_REQUEST], ['browser/foo/test']);
    expect(message).toContain(FULL_SUITE_REQUEST);
    expect(message).not.toContain('fireforge test --build "');
    expect(message).toContain('full coverage');
  });

  it('caps long path lists with a (+N more) tail', () => {
    const uncovered = Array.from({ length: 14 }, (_, i) => `browser/foo/test_${String(i)}.js`);
    const message = formatTestCoverageRefusal(uncovered, ['browser/bar/test']);
    expect(message).toContain('(+4 more)');
  });
});

describe('isXpcomManifestPath', () => {
  it('recognizes components.conf at any depth', () => {
    expect(isXpcomManifestPath('components.conf')).toBe(true);
    expect(isXpcomManifestPath('browser/components/mybrowser/components.conf')).toBe(true);
    expect(isXpcomManifestPath('browser\\components\\mybrowser\\components.conf')).toBe(true);
  });

  it('rejects everything else, including near-misses', () => {
    expect(isXpcomManifestPath('browser/components/mybrowser/components.conf.bak')).toBe(false);
    expect(isXpcomManifestPath('browser/components/mybrowser/jar.mn')).toBe(false);
    expect(isXpcomManifestPath('browser/components.conf/moz.build')).toBe(false);
  });
});

describe('checkStaticComponentsStale', () => {
  const anchoredBaseline = (fingerprints: Record<string, string> = {}): BuildBaseline => ({
    // A scoped `test --build` advanced the top-level SHA. The anchor keeps
    // the last full build's SHA. The check must diff against the anchor.
    engineHeadSha: 'scoped-sha',
    builtAt: new Date().toISOString(),
    binaryName: 'mybrowser',
    testPackagingCoverage: ['browser/components/mybrowser/test/unit/test_reg.js'],
    staticComponentsBaseline: { engineHeadSha: 'full-sha', fingerprints },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGit.mockResolvedValue('');
    mockHasChanges.mockResolvedValue(false);
    mockGetUntracked.mockResolvedValue([]);
  });

  it('returns fresh when there is no baseline at all', async () => {
    const result = await checkStaticComponentsStale('/project/engine', undefined);
    expect(result).toEqual({ stale: false, changedManifests: [] });
    expect(mockGit).not.toHaveBeenCalled();
  });

  it('returns fresh on a baseline without an anchor', async () => {
    const legacy = anchoredBaseline();
    delete (legacy as { staticComponentsBaseline?: unknown }).staticComponentsBaseline;
    const result = await checkStaticComponentsStale('/project/engine', legacy);
    expect(result).toEqual({ stale: false, changedManifests: [] });
    expect(mockGit).not.toHaveBeenCalled();
  });

  it('flags a components.conf changed since the last full build, ignoring other paths', async () => {
    mockGit.mockResolvedValueOnce(
      'browser/components/mybrowser/components.conf\nbrowser/base/content/mybrowser.js\n'
    );

    const result = await checkStaticComponentsStale('/project/engine', anchoredBaseline());
    expect(result.stale).toBe(true);
    expect(result.changedManifests).toEqual(['browser/components/mybrowser/components.conf']);
  });

  it('anchors the diff to the full-build SHA, not the scoped baseline SHA', async () => {
    await checkStaticComponentsStale('/project/engine', anchoredBaseline());
    expect(mockGit).toHaveBeenCalledWith(
      ['diff', '--name-only', 'full-sha..HEAD'],
      '/project/engine'
    );
  });

  it('treats a dirty manifest whose content still matches the anchor fingerprint as fresh', async () => {
    const { mkdtemp, writeFile: fsWriteFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const pathMod = await import('node:path');
    const joinPath = (...parts: string[]): string => pathMod.join(...parts);
    const { createHash } = await import('node:crypto');

    const engineDir = await mkdtemp(joinPath(tmpdir(), 'ff-static-comp-'));
    try {
      const relPath = 'browser/components/mybrowser/components.conf';
      const { ensureDir } = await import('../../utils/fs.js');
      await ensureDir(joinPath(engineDir, 'browser/components/mybrowser'));
      const content = "Classes = [{'cid': '{deadbeef}'}]\n";
      await fsWriteFile(joinPath(engineDir, relPath), content);
      const hash = createHash('sha256').update(content).digest('hex');

      mockGit.mockResolvedValueOnce(`${relPath}\n`);

      const result = await checkStaticComponentsStale(
        engineDir,
        anchoredBaseline({ [relPath]: hash })
      );
      expect(result).toEqual({ stale: false, changedManifests: [] });
    } finally {
      await rm(engineDir, { recursive: true, force: true });
    }
  });

  it('still flags a manifest whose live content diverges from the anchor fingerprint', async () => {
    const { mkdtemp, writeFile: fsWriteFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const pathMod = await import('node:path');
    const joinPath = (...parts: string[]): string => pathMod.join(...parts);
    const { createHash } = await import('node:crypto');

    const engineDir = await mkdtemp(joinPath(tmpdir(), 'ff-static-comp-'));
    try {
      const relPath = 'browser/components/mybrowser/components.conf';
      const { ensureDir } = await import('../../utils/fs.js');
      await ensureDir(joinPath(engineDir, 'browser/components/mybrowser'));
      await fsWriteFile(joinPath(engineDir, relPath), 'edited registration\n');
      const oldHash = createHash('sha256').update('old registration\n').digest('hex');

      mockGit.mockResolvedValueOnce(`${relPath}\n`);

      const result = await checkStaticComponentsStale(
        engineDir,
        anchoredBaseline({ [relPath]: oldHash })
      );
      expect(result.stale).toBe(true);
      expect(result.changedManifests).toEqual([relPath]);
    } finally {
      await rm(engineDir, { recursive: true, force: true });
    }
  });

  it('treats a components.conf deletion recorded by the full build as fresh', async () => {
    const relPath = 'browser/components/mybrowser/components.conf';
    mockGit.mockResolvedValueOnce(`${relPath}\n`);

    const result = await checkStaticComponentsStale(
      '/project/engine',
      anchoredBaseline({ [relPath]: DELETED_FILE_FINGERPRINT })
    );
    expect(result).toEqual({ stale: false, changedManifests: [] });
  });

  it('degrades to fresh when the git probes fail (broken probe must not block tests)', async () => {
    mockGit.mockRejectedValue(new Error('git unavailable'));
    mockHasChanges.mockRejectedValue(new Error('git unavailable'));

    const result = await checkStaticComponentsStale('/project/engine', anchoredBaseline());
    expect(result).toEqual({ stale: false, changedManifests: [] });
  });
});

describe('warnIfStaticComponentsStale', () => {
  const staleBaseline = (): BuildBaseline => ({
    engineHeadSha: 'scoped-sha',
    builtAt: new Date().toISOString(),
    binaryName: 'mybrowser',
    staticComponentsBaseline: { engineHeadSha: 'full-sha', fingerprints: {} },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGit.mockResolvedValue('');
    mockHasChanges.mockResolvedValue(false);
    mockGetUntracked.mockResolvedValue([]);
  });

  it('warns with the post-mutation copy when components.conf diverged', async () => {
    mockReadBaseline.mockResolvedValue(staleBaseline());
    mockGit.mockResolvedValueOnce('browser/components/mybrowser/components.conf\n');

    await warnIfStaticComponentsStale('/project', '/project/engine');

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('components.conf changed relative to the last full "fireforge build"')
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('will require a full "fireforge build" first')
    );
  });

  it('stays silent when there is no baseline', async () => {
    mockReadBaseline.mockResolvedValue(undefined);

    await warnIfStaticComponentsStale('/project', '/project/engine');

    expect(warn).not.toHaveBeenCalled();
  });

  it('stays silent when the manifests still match the anchor', async () => {
    mockReadBaseline.mockResolvedValue(staleBaseline());
    mockGit.mockResolvedValueOnce('browser/base/content/mybrowser.js\n');

    await warnIfStaticComponentsStale('/project', '/project/engine');

    expect(warn).not.toHaveBeenCalled();
  });

  it('never throws when the probe fails', async () => {
    mockReadBaseline.mockRejectedValue(new Error('disk gone'));

    await expect(
      warnIfStaticComponentsStale('/project', '/project/engine')
    ).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('formatPostMutationStaticComponentsWarning', () => {
  it('names the manifests and the full-build requirement', () => {
    const message = formatPostMutationStaticComponentsWarning([
      'browser/components/mybrowser/components.conf',
    ]);
    expect(message).toContain('browser/components/mybrowser/components.conf');
    expect(message).toContain('the next "fireforge test" will require a full "fireforge build"');
    expect(message).toContain('cannot regenerate the compiled table');
  });

  it('caps long manifest lists with a (+N more) tail', () => {
    const manifests = Array.from(
      { length: 13 },
      (_, i) => `browser/components/c${String(i)}/components.conf`
    );
    expect(formatPostMutationStaticComponentsWarning(manifests)).toContain('(+3 more)');
  });
});

describe('formatStaticComponentsRefusal', () => {
  it('names the manifest, the NS_ERROR_MALFORMED_URI symptom, and advises fireforge build', () => {
    const message = formatStaticComponentsRefusal(['browser/components/mybrowser/components.conf']);
    expect(message).toContain('browser/components/mybrowser/components.conf');
    expect(message).toContain('NS_ERROR_MALFORMED_URI');
    expect(message).toContain('Run "fireforge build" first.');
    expect(message).toContain('--allow-stale-components');
    expect(message).toContain('--allow-stale-build does not bypass this check');
  });

  it('caps long manifest lists with a (+N more) tail', () => {
    const manifests = Array.from(
      { length: 13 },
      (_, i) => `browser/components/c${String(i)}/components.conf`
    );
    const message = formatStaticComponentsRefusal(manifests);
    expect(message).toContain('(+3 more)');
  });
});

describe('findChangedTestManifestsForPaths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(hasChanges).mockResolvedValue(true);
    vi.mocked(getUntrackedFiles).mockResolvedValue([]);
  });

  const baseline: BuildBaseline = {
    engineHeadSha: 'abc',
    builtAt: new Date().toISOString(),
    binaryName: 'testbrowser',
  };

  it('names a changed manifest sitting above an uncovered request path', async () => {
    vi.mocked(git).mockResolvedValue(
      'browser/modules/hominis/test/unit/xpcshell.toml\nbrowser/base/content/foo.js\n'
    );
    const found = await findChangedTestManifestsForPaths('/engine', baseline, [
      'browser/modules/hominis/test/unit/test_Protection.js',
    ]);
    expect(found).toEqual(['browser/modules/hominis/test/unit/xpcshell.toml']);
  });

  it('ignores a manifest in an unrelated directory', async () => {
    vi.mocked(git).mockResolvedValue('browser/elsewhere/xpcshell.toml\n');
    expect(
      await findChangedTestManifestsForPaths('/engine', baseline, ['browser/modules/x/test_a.js'])
    ).toEqual([]);
  });

  it('ignores a full-suite request, which no manifest explains', async () => {
    vi.mocked(git).mockResolvedValue('browser/modules/x/xpcshell.toml\n');
    expect(
      await findChangedTestManifestsForPaths('/engine', baseline, [FULL_SUITE_REQUEST])
    ).toEqual([]);
  });

  // Best-effort: a broken probe must degrade the refusal to its previous
  // text, never fail the run differently.
  it('returns nothing when the probe throws', async () => {
    vi.mocked(hasChanges).mockRejectedValue(new Error('no git'));
    vi.mocked(git).mockRejectedValue(new Error('no git'));
    expect(
      await findChangedTestManifestsForPaths('/engine', baseline, ['browser/x/test_a.js'])
    ).toEqual([]);
  });
});
