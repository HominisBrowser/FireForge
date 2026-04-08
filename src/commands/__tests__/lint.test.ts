// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
  stat: vi.fn(),
}));

vi.mock('../../core/config.js', () => ({
  getProjectPaths: vi.fn(() => ({
    root: '/project',
    engine: '/project/engine',
    config: '/project/fireforge.json',
    fireforgeDir: '/project/.fireforge',
    state: '/project/.fireforge/state.json',
    patches: '/project/patches',
    configs: '/project/configs',
    src: '/project/src',
    componentsDir: '/project/components',
  })),
  loadConfig: vi.fn(() => Promise.resolve({})),
}));

vi.mock('../../core/git.js', () => ({
  isGitRepository: vi.fn(() => Promise.resolve(true)),
  hasChanges: vi.fn(() => Promise.resolve(true)),
  getStatusWithCodes: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../../core/git-diff.js', () => ({
  getAllDiff: vi.fn(() => Promise.resolve('diff content')),
  getDiffForFilesAgainstHead: vi.fn(() => Promise.resolve('diff content')),
}));

vi.mock('../../core/git-status.js', () => ({
  getModifiedFilesInDir: vi.fn(() => Promise.resolve([])),
  getUntrackedFiles: vi.fn(() => Promise.resolve([])),
  getUntrackedFilesInDir: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../../core/patch-apply.js', () => ({
  extractAffectedFiles: vi.fn(() => []),
}));

vi.mock('../../core/patch-lint.js', () => ({
  lintExportedPatch: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  success: vi.fn(),
}));

import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';

import { getStatusWithCodes, hasChanges } from '../../core/git.js';
import { getAllDiff, getDiffForFilesAgainstHead } from '../../core/git-diff.js';
import {
  getModifiedFilesInDir,
  getUntrackedFiles,
  getUntrackedFilesInDir,
} from '../../core/git-status.js';
import { lintExportedPatch } from '../../core/patch-lint.js';
import { GeneralError } from '../../errors/base.js';
import { pathExists } from '../../utils/fs.js';
import { info, outro, success, warn } from '../../utils/logger.js';
import { lintCommand } from '../lint.js';

function fakeStats(overrides: Partial<Stats>): Stats {
  return { isDirectory: () => false, isFile: () => true, ...overrides } as Stats;
}

describe('lintCommand — branch coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(hasChanges).mockResolvedValue(true);
    vi.mocked(getAllDiff).mockResolvedValue('diff content');
    vi.mocked(getDiffForFilesAgainstHead).mockResolvedValue('diff content');
    vi.mocked(lintExportedPatch).mockResolvedValue([]);
    vi.mocked(getStatusWithCodes).mockResolvedValue([]);
    vi.mocked(getUntrackedFiles).mockResolvedValue([]);
  });

  it('collects files from a directory input', async () => {
    vi.mocked(stat).mockResolvedValue(fakeStats({ isDirectory: () => true }));
    vi.mocked(getModifiedFilesInDir).mockResolvedValue(['src/app.ts']);
    vi.mocked(getUntrackedFilesInDir).mockResolvedValue(['src/new.ts']);

    await lintCommand('/project', ['src']);

    expect(getModifiedFilesInDir).toHaveBeenCalledWith('/project/engine', 'src');
    expect(getUntrackedFilesInDir).toHaveBeenCalledWith('/project/engine', 'src');
    expect(getDiffForFilesAgainstHead).toHaveBeenCalledWith('/project/engine', [
      'src/app.ts',
      'src/new.ts',
    ]);
  });

  it('strips trailing slash from directory path', async () => {
    vi.mocked(stat).mockResolvedValue(fakeStats({ isDirectory: () => true }));
    vi.mocked(getModifiedFilesInDir).mockResolvedValue(['src/app.ts']);

    await lintCommand('/project', ['src/']);

    expect(getModifiedFilesInDir).toHaveBeenCalledWith('/project/engine', 'src');
  });

  it('falls back to file lookup when stat throws', async () => {
    vi.mocked(stat).mockRejectedValue(new Error('ENOENT'));
    vi.mocked(getStatusWithCodes).mockResolvedValue([{ status: 'M', file: 'missing.ts' }]);

    await lintCommand('/project', ['missing.ts']);

    expect(getStatusWithCodes).toHaveBeenCalled();
    expect(getDiffForFilesAgainstHead).toHaveBeenCalledWith('/project/engine', ['missing.ts']);
  });

  it('loads file statuses only once for multiple file inputs', async () => {
    vi.mocked(stat).mockRejectedValue(new Error('ENOENT'));
    vi.mocked(getStatusWithCodes).mockResolvedValue([
      { status: 'M', file: 'a.ts' },
      { status: 'M', file: 'b.ts' },
    ]);
    vi.mocked(getUntrackedFiles).mockResolvedValue([]);

    await lintCommand('/project', ['a.ts', 'b.ts']);

    // Should call getStatusWithCodes only once despite two file inputs
    expect(getStatusWithCodes).toHaveBeenCalledTimes(1);
    expect(getUntrackedFiles).toHaveBeenCalledTimes(1);
  });

  it('reports nothing to lint when no specified files have status', async () => {
    vi.mocked(stat).mockRejectedValue(new Error('ENOENT'));
    vi.mocked(getStatusWithCodes).mockResolvedValue([]);

    await lintCommand('/project', ['clean.ts']);

    expect(vi.mocked(info)).toHaveBeenCalledWith('No modified files found in the specified paths.');
  });

  it('reports nothing to lint when diff is empty', async () => {
    vi.mocked(getAllDiff).mockResolvedValue('   \n  ');

    await lintCommand('/project', []);

    expect(vi.mocked(info)).toHaveBeenCalledWith('No diff content to lint.');
  });

  it('reports nothing to lint when there are no changes', async () => {
    vi.mocked(hasChanges).mockResolvedValue(false);

    await lintCommand('/project', []);

    expect(vi.mocked(info)).toHaveBeenCalledWith('No changes to lint.');
  });

  it('passes lint with no issues', async () => {
    vi.mocked(lintExportedPatch).mockResolvedValue([]);

    await lintCommand('/project', []);

    expect(vi.mocked(success)).toHaveBeenCalledWith('No lint issues found.');
  });

  it('throws GeneralError when there are lint errors', async () => {
    vi.mocked(lintExportedPatch).mockResolvedValue([
      { severity: 'error', check: 'license', file: 'a.ts', message: 'Missing license' },
    ]);

    await expect(lintCommand('/project', [])).rejects.toBeInstanceOf(GeneralError);
  });

  it('passes with warnings only', async () => {
    vi.mocked(lintExportedPatch).mockResolvedValue([
      { severity: 'warning', check: 'jsdoc', file: 'a.ts', message: 'Missing JSDoc' },
    ]);

    await lintCommand('/project', []);

    expect(vi.mocked(warn)).toHaveBeenCalledWith(expect.stringContaining('Missing JSDoc'));
    expect(vi.mocked(outro)).toHaveBeenCalledWith('Lint passed with warnings');
  });

  it('reports both errors and warnings, then throws', async () => {
    vi.mocked(lintExportedPatch).mockResolvedValue([
      { severity: 'warning', check: 'jsdoc', file: 'a.ts', message: 'Missing JSDoc' },
      { severity: 'error', check: 'license', file: 'b.ts', message: 'Missing license' },
    ]);

    await expect(lintCommand('/project', [])).rejects.toBeInstanceOf(GeneralError);
    // Both warn calls should have been made before the throw
    expect(vi.mocked(warn)).toHaveBeenCalledWith(expect.stringContaining('Missing JSDoc'));
    expect(vi.mocked(warn)).toHaveBeenCalledWith(expect.stringContaining('Missing license'));
  });

  it('throws when engine path does not exist', async () => {
    vi.mocked(pathExists).mockResolvedValue(false);

    await expect(lintCommand('/project', [])).rejects.toThrow('Firefox source not found');
  });
});
