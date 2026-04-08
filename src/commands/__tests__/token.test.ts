// SPDX-License-Identifier: EUPL-1.2
import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InvalidArgumentError } from '../../errors/base.js';

vi.mock('../../core/config.js', () => ({
  loadConfig: vi.fn(() =>
    Promise.resolve({
      binaryName: 'mybrowser',
    })
  ),
}));

vi.mock('../../core/furnace-config.js', () => ({
  loadFurnaceConfig: vi.fn(() =>
    Promise.resolve({
      tokenPrefix: '--mybrowser-',
    })
  ),
}));

vi.mock('../../core/token-manager.js', () => ({
  addToken: vi.fn(() =>
    Promise.resolve({
      cssAdded: true,
      docsAdded: true,
      unmappedAdded: false,
      countUpdated: true,
      skipped: false,
    })
  ),
  validateTokenAdd: vi.fn(() => Promise.resolve()),
  getTokensCssPath: vi.fn(() => 'browser/themes/shared/mybrowser-tokens.css'),
}));

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  verbose: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../token-coverage.js', () => ({
  tokenCoverageCommand: vi.fn(() => Promise.resolve()),
}));

import { loadConfig } from '../../core/config.js';
import { loadFurnaceConfig } from '../../core/furnace-config.js';
import { addToken, validateTokenAdd } from '../../core/token-manager.js';
import { info, outro, success, warn } from '../../utils/logger.js';
import { registerToken, tokenAddCommand } from '../token.js';
import { tokenCoverageCommand } from '../token-coverage.js';

const mockedAddToken = vi.mocked(addToken);
const mockedValidateTokenAdd = vi.mocked(validateTokenAdd);
const mockedLoadConfig = vi.mocked(loadConfig);
const mockedLoadFurnaceConfig = vi.mocked(loadFurnaceConfig);
const mockedTokenCoverageCommand = vi.mocked(tokenCoverageCommand);

function createProgram(): Command {
  const program = new Command();

  registerToken(program, {
    getProjectRoot: () => '/project',
    withErrorHandling: <T extends unknown[]>(handler: (...args: T) => Promise<void>) => handler,
  });

  return program;
}

describe('tokenAddCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedLoadConfig.mockResolvedValue({ binaryName: 'mybrowser' } as Awaited<
      ReturnType<typeof loadConfig>
    >);
    mockedLoadFurnaceConfig.mockResolvedValue({ tokenPrefix: '--mybrowser-' } as Awaited<
      ReturnType<typeof loadFurnaceConfig>
    >);
    mockedAddToken.mockResolvedValue({
      cssAdded: true,
      docsAdded: true,
      unmappedAdded: false,
      countUpdated: true,
      skipped: false,
    });
    mockedValidateTokenAdd.mockResolvedValue();
  });

  it('validates dry-run token additions before printing a preview', async () => {
    await tokenAddCommand('/project', '--mybrowser-audit-gap', '12px', {
      category: 'Spacing',
      mode: 'override',
      darkValue: '16px',
      dryRun: true,
    });

    expect(mockedValidateTokenAdd).toHaveBeenCalledWith('/project', {
      tokenName: '--mybrowser-audit-gap',
      value: '12px',
      category: 'Spacing',
      mode: 'override',
      darkValue: '16px',
      dryRun: true,
    });
    expect(mockedAddToken).not.toHaveBeenCalled();
  });

  it('surfaces dry-run validation errors instead of pretending the add would succeed', async () => {
    mockedValidateTokenAdd.mockRejectedValue(
      new InvalidArgumentError('Override mode requires --dark-value to be specified.', 'darkValue')
    );

    await expect(
      tokenAddCommand('/project', '--mybrowser-audit-gap', '12px', {
        category: 'Spacing',
        mode: 'override',
        dryRun: true,
      })
    ).rejects.toThrow(/dark-value/i);
    expect(mockedAddToken).not.toHaveBeenCalled();
  });

  it('prefixes bare token names from the configured Furnace token prefix', async () => {
    await tokenAddCommand('/project', 'canvas-gap', '12px', {
      category: 'Spacing',
      mode: 'static',
      dryRun: true,
    });

    expect(mockedValidateTokenAdd).toHaveBeenCalledWith('/project', {
      tokenName: '--mybrowser-canvas-gap',
      value: '12px',
      category: 'Spacing',
      mode: 'static',
      dryRun: true,
    });
  });

  it('falls back to generic normalization when Furnace config is unavailable', async () => {
    mockedLoadFurnaceConfig.mockRejectedValue(new Error('missing furnace config'));

    await tokenAddCommand('/project', 'canvas-gap', '12px', {
      category: 'Spacing',
      mode: 'static',
      dryRun: true,
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('furnace.json could not be loaded'));
    expect(mockedValidateTokenAdd).toHaveBeenCalledWith('/project', {
      tokenName: '--canvas-gap',
      value: '12px',
      category: 'Spacing',
      mode: 'static',
      dryRun: true,
    });
  });

  it('falls back to generic normalization when Furnace config has no token prefix', async () => {
    mockedLoadFurnaceConfig.mockResolvedValue({} as Awaited<ReturnType<typeof loadFurnaceConfig>>);

    await tokenAddCommand('/project', 'canvas-gap', '12px', {
      category: 'Spacing',
      mode: 'static',
      dryRun: true,
    });

    expect(mockedValidateTokenAdd).toHaveBeenCalledWith('/project', {
      tokenName: '--canvas-gap',
      value: '12px',
      category: 'Spacing',
      mode: 'static',
      dryRun: true,
    });
  });

  it('rejects unsupported token modes before mutating files', async () => {
    await expect(
      tokenAddCommand('/project', '--mybrowser-audit-gap', '12px', {
        category: 'Spacing',
        mode: 'dynamic',
      })
    ).rejects.toThrow(/invalid mode/i);

    expect(mockedValidateTokenAdd).not.toHaveBeenCalled();
    expect(mockedAddToken).not.toHaveBeenCalled();
  });

  it('reports successful non-dry-run token additions', async () => {
    mockedAddToken.mockResolvedValue({
      cssAdded: true,
      docsAdded: true,
      unmappedAdded: true,
      countUpdated: true,
      skipped: false,
    });

    await tokenAddCommand('/project', 'canvas-gap', '12px', {
      category: 'Spacing',
      mode: 'static',
    });

    expect(mockedAddToken).toHaveBeenCalledWith('/project', {
      tokenName: '--mybrowser-canvas-gap',
      value: '12px',
      category: 'Spacing',
      mode: 'static',
    });
    expect(success).toHaveBeenCalledWith('Added --mybrowser-canvas-gap to mybrowser-tokens.css');
    expect(success).toHaveBeenCalledWith('Added --mybrowser-canvas-gap to SRC_TOKENS.md');
    expect(info).toHaveBeenCalledWith('Added to unmapped tokens table (literal value)');
    expect(info).toHaveBeenCalledWith('Updated mode count in documentation');
    expect(outro).toHaveBeenCalledWith('Done');
  });

  it('prints optional dry-run details when a description is provided', async () => {
    await tokenAddCommand('/project', '--mybrowser-audit-gap', '12px', {
      category: 'Spacing',
      mode: 'static',
      description: 'Primary canvas spacing token',
      dryRun: true,
    });

    expect(mockedValidateTokenAdd).toHaveBeenCalledWith('/project', {
      tokenName: '--mybrowser-audit-gap',
      value: '12px',
      category: 'Spacing',
      mode: 'static',
      description: 'Primary canvas spacing token',
      dryRun: true,
    });
    expect(info).toHaveBeenCalledWith('  Description: Primary canvas spacing token');
  });

  it('reports skipped non-dry-run token additions without loading fireforge config', async () => {
    mockedAddToken.mockResolvedValue({
      cssAdded: false,
      docsAdded: false,
      unmappedAdded: false,
      countUpdated: false,
      skipped: true,
    });

    await tokenAddCommand('/project', '--mybrowser-audit-gap', '12px', {
      category: 'Spacing',
      mode: 'static',
    });

    expect(info).toHaveBeenCalledWith('Token --mybrowser-audit-gap already exists (skipped)');
    expect(mockedLoadConfig).not.toHaveBeenCalled();
  });
});

describe('registerToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedLoadConfig.mockResolvedValue({ binaryName: 'mybrowser' } as Awaited<
      ReturnType<typeof loadConfig>
    >);
    mockedLoadFurnaceConfig.mockResolvedValue({ tokenPrefix: '--mybrowser-' } as Awaited<
      ReturnType<typeof loadFurnaceConfig>
    >);
    mockedValidateTokenAdd.mockResolvedValue();
    mockedAddToken.mockResolvedValue({
      cssAdded: true,
      docsAdded: true,
      unmappedAdded: false,
      countUpdated: true,
      skipped: false,
    });
    mockedTokenCoverageCommand.mockResolvedValue();
  });

  it('routes token add through the registered CLI action', async () => {
    const program = createProgram();

    await program.parseAsync([
      'node',
      'fireforge',
      'token',
      'add',
      'canvas-gap',
      '12px',
      '--category',
      'Spacing',
      '--mode',
      'override',
      '--description',
      'Primary canvas spacing token',
      '--dark-value',
      '16px',
      '--dry-run',
    ]);

    expect(mockedValidateTokenAdd).toHaveBeenCalledWith('/project', {
      tokenName: '--mybrowser-canvas-gap',
      value: '12px',
      category: 'Spacing',
      mode: 'override',
      description: 'Primary canvas spacing token',
      darkValue: '16px',
      dryRun: true,
    });
  });

  it('routes token coverage through the registered CLI action', async () => {
    const program = createProgram();

    await program.parseAsync(['node', 'fireforge', 'token', 'coverage']);

    expect(mockedTokenCoverageCommand).toHaveBeenCalledWith('/project');
  });
});
