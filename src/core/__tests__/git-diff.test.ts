// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn(), mkdtemp: vi.fn(), rm: vi.fn() };
});

vi.mock('../../utils/process.js', () => ({
  exec: vi.fn(),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
  readText: vi.fn(),
}));

vi.mock('../git-base.js', () => ({
  ensureGit: vi.fn(),
}));

vi.mock('../git-file-ops.js', () => ({
  fileExistsInHead: vi.fn(),
}));

vi.mock('../git-status.js', () => ({
  getUntrackedFiles: vi.fn(),
}));

import { mkdtemp, rm, writeFile } from 'node:fs/promises';

import { pathExists, readText } from '../../utils/fs.js';
import { exec } from '../../utils/process.js';
import {
  generateBinaryFilePatch,
  generateFullFilePatch,
  generateModificationDiff,
  generateNewFileDiff,
  getAllDiff,
  getDiffForFilesAgainstHead,
  getFileDiff,
  getStagedDiffForFiles,
} from '../git-diff.js';
import { fileExistsInHead } from '../git-file-ops.js';
import { getUntrackedFiles } from '../git-status.js';

const mockExec = vi.mocked(exec);
const mockPathExists = vi.mocked(pathExists);
const mockReadText = vi.mocked(readText);
const mockFileExistsInHead = vi.mocked(fileExistsInHead);
const mockGetUntrackedFiles = vi.mocked(getUntrackedFiles);
const mockMkdtemp = vi.mocked(mkdtemp);
const mockWriteFile = vi.mocked(writeFile);
const mockRm = vi.mocked(rm);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getFileDiff', () => {
  it('calls ensureGit and returns git diff HEAD stdout', async () => {
    mockExec.mockResolvedValue({ stdout: 'diff --git a/f b/f\n', stderr: '', exitCode: 0 });

    const result = await getFileDiff('/repo', 'file.txt');
    expect(result).toBe('diff --git a/f b/f\n');
    expect(mockExec).toHaveBeenCalledWith('git', ['diff', 'HEAD', '--', 'file.txt'], {
      cwd: '/repo',
    });
  });
});

describe('generateNewFileDiff', () => {
  it('generates diff for empty file', async () => {
    mockReadText.mockResolvedValue('');
    mockExec.mockResolvedValue({ stdout: 'abcdef1234567890\n', stderr: '', exitCode: 0 });

    const result = await generateNewFileDiff('/repo', 'empty.txt');
    expect(result).toContain('new file mode 100644');
    expect(result).toContain('--- /dev/null');
    expect(result).not.toContain('@@');
  });

  it('generates diff for file with trailing newline', async () => {
    mockReadText.mockResolvedValue('line1\nline2\n');
    mockExec.mockResolvedValue({ stdout: 'abcdef1234567890\n', stderr: '', exitCode: 0 });

    const result = await generateNewFileDiff('/repo', 'test.txt');
    expect(result).toContain('@@ -0,0 +1,2 @@');
    expect(result).toContain('+line1');
    expect(result).toContain('+line2');
    expect(result).not.toContain('No newline at end of file');
  });

  it('adds no-newline marker for file without trailing newline', async () => {
    mockReadText.mockResolvedValue('line1\nline2');
    mockExec.mockResolvedValue({ stdout: 'abcdef1234567890\n', stderr: '', exitCode: 0 });

    const result = await generateNewFileDiff('/repo', 'test.txt');
    expect(result).toContain('\\ No newline at end of file');
  });

  it('falls back to zeroes when hash-object fails', async () => {
    mockReadText.mockResolvedValue('content\n');
    mockExec.mockRejectedValue(new Error('hash-object failed'));

    const result = await generateNewFileDiff('/repo', 'test.txt');
    expect(result).toContain('index 0000000000..0000000000');
  });
});

describe('generateFullFilePatch', () => {
  it('uses getFileDiff for tracked files', async () => {
    mockFileExistsInHead.mockResolvedValue(true);
    mockExec.mockResolvedValue({ stdout: 'tracked diff\n', stderr: '', exitCode: 0 });

    const result = await generateFullFilePatch('/repo', 'tracked.txt');
    expect(result).toBe('tracked diff\n');
  });

  it('uses generateNewFileDiff for untracked files', async () => {
    mockFileExistsInHead.mockResolvedValue(false);
    mockReadText.mockResolvedValue('new content\n');
    mockExec.mockResolvedValue({ stdout: 'abc1234567\n', stderr: '', exitCode: 0 });

    const result = await generateFullFilePatch('/repo', 'new.txt');
    expect(result).toContain('new file mode 100644');
  });
});

describe('generateModificationDiff', () => {
  it('returns empty string when contents are identical', async () => {
    mockReadText.mockResolvedValue('same content');

    const result = await generateModificationDiff('/repo', 'file.txt', 'same content');
    expect(result).toBe('');
  });

  it('generates diff and fixes header paths', async () => {
    mockReadText.mockResolvedValue('new content');
    mockMkdtemp.mockResolvedValue('/tmp/fireforge-diff-xxx');
    mockWriteFile.mockResolvedValue(undefined);
    mockExec.mockResolvedValue({
      stdout:
        'diff --git a//tmp/fireforge-diff-xxx/file.txt b//repo/file.txt\n--- a//tmp/fireforge-diff-xxx/file.txt\n+++ b//repo/file.txt\n@@ -1 +1 @@\n-old content\n+new content\n',
      stderr: '',
      exitCode: 1,
    });

    const result = await generateModificationDiff('/repo', 'file.txt', 'old content');
    expect(result).toContain('diff --git a/file.txt b/file.txt');
    expect(result).toContain('--- a/file.txt');
    expect(result).toContain('+++ b/file.txt');
  });

  it('cleans up temp dir even when diff throws', async () => {
    mockReadText.mockResolvedValue('new content');
    mockMkdtemp.mockResolvedValue('/tmp/fireforge-diff-xxx');
    mockWriteFile.mockResolvedValue(undefined);
    mockExec.mockRejectedValue(new Error('git failed'));

    await expect(generateModificationDiff('/repo', 'file.txt', 'old content')).rejects.toThrow(
      'git failed'
    );
    expect(mockRm).toHaveBeenCalledWith('/tmp/fireforge-diff-xxx', {
      recursive: true,
      force: true,
    });
  });

  it('returns empty string when diff stdout is empty', async () => {
    mockReadText.mockResolvedValue('new content');
    mockMkdtemp.mockResolvedValue('/tmp/fireforge-diff-xxx');
    mockWriteFile.mockResolvedValue(undefined);
    mockExec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

    const result = await generateModificationDiff('/repo', 'file.txt', 'old content');
    expect(result).toBe('');
  });
});

describe('getAllDiff', () => {
  it('combines tracked and untracked diffs', async () => {
    mockExec.mockResolvedValue({ stdout: 'tracked diff\n', stderr: '', exitCode: 0 });
    mockGetUntrackedFiles.mockResolvedValue(['new.txt']);
    mockReadText.mockResolvedValue('new content\n');

    const result = await getAllDiff('/repo');
    expect(result).toContain('tracked diff');
    expect(result).toContain('new file mode 100644');
  });

  it('handles no untracked files', async () => {
    mockExec.mockResolvedValue({ stdout: 'tracked diff\n', stderr: '', exitCode: 0 });
    mockGetUntrackedFiles.mockResolvedValue([]);

    const result = await getAllDiff('/repo');
    expect(result).toBe('tracked diff\n');
  });

  it('handles empty tracked diff', async () => {
    mockExec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    mockGetUntrackedFiles.mockResolvedValue([]);

    const result = await getAllDiff('/repo');
    expect(result).toBe('\n');
  });
});

describe('getDiffForFilesAgainstHead', () => {
  it('uses getFileDiff for tracked files', async () => {
    mockFileExistsInHead.mockResolvedValue(true);
    mockExec.mockResolvedValue({ stdout: 'tracked diff\n', stderr: '', exitCode: 0 });

    const result = await getDiffForFilesAgainstHead('/repo', ['file.txt']);
    expect(result).toBe('tracked diff\n');
  });

  it('uses generateNewFileDiff for untracked existing files', async () => {
    mockFileExistsInHead.mockResolvedValue(false);
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('content\n');
    mockExec.mockResolvedValue({ stdout: 'abc1234567\n', stderr: '', exitCode: 0 });

    const result = await getDiffForFilesAgainstHead('/repo', ['new.txt']);
    expect(result).toContain('new file mode 100644');
  });

  it('skips files that do not exist on disk', async () => {
    mockFileExistsInHead.mockResolvedValue(false);
    mockPathExists.mockResolvedValue(false);

    const result = await getDiffForFilesAgainstHead('/repo', ['gone.txt']);
    expect(result).toBe('');
  });

  it('deduplicates files', async () => {
    mockFileExistsInHead.mockResolvedValue(true);
    mockExec.mockResolvedValue({ stdout: 'diff\n', stderr: '', exitCode: 0 });

    await getDiffForFilesAgainstHead('/repo', ['a.txt', 'a.txt']);
    // ensureGit + one getFileDiff call
    expect(mockExec).toHaveBeenCalledTimes(1);
  });
});

describe('getStagedDiffForFiles', () => {
  it('runs git diff --cached HEAD for provided files', async () => {
    mockExec.mockResolvedValue({ stdout: 'staged diff\n', stderr: '', exitCode: 0 });

    const result = await getStagedDiffForFiles('/repo', ['a.txt', 'b.txt']);
    expect(result).toBe('staged diff\n');
    expect(mockExec).toHaveBeenCalledWith(
      'git',
      ['diff', '--cached', 'HEAD', '--', 'a.txt', 'b.txt'],
      { cwd: '/repo' }
    );
  });
});

describe('generateBinaryFilePatch', () => {
  it('returns diff for tracked binary file', async () => {
    mockExec.mockResolvedValue({ stdout: 'binary diff\n', stderr: '', exitCode: 0 });

    const result = await generateBinaryFilePatch('/repo', 'image.png');
    expect(result).toBe('binary diff\n');
    expect(mockExec).toHaveBeenCalledWith('git', ['diff', '--binary', 'HEAD', '--', 'image.png'], {
      cwd: '/repo',
    });
  });

  it('stages untracked file with intent-to-add and cleans up', async () => {
    // First call: tracked diff returns empty
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      // Second call: git add --intent-to-add
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      // Third call: git diff --binary (untracked)
      .mockResolvedValueOnce({ stdout: 'untracked binary diff\n', stderr: '', exitCode: 0 })
      // Fourth call: git reset HEAD
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });

    const result = await generateBinaryFilePatch('/repo', 'new.png');
    expect(result).toBe('untracked binary diff\n');
    expect(mockExec).toHaveBeenCalledWith('git', ['add', '--intent-to-add', '--', 'new.png'], {
      cwd: '/repo',
    });
    expect(mockExec).toHaveBeenCalledWith('git', ['reset', 'HEAD', '--', 'new.png'], {
      cwd: '/repo',
    });
  });

  it('unstages in finally even when diff throws', async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockRejectedValueOnce(new Error('diff failed'))
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });

    await expect(generateBinaryFilePatch('/repo', 'new.png')).rejects.toThrow('diff failed');
    expect(mockExec).toHaveBeenCalledWith('git', ['reset', 'HEAD', '--', 'new.png'], {
      cwd: '/repo',
    });
  });
});
