// SPDX-License-Identifier: EUPL-1.2
import type { Stats } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFsMock } from '../../test-utils/module-mocks.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, stat: vi.fn() };
});

vi.mock('../../utils/process.js', () => ({
  exec: vi.fn(),
}));

vi.mock('../../utils/fs.js', () => createFsMock());

vi.mock('../git-base.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../git-base.js')>();
  // Keep the real `chunkPathspecs` (a pure helper used by the batched diff) and
  // mock only the git-invoking surface.
  return { ...actual, ensureGit: vi.fn(), git: vi.fn() };
});

vi.mock('../git-file-ops.js', () => ({
  fileExistsInHead: vi.fn(),
  isBinaryFile: vi.fn(),
  listTrackedInHead: vi.fn(),
  hashObjectBatch: vi.fn(),
}));

vi.mock('../git-status.js', () => ({
  getUntrackedFiles: vi.fn(),
  getUntrackedFilesInDir: vi.fn(),
}));

// The new-file classifier reads real bytes; here it is re-expressed over the
// mocked `isBinaryFile` + `readText` pair so every case below keeps driving
// the classification through those two stubs. The classifier's own
// (UTF-8 vs Latin-1) behaviour is tested against real files in
// `git-diff-new-file.test.ts` and `git-diff-latin1-roundtrip.test.ts`.
vi.mock('../git-diff-new-file.js', () => ({
  readNewFileContent: vi.fn(),
  // No temp attributes file at this level: the cases below pin the exact git
  // argv, and the forced `-diff` attribute is pinned against real git in
  // `git-diff-latin1-roundtrip.test.ts`.
  withForcedBinaryAttribute: vi.fn((_filePath: string, task: (args: string[]) => unknown) =>
    task([])
  ),
}));

// The private-index path is exercised against a real repository in
// `binary-patch-index-isolation.test.ts`, where the whole point — that a
// concurrent `git status` never observes the staging — is observable. These
// mock-level cases describe the SHARED-index fallback, so the mint is stubbed
// off by default and turned on only for the case that asserts it is preferred.
vi.mock('../git-readonly-index.js', () => ({
  readOnlyGitIndexEnv: vi.fn(() => undefined),
  mintDisposableGitIndex: vi.fn(() => Promise.resolve(undefined)),
}));

import { stat } from 'node:fs/promises';

import { pathExists, readText } from '../../utils/fs.js';
import { exec } from '../../utils/process.js';
import { git } from '../git-base.js';
import {
  generateBinaryFilePatch,
  generateFullFilePatch,
  generateNewFileDiff,
  getAllDiff,
  getDiffForFilesAgainstHead,
  getFileDiff,
  getStagedDiffForFiles,
} from '../git-diff.js';
import { readNewFileContent } from '../git-diff-new-file.js';
import {
  fileExistsInHead,
  hashObjectBatch,
  isBinaryFile,
  listTrackedInHead,
} from '../git-file-ops.js';
import { mintDisposableGitIndex } from '../git-readonly-index.js';
import { getUntrackedFiles, getUntrackedFilesInDir } from '../git-status.js';

const mockExec = vi.mocked(exec);
const mockGit = vi.mocked(git);
const mockPathExists = vi.mocked(pathExists);
const mockReadText = vi.mocked(readText);
const mockFileExistsInHead = vi.mocked(fileExistsInHead);
const mockIsBinaryFile = vi.mocked(isBinaryFile);
const mockListTrackedInHead = vi.mocked(listTrackedInHead);
const mockHashObjectBatch = vi.mocked(hashObjectBatch);
const mockGetUntrackedFiles = vi.mocked(getUntrackedFiles);
const mockGetUntrackedFilesInDir = vi.mocked(getUntrackedFilesInDir);
const mockStat = vi.mocked(stat);

const makeStat = (isDir: boolean): Stats => ({ isDirectory: () => isDir }) as unknown as Stats;

beforeEach(() => {
  vi.clearAllMocks();
  // Default: every `stat` lookup reports a regular file. The two tests
  // that exercise the directory-detection paths override this.
  mockStat.mockResolvedValue(makeStat(false));
  mockIsBinaryFile.mockResolvedValue(false);
  vi.mocked(readNewFileContent).mockImplementation(async (repoDir, file) =>
    (await isBinaryFile(repoDir, file))
      ? { binary: true }
      : { binary: false, content: await readText(join(repoDir, file)) }
  );
  // Batched git helpers default to "nothing tracked" + a stable blob hash per
  // path, so a test that only cares about the new-file path need not wire them.
  mockListTrackedInHead.mockResolvedValue(new Set());
  mockHashObjectBatch.mockImplementation((_repoDir, paths) =>
    Promise.resolve(new Map(paths.map((path) => [path, 'abcdef1234567890'])))
  );
});

describe('getFileDiff', () => {
  it('calls ensureGit and returns git diff HEAD stdout', async () => {
    mockGit.mockResolvedValue('diff --git a/f b/f\n');

    const result = await getFileDiff('/repo', 'file.txt');
    expect(result).toBe('diff --git a/f b/f\n');
    expect(mockGit).toHaveBeenCalledWith(['diff', '--binary', 'HEAD', '--', 'file.txt'], '/repo');
  });

  it('throws when git diff fails', async () => {
    mockGit.mockRejectedValue(new Error('fatal: invalid object name HEAD'));

    await expect(getFileDiff('/repo', 'file.txt')).rejects.toThrow('invalid object name HEAD');
  });
});

describe('generateNewFileDiff', () => {
  it('generates diff for empty file', async () => {
    mockReadText.mockResolvedValue('');
    mockGit.mockResolvedValue('abcdef1234567890\n');

    const result = await generateNewFileDiff('/repo', 'empty.txt');
    expect(result).toContain('new file mode 100644');
    expect(result).toContain('--- /dev/null');
    expect(result).not.toContain('@@');
  });

  it('generates diff for file with trailing newline', async () => {
    mockReadText.mockResolvedValue('line1\nline2\n');
    mockGit.mockResolvedValue('abcdef1234567890\n');

    const result = await generateNewFileDiff('/repo', 'test.txt');
    expect(result).toContain('@@ -0,0 +1,2 @@');
    expect(result).toContain('+line1');
    expect(result).toContain('+line2');
    expect(result).not.toContain('No newline at end of file');
  });

  it('adds no-newline marker for file without trailing newline', async () => {
    mockReadText.mockResolvedValue('line1\nline2');
    mockGit.mockResolvedValue('abcdef1234567890\n');

    const result = await generateNewFileDiff('/repo', 'test.txt');
    expect(result).toContain('\\ No newline at end of file');
  });

  it('falls back to zeroes when hash-object fails', async () => {
    mockReadText.mockResolvedValue('content\n');
    mockGit.mockRejectedValue(new Error('hash-object failed'));

    const result = await generateNewFileDiff('/repo', 'test.txt');
    expect(result).toContain('index 0000000000..0000000000');
  });

  it('rejects a directory path with an actionable GitError', async () => {
    // Guards against the EISDIR regression: if a caller ever hands a
    // directory to the leaf reader, surface a named error instead of
    // the raw `EISDIR: illegal operation on a directory, read` that
    // `readText` would otherwise throw.
    mockStat.mockResolvedValue(makeStat(true));

    await expect(generateNewFileDiff('/repo', 'browser/modules/fork')).rejects.toThrow(
      "expected a file but found a directory at 'browser/modules/fork'"
    );
  });
});

describe('generateFullFilePatch', () => {
  it('uses getFileDiff for tracked files', async () => {
    mockFileExistsInHead.mockResolvedValue(true);
    mockGit.mockResolvedValue('tracked diff\n');

    const result = await generateFullFilePatch('/repo', 'tracked.txt');
    expect(result).toBe('tracked diff\n');
  });

  it('uses generateNewFileDiff for untracked files', async () => {
    mockFileExistsInHead.mockResolvedValue(false);
    mockReadText.mockResolvedValue('new content\n');
    mockGit.mockResolvedValue('abc1234567\n');

    const result = await generateFullFilePatch('/repo', 'new.txt');
    expect(result).toContain('new file mode 100644');
  });
});

describe('getAllDiff', () => {
  it('combines tracked and untracked diffs', async () => {
    mockGit.mockResolvedValue('tracked diff\n');
    mockGetUntrackedFiles.mockResolvedValue(['new.txt']);
    mockReadText.mockResolvedValue('new content\n');

    const result = await getAllDiff('/repo');
    expect(result).toContain('tracked diff');
    expect(result).toContain('new file mode 100644');
  });

  it('handles no untracked files', async () => {
    mockGit.mockResolvedValue('tracked diff\n');
    mockGetUntrackedFiles.mockResolvedValue([]);

    const result = await getAllDiff('/repo');
    expect(result).toBe('tracked diff\n');
  });

  it('handles empty tracked diff', async () => {
    mockGit.mockResolvedValue('');
    mockGetUntrackedFiles.mockResolvedValue([]);

    const result = await getAllDiff('/repo');
    expect(result).toBe('\n');
  });

  it('throws when the tracked diff command fails', async () => {
    mockGit.mockRejectedValue(new Error('fatal: bad revision HEAD'));

    await expect(getAllDiff('/repo')).rejects.toThrow('bad revision HEAD');
  });
});

describe('getDiffForFilesAgainstHead', () => {
  // Drives the batched tracked path: `git diff --no-renames HEAD` returns the
  // section(s), and the companion `--name-only -z` returns the raw paths in the
  // SAME order, so the splitter can pair them positionally. `getFileDiff`
  // (the count-mismatch fallback) uses `git diff HEAD -- <file>` (no
  // `--no-renames`); it is left to the individual tests to wire when needed.
  function mockTrackedDiff(sectionsByPath: Record<string, string>): void {
    mockGit.mockImplementation((args: string[]) => {
      const dashDash = args.indexOf('--');
      const paths = dashDash === -1 ? [] : args.slice(dashDash + 1);
      if (args.includes('--name-only')) {
        const present = paths.filter((p) => sectionsByPath[p] !== undefined);
        return Promise.resolve(present.length > 0 ? present.join('\0') + '\0' : '');
      }
      return Promise.resolve(
        paths
          .map((p) => sectionsByPath[p])
          .filter((section): section is string => section !== undefined)
          .join('')
      );
    });
  }

  it('returns the per-file diff section for a tracked changed file', async () => {
    const section =
      'diff --git a/file.txt b/file.txt\nindex 111..222 100644\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n';
    mockListTrackedInHead.mockResolvedValue(new Set(['file.txt']));
    mockTrackedDiff({ 'file.txt': section });

    const result = await getDiffForFilesAgainstHead('/repo', ['file.txt']);
    expect(result).toBe(section);
  });

  it('emits tracked sections in sorted order, interleaved with new files', async () => {
    // Mixed set proves reassembly is driven by the sorted input, not by git's
    // emission order or by tracked-then-new grouping.
    const aSection = 'diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-a0\n+a1\n';
    const cSection = 'diff --git a/c.txt b/c.txt\n@@ -1 +1 @@\n-c0\n+c1\n';
    mockListTrackedInHead.mockResolvedValue(new Set(['a.txt', 'c.txt']));
    mockTrackedDiff({ 'a.txt': aSection, 'c.txt': cSection });
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('b-content\n');
    // Key the batch result by the same join()-built path the source looks up,
    // so the mock also matches the backslash form on Windows.
    mockHashObjectBatch.mockResolvedValue(new Map([[join('/repo', 'b.txt'), 'bbbbbbbbbbbb']]));

    const result = await getDiffForFilesAgainstHead('/repo', ['c.txt', 'b.txt', 'a.txt']);
    const order = [result.indexOf('a/a.txt'), result.indexOf('a/b.txt'), result.indexOf('a/c.txt')];
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(result).toContain('new file mode 100644');
  });

  it('synthesizes a new-file diff for an untracked existing text file', async () => {
    mockListTrackedInHead.mockResolvedValue(new Set());
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('content\n');
    mockHashObjectBatch.mockResolvedValue(new Map([[join('/repo', 'new.txt'), 'abc1234567890']]));

    const result = await getDiffForFilesAgainstHead('/repo', ['new.txt']);
    expect(result).toContain('new file mode 100644');
    expect(result).toContain('index 0000000000..abc1234567');
    expect(result).toContain('+content');
  });

  it('falls back to the zero blob hash when the batch has no hash for a file', async () => {
    mockListTrackedInHead.mockResolvedValue(new Set());
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('content\n');
    mockHashObjectBatch.mockResolvedValue(new Map());

    const result = await getDiffForFilesAgainstHead('/repo', ['new.txt']);
    expect(result).toContain('index 0000000000..0000000000');
  });

  it('attributes a section to its path even when the diff header is C-quoted', async () => {
    // core.quotePath (default on) C-quotes non-ASCII headers; the companion
    // --name-only -z emits the raw path, so positional pairing keys correctly
    // where parsing the `diff --git` line would not.
    const quoted =
      'diff --git "a/na\\303\\257ve.txt" "b/na\\303\\257ve.txt"\nindex 1..2 100644\n--- "a/na\\303\\257ve.txt"\n+++ "b/na\\303\\257ve.txt"\n@@ -1 +1 @@\n-x\n+y\n';
    mockListTrackedInHead.mockResolvedValue(new Set(['naïve.txt']));
    mockGit.mockImplementation((args: string[]) =>
      Promise.resolve(args.includes('--name-only') ? 'naïve.txt\0' : quoted)
    );

    const result = await getDiffForFilesAgainstHead('/repo', ['naïve.txt']);
    expect(result).toBe(quoted);
  });

  it('keeps an embedded `diff --git` content line inside its section', async () => {
    // A context line that literally reads `diff --git ...` is indented by the
    // leading context space, so the column-0 boundary scan must not split on it.
    const section =
      'diff --git a/a.txt b/a.txt\nindex 1..2 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n diff --git a/fake b/fake\n-x\n+y\n';
    mockListTrackedInHead.mockResolvedValue(new Set(['a.txt']));
    mockTrackedDiff({ 'a.txt': section });

    const result = await getDiffForFilesAgainstHead('/repo', ['a.txt']);
    expect(result).toBe(section);
  });

  it('falls back to per-file diff when section and name counts disagree', async () => {
    // Defensive: an unmodeled config that drops a section must degrade to the
    // exact per-file bytes rather than silently lose a file's diff.
    mockListTrackedInHead.mockResolvedValue(new Set(['a.txt', 'b.txt']));
    mockGit.mockImplementation((args: string[]) => {
      if (args.includes('--name-only')) return Promise.resolve('a.txt\0b.txt\0'); // two names…
      if (args.includes('--no-renames')) {
        // …but one section
        return Promise.resolve('diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-x\n+y\n');
      }
      // Per-file getFileDiff fallback: git diff HEAD -- <file>
      const file = args[args.length - 1];
      return Promise.resolve(`diff --git a/${file} b/${file}\n@@ -1 +1 @@\n-old\n+new\n`);
    });

    const result = await getDiffForFilesAgainstHead('/repo', ['a.txt', 'b.txt']);
    expect(result).toContain('diff --git a/a.txt b/a.txt');
    expect(result).toContain('diff --git a/b.txt b/b.txt');
  });

  it('passes a tracked binary modification through without staging the index', async () => {
    const binarySection =
      'diff --git a/x.bin b/x.bin\nindex 1..2 100644\nBinary files a/x.bin and b/x.bin differ\n';
    mockListTrackedInHead.mockResolvedValue(new Set(['x.bin']));
    mockTrackedDiff({ 'x.bin': binarySection });

    const result = await getDiffForFilesAgainstHead('/repo', ['x.bin']);
    expect(result).toBe(binarySection);
    // generateBinaryFilePatch (which spawns `git add --intent-to-add`) must not
    // run for a tracked binary — that path is only for untracked binaries.
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('uses binary patches for untracked binary files', async () => {
    mockListTrackedInHead.mockResolvedValue(new Set());
    mockPathExists.mockResolvedValue(true);
    mockIsBinaryFile.mockResolvedValue(true);
    mockGit.mockImplementation((args: string[]) => {
      // Tracked binary probe returns empty → fall through to the staged path.
      if (args[0] === 'diff' && args.includes('HEAD')) return Promise.resolve('');
      if (args[0] === 'diff') return Promise.resolve('GIT binary patch\nliteral 1\nA\n');
      return Promise.resolve(''); // add / reset
    });

    const result = await getDiffForFilesAgainstHead('/repo', ['brand/icon.png']);

    expect(result).toContain('GIT binary patch');
    expect(mockReadText).not.toHaveBeenCalled();
    expect(mockGit).toHaveBeenCalledWith(
      ['add', '--intent-to-add', '--', 'brand/icon.png'],
      '/repo'
    );
  });

  it('skips files that do not exist on disk', async () => {
    mockListTrackedInHead.mockResolvedValue(new Set());
    mockPathExists.mockResolvedValue(false);

    const result = await getDiffForFilesAgainstHead('/repo', ['gone.txt']);
    expect(result).toBe('');
  });

  it('deduplicates files before classifying them', async () => {
    mockListTrackedInHead.mockResolvedValue(new Set(['a.txt']));
    mockTrackedDiff({ 'a.txt': 'diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-x\n+y\n' });

    await getDiffForFilesAgainstHead('/repo', ['a.txt', 'a.txt']);
    expect(mockListTrackedInHead).toHaveBeenCalledWith('/repo', ['a.txt']);
  });

  it('issues a constant number of git operations regardless of file count', async () => {
    // The headline regression guard: if anyone reverts to a per-file loop, the
    // tracked-diff and hash-object call counts would scale with N. They must
    // not — classification, diffing, and hashing are each one batched call.
    const runWith = async (
      count: number
    ): Promise<{ listTracked: number; git: number; hashObject: number }> => {
      vi.clearAllMocks();
      mockStat.mockResolvedValue(makeStat(false));
      mockIsBinaryFile.mockResolvedValue(false);
      mockPathExists.mockResolvedValue(true);
      mockReadText.mockResolvedValue('content\n');
      mockHashObjectBatch.mockImplementation((_repoDir, paths) =>
        Promise.resolve(new Map(paths.map((path) => [path, 'abcdef1234567890'])))
      );

      const tracked = Array.from({ length: count }, (_, i) => `t${String(i).padStart(4, '0')}.txt`);
      const fresh = Array.from({ length: count }, (_, i) => `z${String(i).padStart(4, '0')}.txt`);
      mockListTrackedInHead.mockResolvedValue(new Set(tracked));
      mockGit.mockImplementation((args: string[]) => {
        const dashDash = args.indexOf('--');
        const paths = dashDash === -1 ? [] : args.slice(dashDash + 1);
        if (args.includes('--name-only')) {
          return Promise.resolve(paths.length ? paths.join('\0') + '\0' : '');
        }
        return Promise.resolve(
          paths.map((p) => `diff --git a/${p} b/${p}\n@@ -1 +1 @@\n-x\n+y\n`).join('')
        );
      });

      await getDiffForFilesAgainstHead('/repo', [...fresh, ...tracked]);
      return {
        listTracked: mockListTrackedInHead.mock.calls.length,
        git: mockGit.mock.calls.length,
        hashObject: mockHashObjectBatch.mock.calls.length,
      };
    };

    const small = await runWith(10);
    const large = await runWith(200);
    expect(small.listTracked).toBe(1);
    expect(small.git).toBe(2); // one `diff`, one `--name-only`
    expect(small.hashObject).toBe(1);
    expect(large).toEqual(small);
  });

  it('expands untracked directory entries before diffing', async () => {
    // `git status --porcelain=v1 -z` reports collapsed untracked dirs as
    // `?? dir/`; a caller that hands that entry to this function used to
    // crash with EISDIR reading the directory as a file.
    mockGetUntrackedFilesInDir.mockResolvedValue([
      'browser/modules/fork/Foo.sys.mjs',
      'browser/modules/fork/Bar.sys.mjs',
    ]);
    mockListTrackedInHead.mockResolvedValue(new Set());
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('content\n');

    const result = await getDiffForFilesAgainstHead('/repo', ['browser/modules/fork/']);

    expect(mockGetUntrackedFilesInDir).toHaveBeenCalledWith('/repo', 'browser/modules/fork/');
    expect(result).toContain('diff --git a/browser/modules/fork/Bar.sys.mjs');
    expect(result).toContain('diff --git a/browser/modules/fork/Foo.sys.mjs');
  });

  it('expands a directory path without a trailing slash', async () => {
    // Aggregate lint crashes with a raw `EISDIR` when a directory entry
    // reaches this function without the trailing slash the caller-side
    // `expandUntrackedDirectoryEntries` would have emitted. The
    // trailing-slash guard above misses it; the in-loop `stat` check expands
    // it via the same helper.
    mockListTrackedInHead.mockResolvedValue(new Set());
    mockPathExists.mockResolvedValue(true);
    // Compare against the join()-built path the source computes so the
    // directory is still recognized under Windows backslash separators.
    const dirFullPath = join('/repo', 'browser/modules/fork');
    mockStat.mockImplementation((path) => Promise.resolve(makeStat(path === dirFullPath)));
    mockGetUntrackedFilesInDir.mockResolvedValue([
      'browser/modules/fork/Foo.sys.mjs',
      'browser/modules/fork/Bar.sys.mjs',
    ]);
    mockReadText.mockResolvedValue('content\n');

    const result = await getDiffForFilesAgainstHead('/repo', ['browser/modules/fork']);

    expect(mockGetUntrackedFilesInDir).toHaveBeenCalledWith('/repo', 'browser/modules/fork');
    expect(result).toContain('diff --git a/browser/modules/fork/Bar.sys.mjs');
    expect(result).toContain('diff --git a/browser/modules/fork/Foo.sys.mjs');
  });

  it('raises an actionable GitError when a non-slash directory has no readable content', async () => {
    // Submodule / gitignored directory: `stat` reports a directory but
    // `ls-files --others` returns nothing. Skipping silently would
    // mask the real bug; fail loud with the path instead.
    mockListTrackedInHead.mockResolvedValue(new Set());
    mockPathExists.mockResolvedValue(true);
    mockStat.mockResolvedValue(makeStat(true));
    mockGetUntrackedFilesInDir.mockResolvedValue([]);

    await expect(
      getDiffForFilesAgainstHead('/repo', ['browser/modules/submodule'])
    ).rejects.toThrow("'browser/modules/submodule' is a directory with no untracked content");
  });
});

describe('getStagedDiffForFiles', () => {
  it('runs git diff --cached HEAD for provided files', async () => {
    mockGit.mockResolvedValue('staged diff\n');

    const result = await getStagedDiffForFiles('/repo', ['a.txt', 'b.txt']);
    expect(result).toBe('staged diff\n');
    expect(mockGit).toHaveBeenCalledWith(
      ['diff', '--binary', '--cached', 'HEAD', '--', 'a.txt', 'b.txt'],
      '/repo'
    );
  });

  it('throws when staged diff generation fails', async () => {
    mockGit.mockRejectedValue(new Error('fatal: bad revision HEAD'));

    await expect(getStagedDiffForFiles('/repo', ['a.txt'])).rejects.toThrow('bad revision HEAD');
  });
});

describe('generateBinaryFilePatch', () => {
  it('returns diff for tracked binary file', async () => {
    mockGit.mockResolvedValue('binary diff\n');

    const result = await generateBinaryFilePatch('/repo', 'image.png');
    expect(result).toBe('binary diff\n');
    expect(mockGit).toHaveBeenCalledWith(['diff', '--binary', 'HEAD', '--', 'image.png'], '/repo');
  });

  it('stages into a PRIVATE index when one can be minted, and restores nothing', async () => {
    // The shared index is what a concurrent `fireforge test` fingerprints, so
    // a visible stage/restore pair voids healthy verdicts. A private index
    // makes the write unobservable — and makes the restore unnecessary,
    // because nothing shared was touched.
    const dispose = vi.fn(() => Promise.resolve());
    vi.mocked(mintDisposableGitIndex).mockResolvedValueOnce({
      env: { GIT_INDEX_FILE: '/tmp/private/index' },
      dispose,
    });
    mockGit
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('untracked binary diff\n');

    const result = await generateBinaryFilePatch('/repo', 'new.png');

    expect(result).toBe('untracked binary diff\n');
    expect(mockGit).toHaveBeenCalledWith(['add', '--intent-to-add', '--', 'new.png'], '/repo', {
      env: { GIT_INDEX_FILE: '/tmp/private/index' },
    });
    expect(mockGit).not.toHaveBeenCalledWith(
      ['ls-files', '--stage', '--', 'new.png'],
      expect.anything()
    );
    expect(mockGit).not.toHaveBeenCalledWith(['reset', 'HEAD', '--', 'new.png'], expect.anything());
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('disposes the private index even when the diff throws', async () => {
    const dispose = vi.fn(() => Promise.resolve());
    vi.mocked(mintDisposableGitIndex).mockResolvedValueOnce({
      env: { GIT_INDEX_FILE: '/tmp/private/index' },
      dispose,
    });
    mockGit
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockRejectedValueOnce(new Error('diff failed'));

    await expect(generateBinaryFilePatch('/repo', 'new.png')).rejects.toThrow('diff failed');
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('stages untracked file with intent-to-add and cleans up (shared-index fallback)', async () => {
    // First call: tracked diff returns empty
    mockGit
      .mockResolvedValueOnce('')
      // Second call: git ls-files --stage (no prior index entry)
      .mockResolvedValueOnce('')
      // Third call: git add --intent-to-add
      .mockResolvedValueOnce('')
      // Fourth call: git diff --binary (untracked)
      .mockResolvedValueOnce('untracked binary diff\n')
      // Fifth call: git reset HEAD
      .mockResolvedValueOnce('');

    const result = await generateBinaryFilePatch('/repo', 'new.png');
    expect(result).toBe('untracked binary diff\n');
    expect(mockGit).toHaveBeenCalledWith(['add', '--intent-to-add', '--', 'new.png'], '/repo');
    expect(mockGit).toHaveBeenCalledWith(['reset', 'HEAD', '--', 'new.png'], '/repo');
  });

  it('unstages in finally even when diff throws', async () => {
    mockGit
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockRejectedValueOnce(new Error('diff failed'))
      .mockResolvedValueOnce('');

    await expect(generateBinaryFilePatch('/repo', 'new.png')).rejects.toThrow('diff failed');
    expect(mockGit).toHaveBeenCalledWith(['reset', 'HEAD', '--', 'new.png'], '/repo');
  });

  it('restores a pre-existing stage-0 index entry instead of resetting to HEAD', async () => {
    mockGit
      // Tracked diff returns empty (the race shape: the entry appeared after,
      // or the staged path's worktree file is gone so `diff HEAD` sees nothing)
      .mockResolvedValueOnce('')
      // ls-files --stage: a prior staged entry exists
      .mockResolvedValueOnce('100644 0123456789abcdef0123456789abcdef01234567 0\tnew.png\n')
      // add --intent-to-add
      .mockResolvedValueOnce('')
      // diff --binary
      .mockResolvedValueOnce('untracked binary diff\n')
      // update-index restore
      .mockResolvedValueOnce('');

    await generateBinaryFilePatch('/repo', 'new.png');

    expect(mockGit).toHaveBeenCalledWith(
      [
        'update-index',
        '--add',
        '--cacheinfo',
        '100644,0123456789abcdef0123456789abcdef01234567,new.png',
      ],
      '/repo'
    );
    expect(mockGit).not.toHaveBeenCalledWith(['reset', 'HEAD', '--', 'new.png'], '/repo');
  });

  it('falls back to reset HEAD for an unmerged prior entry that --cacheinfo cannot rebuild', async () => {
    mockGit
      .mockResolvedValueOnce('')
      // ls-files --stage: conflict stages, not a stage-0 entry
      .mockResolvedValueOnce(
        '100644 0123456789abcdef0123456789abcdef01234567 1\tnew.png\n' +
          '100644 89abcdef0123456789abcdef0123456789abcdef 2\tnew.png\n'
      )
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('untracked binary diff\n')
      .mockResolvedValueOnce('');

    await generateBinaryFilePatch('/repo', 'new.png');

    expect(mockGit).toHaveBeenCalledWith(['reset', 'HEAD', '--', 'new.png'], '/repo');
  });
});
