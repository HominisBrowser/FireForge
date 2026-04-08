// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
  getProjectPaths: vi.fn(),
  loadConfig: vi.fn(),
}));

vi.mock('../../core/git.js', () => ({
  getStatusWithCodes: vi.fn(),
  isGitRepository: vi.fn(),
}));

vi.mock('../../core/token-coverage.js', () => ({
  measureTokenCoverage: vi.fn(),
}));

vi.mock('../../core/token-manager.js', () => ({
  getTokensCssPath: vi.fn(),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  info: vi.fn(),
  intro: vi.fn(),
  outro: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
}));

import { getProjectPaths, loadConfig } from '../../core/config.js';
import { getStatusWithCodes, isGitRepository } from '../../core/git.js';
import { measureTokenCoverage } from '../../core/token-coverage.js';
import { getTokensCssPath } from '../../core/token-manager.js';
import { pathExists } from '../../utils/fs.js';
import { info, intro, outro, success, warn } from '../../utils/logger.js';
import { tokenCoverageCommand } from '../token-coverage.js';

const mockedGetProjectPaths = vi.mocked(getProjectPaths);
const mockedGetStatusWithCodes = vi.mocked(getStatusWithCodes);
const mockedIsGitRepository = vi.mocked(isGitRepository);
const mockedLoadConfig = vi.mocked(loadConfig);
const mockedMeasureTokenCoverage = vi.mocked(measureTokenCoverage);
const mockedGetTokensCssPath = vi.mocked(getTokensCssPath);
const mockedPathExists = vi.mocked(pathExists);

describe('tokenCoverageCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockedGetProjectPaths.mockReturnValue({
      root: '/project',
      config: '/project/fireforge.json',
      fireforgeDir: '/project/.fireforge',
      state: '/project/.fireforge/state.json',
      engine: '/project/engine',
      patches: '/project/patches',
      configs: '/project/configs',
      src: '/project/src',
      componentsDir: '/project/components',
    });
    mockedPathExists.mockResolvedValue(true);
    mockedIsGitRepository.mockResolvedValue(true);
    mockedLoadConfig.mockResolvedValue({ binaryName: 'mybrowser' } as Awaited<
      ReturnType<typeof loadConfig>
    >);
    mockedGetTokensCssPath.mockReturnValue('browser/themes/shared/mybrowser-tokens.css');
    mockedGetStatusWithCodes.mockResolvedValue([]);
  });

  it('fails when the Firefox source tree does not exist', async () => {
    mockedPathExists.mockResolvedValue(false);

    await expect(tokenCoverageCommand('/project')).rejects.toThrow(/Firefox source not found/i);
    expect(intro).toHaveBeenCalledWith('Token Coverage');
    expect(mockedMeasureTokenCoverage).not.toHaveBeenCalled();
  });

  it('returns early when there are no modified CSS files to measure', async () => {
    mockedGetStatusWithCodes.mockResolvedValue([
      { status: 'M', file: 'browser/components/app/app.js' },
      { status: 'M', file: 'browser/themes/shared/mybrowser-tokens.css' },
    ]);

    await tokenCoverageCommand('/project');

    expect(info).toHaveBeenCalledWith('No modified CSS files');
    expect(outro).toHaveBeenCalledWith('Nothing to measure');
    expect(mockedMeasureTokenCoverage).not.toHaveBeenCalled();
  });

  it('reports per-file stats and warns when coverage is incomplete', async () => {
    mockedGetStatusWithCodes.mockResolvedValue([
      { status: 'M', file: 'browser/themes/shared/panel.css' },
      { status: 'M', file: 'browser/themes/shared/mybrowser-tokens.css' },
      { status: 'M', file: 'browser/components/app/app.js' },
    ]);
    mockedMeasureTokenCoverage.mockResolvedValue({
      filesScanned: 1,
      tokenUsages: 2,
      allowlistedUsages: 1,
      unknownVarUsages: 1,
      rawColorCount: 1,
      files: [
        {
          file: 'browser/themes/shared/panel.css',
          tokenUsages: 2,
          allowlisted: 1,
          unknownVars: 1,
          rawColors: 1,
        },
      ],
    });

    await tokenCoverageCommand('/project');

    expect(mockedMeasureTokenCoverage).toHaveBeenCalledWith('/project/engine', [
      'browser/themes/shared/panel.css',
    ]);
    expect(info).toHaveBeenCalledWith(
      'browser/themes/shared/panel.css  tokens: 2 | allowlisted: 1 | unknown: 1 | raw colors: 1'
    );
    expect(info).toHaveBeenCalledWith('');
    expect(warn).toHaveBeenCalledWith(
      'Token coverage: 50% (2 tokens / 4 total) — 1 raw colors, 1 unknown vars'
    );
    expect(outro).toHaveBeenCalledWith('1 CSS file scanned');
    expect(success).not.toHaveBeenCalled();
  });

  it('reports success when all measured usages are token-backed', async () => {
    mockedGetStatusWithCodes.mockResolvedValue([
      { status: 'M', file: 'browser/themes/shared/panel.css' },
      { status: 'M', file: 'browser/themes/shared/dialog.css' },
    ]);
    mockedMeasureTokenCoverage.mockResolvedValue({
      filesScanned: 2,
      tokenUsages: 3,
      allowlistedUsages: 0,
      unknownVarUsages: 0,
      rawColorCount: 0,
      files: [
        {
          file: 'browser/themes/shared/panel.css',
          tokenUsages: 1,
          allowlisted: 0,
          unknownVars: 0,
          rawColors: 0,
        },
        {
          file: 'browser/themes/shared/dialog.css',
          tokenUsages: 2,
          allowlisted: 0,
          unknownVars: 0,
          rawColors: 0,
        },
      ],
    });

    await tokenCoverageCommand('/project');

    expect(success).toHaveBeenCalledWith(
      'Token coverage: 100% (3 tokens / 3 total) — 0 raw colors, 0 unknown vars'
    );
    expect(outro).toHaveBeenCalledWith('2 CSS files scanned');
    expect(warn).not.toHaveBeenCalled();
  });
});
