// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFsMock } from '../../test-utils/module-mocks.js';

vi.mock('../../utils/fs.js', () => createFsMock());

vi.mock('../furnace-config.js', () => ({
  loadFurnaceConfig: vi.fn(),
}));

import { pathExists, readText } from '../../utils/fs.js';
import { loadFurnaceConfig } from '../furnace-config.js';
import { measureTokenCoverage } from '../token-coverage.js';

const mockedPathExists = vi.mocked(pathExists);
const mockedReadText = vi.mocked(readText);
const mockedLoadFurnaceConfig = vi.mocked(loadFurnaceConfig);

describe('measureTokenCoverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('counts prefixed tokens, allowlisted vars, unknown vars, and raw colors per file', async () => {
    mockedLoadFurnaceConfig.mockResolvedValue({
      tokenPrefix: '--mybrowser-',
      tokenAllowlist: ['--in-content-page-color'],
    } as Awaited<ReturnType<typeof loadFurnaceConfig>>);

    mockedPathExists.mockImplementation((filePath) =>
      Promise.resolve(!filePath.includes('missing.css'))
    );

    mockedReadText.mockImplementation((filePath) => {
      if (filePath.endsWith('styles/a.css')) {
        return Promise.resolve(
          [
            '/* var(--mybrowser-commented) #123456 rgb(1, 2, 3) */',
            '.button {',
            '  color: var(--mybrowser-accent);',
            '  background: var(--in-content-page-color);',
            '  border-color: var(--unknown-color);',
            '  outline-color: #fff;',
            '  box-shadow: 0 0 1px rgba(0, 0, 0, 0.2);',
            '}',
          ].join('\n')
        );
      }

      if (filePath.endsWith('styles/b.css')) {
        return Promise.resolve(
          [
            '.panel {',
            '  background: var(--mybrowser-surface);',
            '  color: hsl(0 0% 0%);',
            '}',
          ].join('\n')
        );
      }

      throw new Error(`Unexpected file read: ${filePath}`);
    });

    const report = await measureTokenCoverage(
      '/repo/engine',
      ['styles/a.css', 'styles/missing.css', 'styles/b.css'],
      '/repo'
    );

    expect(mockedLoadFurnaceConfig).toHaveBeenCalledWith('/repo');
    expect(report).toEqual({
      filesScanned: 2,
      tokenUsages: 2,
      allowlistedUsages: 1,
      unknownVarUsages: 1,
      rawColorCount: 3,
      files: [
        {
          file: 'styles/a.css',
          tokenUsages: 1,
          allowlisted: 1,
          unknownVars: 1,
          rawColors: 2,
        },
        {
          file: 'styles/b.css',
          tokenUsages: 1,
          allowlisted: 0,
          unknownVars: 0,
          rawColors: 1,
        },
      ],
    });
  });

  it('counts --moz-* platform vars as allowlisted by default, not unknown', async () => {
    // A fork that overrides moz-button (CSS-only) may declare one fork-owned
    // token while the copied upstream baseline references ~84 `--moz-*`
    // platform vars; counting those as unknown reports 1% coverage. The
    // default allowlist maps them to the platform bucket so fork-owned
    // coverage is not dragged down by untouched upstream material.
    mockedLoadFurnaceConfig.mockResolvedValue({
      tokenPrefix: '--freshforge-',
      tokenAllowlist: [],
    } as unknown as Awaited<ReturnType<typeof loadFurnaceConfig>>);
    mockedPathExists.mockResolvedValue(true);
    mockedReadText.mockResolvedValue(
      [
        '.button {',
        '  border-radius: var(--freshforge-button-radius);',
        '  padding: var(--moz-button-padding);',
        '  color: var(--moz-color-primary);',
        '}',
      ].join('\n')
    );

    const report = await measureTokenCoverage('/repo/engine', ['moz-button.css'], '/repo');

    expect(report.tokenUsages).toBe(1);
    expect(report.allowlistedUsages).toBe(2);
    expect(report.unknownVarUsages).toBe(0);
  });

  it('respects an explicit furnace.json platformPrefixes override', async () => {
    // Forks that host multiple platform-style prefixes (e.g. their own
    // `--in-content-*` fork) can extend the default list. An explicit
    // empty list re-classifies `--moz-*` as unknown (the pre-0.17.x
    // contract) for forks that want the stricter count.
    mockedLoadFurnaceConfig.mockResolvedValue({
      tokenPrefix: '--freshforge-',
      tokenAllowlist: [],
      platformPrefixes: [],
    } as unknown as Awaited<ReturnType<typeof loadFurnaceConfig>>);
    mockedPathExists.mockResolvedValue(true);
    mockedReadText.mockResolvedValue('.button { color: var(--moz-color-primary); }');

    const report = await measureTokenCoverage('/repo/engine', ['moz-button.css'], '/repo');

    expect(report.allowlistedUsages).toBe(0);
    expect(report.unknownVarUsages).toBe(1);
  });

  it('treats all custom properties as unknown when furnace config cannot be loaded', async () => {
    mockedLoadFurnaceConfig.mockRejectedValue(new Error('missing furnace config'));
    mockedPathExists.mockResolvedValue(true);
    mockedReadText.mockResolvedValue(
      [
        '.root {',
        '  color: var(--mybrowser-accent);',
        '  background: var(--other-var);',
        '  border-color: #000;',
        '}',
      ].join('\n')
    );

    const report = await measureTokenCoverage('/repo/engine', ['styles/a.css']);

    expect(mockedLoadFurnaceConfig).toHaveBeenCalledWith('/repo');
    expect(report).toEqual({
      filesScanned: 1,
      tokenUsages: 0,
      allowlistedUsages: 0,
      unknownVarUsages: 2,
      rawColorCount: 1,
      files: [
        {
          file: 'styles/a.css',
          tokenUsages: 0,
          allowlisted: 0,
          unknownVars: 2,
          rawColors: 1,
        },
      ],
    });
  });
});
