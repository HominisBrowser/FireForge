// SPDX-License-Identifier: EUPL-1.2
import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InvalidArgumentError } from '../../errors/base.js';
import { createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('../../core/config.js', () => ({
  loadConfig: vi.fn(() =>
    Promise.resolve({
      binaryName: 'mybrowser',
    })
  ),
}));

vi.mock('../../core/furnace-config.js', () => ({
  // The shared rollback handler records the pending-repair marker
  // through furnace state.
  updateFurnaceState: vi.fn(() => Promise.resolve()),

  loadFurnaceConfig: vi.fn(() =>
    Promise.resolve({
      tokenPrefix: '--mybrowser-',
    })
  ),
  // tokenAddCommand gates on furnace.json existence before delegating to
  // token-manager. Default to "initialized" so the other tests keep
  // exercising the add path.
  furnaceConfigExists: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../../core/token-manager.js', async (importOriginal) => ({
  // TOKEN_MODES and its `isTokenMode` guard are pure data and a pure
  // predicate; the command's validation is what these tests exercise.
  ...(await importOriginal<typeof import('../../core/token-manager.js')>()),
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

vi.mock('../../utils/logger.js', () => createLoggerMock());

vi.mock('../token-coverage.js', () => ({
  tokenCoverageCommand: vi.fn(() => Promise.resolve()),
}));

import { loadConfig } from '../../core/config.js';
import { furnaceConfigExists, loadFurnaceConfig } from '../../core/furnace-config.js';
import { addToken, validateTokenAdd } from '../../core/token-manager.js';
import { info, outro, success, warn } from '../../utils/logger.js';
import { registerToken, tokenAddCommand } from '../token.js';
import { tokenCoverageCommand } from '../token-coverage.js';

const mockedAddToken = vi.mocked(addToken);
const mockedValidateTokenAdd = vi.mocked(validateTokenAdd);
const mockedLoadConfig = vi.mocked(loadConfig);
const mockedLoadFurnaceConfig = vi.mocked(loadFurnaceConfig);
const mockedFurnaceConfigExists = vi.mocked(furnaceConfigExists);
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
    mockedFurnaceConfigExists.mockResolvedValue(true);
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

  it('treats a bare name already starting with the prefix text as fully qualified', async () => {
    // "token add mybrowser-shadow-low" with tokenPrefix
    // "--mybrowser-" used to produce "--mybrowser-mybrowser-shadow-low".
    await tokenAddCommand('/project', 'mybrowser-shadow-low', '0 1px 2px #000', {
      category: 'Shadows',
      mode: 'static',
      dryRun: true,
    });

    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('already starts with the configured prefix')
    );
    expect(mockedValidateTokenAdd).toHaveBeenCalledWith('/project', {
      tokenName: '--mybrowser-shadow-low',
      value: '0 1px 2px #000',
      category: 'Shadows',
      mode: 'static',
      dryRun: true,
    });
  });

  it('treats a bare name equal to the prefix text as fully qualified', async () => {
    await tokenAddCommand('/project', 'mybrowser', '#fff', {
      category: 'Colors',
      mode: 'static',
      dryRun: true,
    });

    expect(mockedValidateTokenAdd).toHaveBeenCalledWith(
      '/project',
      expect.objectContaining({ tokenName: '--mybrowser' })
    );
  });

  it('does not misfire the prefix guard on names merely sharing a prefix substring', async () => {
    // "mybrowserish-gap" starts with the prefix *text* but not the
    // prefix-dash boundary, so it must still be prefixed normally.
    await tokenAddCommand('/project', 'mybrowserish-gap', '4px', {
      category: 'Spacing',
      mode: 'static',
      dryRun: true,
    });

    expect(mockedValidateTokenAdd).toHaveBeenCalledWith(
      '/project',
      expect.objectContaining({ tokenName: '--mybrowser-mybrowserish-gap' })
    );
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

  it('previews the variant selector instead of the category in dry-run', async () => {
    await tokenAddCommand('/project', '--mybrowser-canvas-bg', '#101010', {
      category: 'Colors',
      mode: 'static',
      variant: '[data-skin=precision]',
      dryRun: true,
    });

    expect(mockedValidateTokenAdd).toHaveBeenCalledWith('/project', {
      tokenName: '--mybrowser-canvas-bg',
      value: '#101010',
      category: 'Colors',
      mode: 'static',
      variant: '[data-skin=precision]',
      dryRun: true,
    });
    expect(info).toHaveBeenCalledWith('  Variant: :root[data-skin=precision]');
  });

  it('threads the variant through a non-dry-run add', async () => {
    await tokenAddCommand('/project', '--mybrowser-canvas-bg', '#101010', {
      category: 'Colors',
      mode: 'static',
      variant: '[data-private]',
    });

    expect(mockedAddToken).toHaveBeenCalledWith(
      '/project',
      expect.objectContaining({ variant: '[data-private]' })
    );
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

  it('names the category and line when a BASE add is skipped', async () => {
    mockedAddToken.mockResolvedValue({
      cssAdded: false,
      docsAdded: false,
      unmappedAdded: false,
      countUpdated: false,
      skipped: true,
      skippedExisting: { line: 42, category: 'Spacing' },
    });

    await tokenAddCommand('/project', '--mybrowser-gap', '12px', {
      category: 'Spacing',
      mode: 'static',
    });

    expect(info).toHaveBeenCalledWith(
      'Token --mybrowser-gap already exists in category "Spacing" (line 42), unchanged (skipped)'
    );
  });

  it('names the VARIANT block when a variant add is skipped', async () => {
    // The variant path used to report no location at all, so a re-run meant
    // to change a value exited 0 having silently changed nothing. A variant
    // declaration has no category to name — the block is the location.
    mockedAddToken.mockResolvedValue({
      cssAdded: false,
      docsAdded: false,
      unmappedAdded: false,
      countUpdated: false,
      skipped: true,
      skippedExisting: { line: 77 },
    });

    await tokenAddCommand('/project', '--mybrowser-gap', '12px', {
      mode: 'static',
      variant: '[data-skin="precision"]',
    });

    expect(info).toHaveBeenCalledWith(
      'Token --mybrowser-gap already exists in :root[data-skin="precision"] (line 77), unchanged (skipped)'
    );
  });

  it('falls back to the requested category when the skip carries none', async () => {
    mockedAddToken.mockResolvedValue({
      cssAdded: false,
      docsAdded: false,
      unmappedAdded: false,
      countUpdated: false,
      skipped: true,
      skippedExisting: { line: 9 },
    });

    await tokenAddCommand('/project', '--mybrowser-gap', '12px', {
      category: 'Spacing',
      mode: 'static',
    });

    expect(info).toHaveBeenCalledWith(
      'Token --mybrowser-gap already exists in category "Spacing" (line 9), unchanged (skipped)'
    );
  });

  it('adds a variant token with no --category at all', async () => {
    // `--category` used to be mandatory even under `--variant`, where it
    // describes nothing about where the declaration lands.
    mockedAddToken.mockResolvedValue({
      cssAdded: true,
      docsAdded: false,
      unmappedAdded: false,
      countUpdated: false,
      skipped: false,
    });

    await tokenAddCommand('/project', '--mybrowser-gap', '12px', {
      mode: 'static',
      variant: '[data-private]',
    });

    const passed = mockedAddToken.mock.calls[0]?.[1];
    expect(passed).toBeDefined();
    expect(passed && 'category' in passed).toBe(false);
    expect(passed?.variant).toBe('[data-private]');
  });

  it('guides the operator to `furnace init` when furnace.json is missing', async () => {
    // Without the guard this path surfaces `Token CSS file not found:
    // browser/themes/shared/<binary>-tokens.css` from
    // `assertTokenCategoryExists` — technically correct, but the missing
    // tokens CSS file is a downstream artefact of Furnace not being
    // initialized. The guard short-circuits with the actionable recovery
    // step.
    mockedFurnaceConfigExists.mockResolvedValue(false);

    await expect(
      tokenAddCommand('/project', '--mybrowser-audit-gap', '12px', {
        category: 'Spacing',
        mode: 'static',
      })
    ).rejects.toThrow(/Token management requires Furnace to be initialized/);

    // Must refuse before the token manager gets a chance to throw its
    // generic "file not found" error.
    expect(mockedAddToken).not.toHaveBeenCalled();
    expect(mockedValidateTokenAdd).not.toHaveBeenCalled();
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
    mockedFurnaceConfigExists.mockResolvedValue(true);
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

  it('prints help and exits cleanly when invoked without a subcommand', async () => {
    // `fireforge token` with no subcommand must print help and exit 0, like
    // `fireforge furnace` — falling through to commander's default
    // help-then-exit-1 path gives scripts probing the CLI surface an
    // inconsistent exit contract. Capturing stdout verifies both the exit
    // contract (no throw) and that the help content is rendered.
    const program = createProgram();
    const originalWrite = process.stdout.write.bind(process.stdout);
    let captured = '';
    process.stdout.write = (chunk: string | Uint8Array) => {
      captured += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
      return true;
    };

    try {
      await program.parseAsync(['node', 'fireforge', 'token']);
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(captured).toContain('Design token management');
    expect(captured).toContain('coverage');
  });
});
