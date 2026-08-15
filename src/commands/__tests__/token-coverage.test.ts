// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
  getProjectPaths: vi.fn(),
  loadConfig: vi.fn(),
}));

// The 0.16.0 token-coverage command asks the furnace-config module whether
// furnace.json exists (it augments discovery with deployed custom-component
// CSS). The mock covers both paths: `furnaceConfigExists` returns false
// by default so baseline tests skip the augmentation, and targeted cases
// flip it via `mockResolvedValueOnce`.
vi.mock('../../core/furnace-config.js', () => ({
  furnaceConfigExists: vi.fn(),
  loadFurnaceConfig: vi.fn(),
}));

vi.mock('../../core/git.js', () => ({
  getStatusWithCodes: vi.fn(),
  isGitRepository: vi.fn(),
  // token-coverage's engine precondition ladder was truncated before 0.41.0
  // and never reached the unborn-HEAD rung — which is why this mock did not
  // need these. It does now.
  getHead: vi.fn(() => Promise.resolve('abc1234')),
  isMissingHeadError: vi.fn(() => false),
}));

vi.mock('../../core/git-status.js', () => ({
  resolveMaxUntrackedFilesPerDir: vi.fn(() => 5000),
  getWorkingTreeStatus: vi.fn(() => Promise.resolve([])),
  expandUntrackedDirectoryEntries: vi.fn((_dir: string, entries: unknown[]) =>
    Promise.resolve(entries)
  ),
}));

vi.mock('../../core/token-coverage.js', () => ({
  measureTokenCoverage: vi.fn(),
}));

vi.mock('../../core/token-manager.js', () => ({
  getTokensCssPath: vi.fn(),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
  readText: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  info: vi.fn(),
  intro: vi.fn(),
  outro: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
}));

import { getProjectPaths, loadConfig } from '../../core/config.js';
import { furnaceConfigExists, loadFurnaceConfig } from '../../core/furnace-config.js';
import { getStatusWithCodes, isGitRepository } from '../../core/git.js';
import { expandUntrackedDirectoryEntries, getWorkingTreeStatus } from '../../core/git-status.js';
import { measureTokenCoverage } from '../../core/token-coverage.js';
import { getTokensCssPath } from '../../core/token-manager.js';
import { pathExists, readText } from '../../utils/fs.js';
import { info, intro, outro, success, warn } from '../../utils/logger.js';
import { tokenCoverageCommand } from '../token-coverage.js';

const mockedGetProjectPaths = vi.mocked(getProjectPaths);
const mockedGetStatusWithCodes = vi.mocked(getStatusWithCodes);
const mockedGetWorkingTreeStatus = vi.mocked(getWorkingTreeStatus);
const mockedIsGitRepository = vi.mocked(isGitRepository);

/**
 * Shapes a lightweight `{ status, file }` tuple into the richer
 * `GitStatusEntry` the real `getWorkingTreeStatus` returns. Centralised
 * so each test can stay focused on the token-coverage logic rather
 * than the parsing that the tokeniser already covers.
 */
function statusEntry(
  status: string,
  file: string
): {
  status: string;
  indexStatus: string;
  worktreeStatus: string;
  file: string;
  isUntracked: boolean;
  isRenameOrCopy: boolean;
  isDeleted: boolean;
} {
  return {
    status,
    indexStatus: status[0] ?? ' ',
    worktreeStatus: status[1] ?? status[0] ?? ' ',
    file,
    isUntracked: status.includes('?'),
    isRenameOrCopy: false,
    isDeleted: status.includes('D'),
  };
}
const mockedLoadConfig = vi.mocked(loadConfig);
const mockedMeasureTokenCoverage = vi.mocked(measureTokenCoverage);
const mockedGetTokensCssPath = vi.mocked(getTokensCssPath);
const mockedPathExists = vi.mocked(pathExists);
const mockedReadText = vi.mocked(readText);
const mockedFurnaceConfigExists = vi.mocked(furnaceConfigExists);
const mockedLoadFurnaceConfig = vi.mocked(loadFurnaceConfig);

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
    mockedReadText.mockResolvedValue(':root {}\n');
    mockedIsGitRepository.mockResolvedValue(true);
    mockedLoadConfig.mockResolvedValue({ binaryName: 'mybrowser' } as Awaited<
      ReturnType<typeof loadConfig>
    >);
    mockedGetTokensCssPath.mockReturnValue('browser/themes/shared/mybrowser-tokens.css');
    mockedGetStatusWithCodes.mockResolvedValue([]);
    mockedGetWorkingTreeStatus.mockResolvedValue([]);
    // Default: no furnace.json, so the baseline tests that predate the
    // furnace-aware discovery still exercise the old git-status-only path.
    mockedFurnaceConfigExists.mockResolvedValue(false);
  });

  it('fails when the Firefox source tree does not exist', async () => {
    mockedPathExists.mockResolvedValue(false);

    await expect(tokenCoverageCommand('/project')).rejects.toThrow(/Firefox source not found/i);
    expect(intro).toHaveBeenCalledWith('Token Coverage');
    expect(mockedMeasureTokenCoverage).not.toHaveBeenCalled();
  });

  it('includes CSS files inside untracked directories', async () => {
    // Eval 1 Finding #13: an imported patch stack added new CSS under
    // `browser/themes/shared/` and the engine worktree reported
    // `?? browser/themes/shared/` (collapsed). The old command scanned
    // status codes directly and reported "No modified CSS files"
    // because the directory path did not end in `.css`. Expanding
    // untracked directories picks up the files inside.
    vi.mocked(expandUntrackedDirectoryEntries).mockResolvedValueOnce([
      statusEntry('??', 'browser/themes/shared/mybrowser-extras.css'),
      statusEntry('??', 'browser/themes/shared/mybrowser-spacing.css'),
    ]);
    mockedMeasureTokenCoverage.mockResolvedValue({
      filesScanned: 2,
      tokenUsages: 4,
      allowlistedUsages: 0,
      unknownVarUsages: 0,
      rawColorCount: 0,
      files: [
        {
          file: 'browser/themes/shared/mybrowser-extras.css',
          tokenUsages: 3,
          allowlisted: 0,
          unknownVars: 0,
          rawColors: 0,
        },
        {
          file: 'browser/themes/shared/mybrowser-spacing.css',
          tokenUsages: 1,
          allowlisted: 0,
          unknownVars: 0,
          rawColors: 0,
        },
      ],
    });

    await tokenCoverageCommand('/project');

    expect(mockedMeasureTokenCoverage).toHaveBeenCalledWith(
      '/project/engine',
      expect.arrayContaining([
        'browser/themes/shared/mybrowser-extras.css',
        'browser/themes/shared/mybrowser-spacing.css',
      ])
    );
  });

  it('returns early when there are no modified CSS files to measure', async () => {
    mockedGetWorkingTreeStatus.mockResolvedValue([
      statusEntry(' M', 'browser/components/app/app.js'),
    ]);

    await tokenCoverageCommand('/project');

    expect(info).toHaveBeenCalledWith('No modified CSS files');
    expect(outro).toHaveBeenCalledWith('Nothing to measure');
    expect(mockedMeasureTokenCoverage).not.toHaveBeenCalled();
  });

  it('validates modified Furnace token CSS without counting raw token values as usage coverage', async () => {
    mockedGetWorkingTreeStatus.mockResolvedValue([
      statusEntry(' M', 'browser/themes/shared/mybrowser-tokens.css'),
    ]);
    mockedFurnaceConfigExists.mockResolvedValue(true);
    mockedLoadFurnaceConfig.mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      tokenPrefix: '--mybrowser-',
      stock: [],
      overrides: {},
      custom: {},
    });
    mockedReadText.mockResolvedValue(`
:root {
  --mybrowser-accent: #ff00aa;
}
`);

    await tokenCoverageCommand('/project');

    expect(mockedMeasureTokenCoverage).not.toHaveBeenCalled();
    expect(success).toHaveBeenCalledWith(
      'browser/themes/shared/mybrowser-tokens.css  token source valid (1 token declaration)'
    );
    expect(outro).toHaveBeenCalledWith('1 token source file validated');
  });

  it('reports per-file stats and warns when coverage is incomplete', async () => {
    mockedGetWorkingTreeStatus.mockResolvedValue([
      statusEntry(' M', 'browser/themes/shared/panel.css'),
      statusEntry(' M', 'browser/themes/shared/mybrowser-tokens.css'),
      statusEntry(' M', 'browser/components/app/app.js'),
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
    expect(success).toHaveBeenCalledWith(
      'browser/themes/shared/mybrowser-tokens.css  token source valid (0 token declarations)'
    );
    expect(outro).toHaveBeenCalledWith('1 CSS file scanned');
  });

  it('augments scan with Furnace custom-component CSS files that exist on disk', async () => {
    // Finding #10: the eval had a deployed `moz-eval-card.css` that was
    // untracked in git but present in the engine, and coverage missed it
    // entirely because the old discovery path only read git status.
    mockedGetWorkingTreeStatus.mockResolvedValue([
      statusEntry(' M', 'browser/themes/shared/panel.css'),
    ]);
    mockedFurnaceConfigExists.mockResolvedValue(true);
    mockedLoadFurnaceConfig.mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {
        'moz-eval-card': {
          description: '',
          targetPath: 'toolkit/content/widgets/moz-eval-card',
          register: true,
          localized: false,
        },
      },
    });
    // `pathExists` is invoked both for the engine check and for each
    // candidate CSS file. Keep it unconditionally truthy so both the
    // engine and the deployed CSS are considered present.
    mockedPathExists.mockResolvedValue(true);
    mockedMeasureTokenCoverage.mockResolvedValue({
      filesScanned: 2,
      tokenUsages: 2,
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
          file: 'toolkit/content/widgets/moz-eval-card/moz-eval-card.css',
          tokenUsages: 1,
          allowlisted: 0,
          unknownVars: 0,
          rawColors: 0,
        },
      ],
    });

    await tokenCoverageCommand('/project');

    expect(mockedMeasureTokenCoverage).toHaveBeenCalledWith('/project/engine', [
      'browser/themes/shared/panel.css',
      'toolkit/content/widgets/moz-eval-card/moz-eval-card.css',
    ]);
    expect(outro).toHaveBeenCalledWith('2 CSS files scanned');
  });

  it('reports success when all measured usages are token-backed', async () => {
    mockedGetWorkingTreeStatus.mockResolvedValue([
      statusEntry(' M', 'browser/themes/shared/panel.css'),
      statusEntry(' M', 'browser/themes/shared/dialog.css'),
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
