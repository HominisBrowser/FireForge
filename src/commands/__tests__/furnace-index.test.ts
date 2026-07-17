// SPDX-License-Identifier: EUPL-1.2
import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/engine-session-lock.js', () => ({
  withEngineSessionLock: vi.fn(
    (_projectRoot: string, _command: string, operation: () => Promise<unknown>) => operation()
  ),
}));

vi.mock('../furnace/apply.js', () => ({
  furnaceApplyCommand: vi.fn(() => Promise.resolve()),
}));

vi.mock('../furnace/create.js', () => ({
  furnaceCreateCommand: vi.fn(() => Promise.resolve()),
}));

vi.mock('../furnace/chrome-doc.js', () => ({
  furnaceChromeDocCreateCommand: vi.fn(() => Promise.resolve()),
}));

vi.mock('../furnace/chrome-doc-remove.js', () => ({
  furnaceChromeDocRemoveCommand: vi.fn(() => Promise.resolve()),
}));

vi.mock('../furnace/deploy.js', () => ({
  furnaceDeployCommand: vi.fn(() => Promise.resolve()),
}));

vi.mock('../furnace/diff.js', () => ({
  furnaceDiffCommand: vi.fn(() => Promise.resolve()),
}));

vi.mock('../furnace/init.js', () => ({
  furnaceInitCommand: vi.fn(() => Promise.resolve()),
}));

vi.mock('../furnace/list.js', () => ({
  furnaceListCommand: vi.fn(() => Promise.resolve()),
}));

vi.mock('../furnace/override.js', () => ({
  furnaceBatchOverrideCommand: vi.fn(() => Promise.resolve()),
  furnaceOverrideCommand: vi.fn(() => Promise.resolve()),
}));

vi.mock('../furnace/preview.js', () => ({
  furnacePreviewCommand: vi.fn(() => Promise.resolve()),
}));

vi.mock('../furnace/refresh.js', () => ({
  furnaceRefreshCommand: vi.fn(() => Promise.resolve()),
}));

vi.mock('../furnace/remove.js', () => ({
  furnaceRemoveCommand: vi.fn(() => Promise.resolve()),
}));

vi.mock('../furnace/rename.js', () => ({
  furnaceRenameCommand: vi.fn(() => Promise.resolve()),
}));

vi.mock('../furnace/scan.js', () => ({
  furnaceScanCommand: vi.fn(() => Promise.resolve()),
}));

vi.mock('../furnace/status.js', () => ({
  furnaceStatusCommand: vi.fn(() => Promise.resolve()),
}));

vi.mock('../furnace/sync.js', () => ({
  furnaceSyncCommand: vi.fn(() => Promise.resolve()),
}));

vi.mock('../furnace/validate.js', () => ({
  furnaceValidateCommand: vi.fn(() => Promise.resolve()),
}));

import { withEngineSessionLock } from '../../core/engine-session-lock.js';
import { furnaceApplyCommand } from '../furnace/apply.js';
import { furnaceChromeDocCreateCommand } from '../furnace/chrome-doc.js';
import { furnaceChromeDocRemoveCommand } from '../furnace/chrome-doc-remove.js';
import { furnaceCreateCommand } from '../furnace/create.js';
import { furnaceDeployCommand } from '../furnace/deploy.js';
import { furnaceDiffCommand } from '../furnace/diff.js';
import { registerFurnace } from '../furnace/index.js';
import { furnaceListCommand } from '../furnace/list.js';
import { furnaceBatchOverrideCommand, furnaceOverrideCommand } from '../furnace/override.js';
import { furnacePreviewCommand } from '../furnace/preview.js';
import { furnaceRefreshCommand } from '../furnace/refresh.js';
import { furnaceRemoveCommand } from '../furnace/remove.js';
import { furnaceRenameCommand } from '../furnace/rename.js';
import { furnaceScanCommand } from '../furnace/scan.js';
import { furnaceStatusCommand } from '../furnace/status.js';
import { furnaceSyncCommand } from '../furnace/sync.js';
import { furnaceValidateCommand } from '../furnace/validate.js';

function createProgram(): Command {
  const program = new Command();

  registerFurnace(program, {
    getProjectRoot: () => '/project',
    withErrorHandling: <T extends unknown[]>(handler: (...args: T) => Promise<void>) => handler,
  });

  return program;
}

async function runFurnaceCommand(...args: string[]): Promise<void> {
  const program = createProgram();
  await program.parseAsync(['node', 'fireforge', 'furnace', ...args]);
}

describe('registerFurnace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers the expected Furnace subcommands', () => {
    const program = createProgram();
    const furnace = program.commands.find((command) => command.name() === 'furnace');

    expect(furnace?.commands.map((command) => command.name())).toEqual([
      'status',
      'apply',
      'deploy',
      'scan',
      'init',
      'create',
      'chrome-doc',
      'override',
      'list',
      'remove',
      'preview',
      'validate',
      'diff',
      'refresh',
      'rename',
      'sync',
    ]);
  });

  it('routes the top-level furnace command to status', async () => {
    await runFurnaceCommand();

    expect(furnaceStatusCommand).toHaveBeenCalledWith('/project');
  });

  it('routes the status subcommand with an optional component name', async () => {
    await runFurnaceCommand('status', 'moz-button');

    expect(furnaceStatusCommand).toHaveBeenCalledWith('/project', 'moz-button');
  });

  it('routes apply with filtered options', async () => {
    await runFurnaceCommand('apply', '--dry-run');

    expect(furnaceApplyCommand).toHaveBeenCalledWith('/project', undefined, { dryRun: true });
  });

  it('routes mutating apply through the engine session lock', async () => {
    await runFurnaceCommand('apply', 'moz-button', '--force', '--watch');

    expect(furnaceApplyCommand).toHaveBeenCalledWith('/project', 'moz-button', {
      force: true,
      watch: true,
    });
  });

  it('routes deploy with an optional component name and options', async () => {
    await runFurnaceCommand('deploy', 'moz-button', '--dry-run');

    expect(furnaceDeployCommand).toHaveBeenCalledWith('/project', 'moz-button', {
      dryRun: true,
    });
  });

  it('routes mutating deploy through the engine session lock', async () => {
    await runFurnaceCommand('deploy', 'moz-button', '--skip-validate');

    expect(furnaceDeployCommand).toHaveBeenCalledWith('/project', 'moz-button', {
      skipValidate: true,
    });
  });

  it('routes scan to the Furnace scanner entrypoint', async () => {
    await runFurnaceCommand('scan');

    expect(furnaceScanCommand).toHaveBeenCalledWith('/project', {});
  });

  it('routes init with options', async () => {
    await runFurnaceCommand('init', '--prefix', 'ff-', '--force');

    const { furnaceInitCommand } = await import('../furnace/init.js');
    expect(furnaceInitCommand).toHaveBeenCalledWith('/project', {
      prefix: 'ff-',
      force: true,
    });
  });

  it('routes create with parsed compose tags and register toggle', async () => {
    await runFurnaceCommand(
      'create',
      'moz-pill',
      '--description',
      'Create a component',
      '--localized',
      '--no-register',
      '--with-tests',
      '--compose',
      'moz-button, moz-toolbarbutton'
    );

    expect(furnaceCreateCommand).toHaveBeenCalledWith('/project', 'moz-pill', {
      description: 'Create a component',
      localized: true,
      register: false,
      withTests: true,
      compose: ['moz-button', 'moz-toolbarbutton'],
    });
  });

  it('passes --test-style through to the create command', async () => {
    await runFurnaceCommand(
      'create',
      'moz-widget',
      '--with-tests',
      '--test-style',
      'browser-chrome'
    );

    expect(furnaceCreateCommand).toHaveBeenCalledWith(
      '/project',
      'moz-widget',
      expect.objectContaining({ withTests: true, testStyle: 'browser-chrome' })
    );
  });

  it('rejects invalid --test-style values', async () => {
    const program = createProgram();
    program.exitOverride();
    await expect(
      program.parseAsync([
        'node',
        'fireforge',
        'furnace',
        'create',
        'moz-widget',
        '--with-tests',
        '--test-style',
        'not-a-style',
      ])
    ).rejects.toThrow();
  });

  it('routes "furnace chrome-doc create" to the chrome-doc scaffolder', async () => {
    await runFurnaceCommand('chrome-doc', 'create', 'mybrowser');

    expect(furnaceChromeDocCreateCommand).toHaveBeenCalledWith(
      '/project',
      'mybrowser',
      expect.any(Object)
    );
  });

  it('passes --no-titlebar to the chrome-doc scaffolder', async () => {
    await runFurnaceCommand('chrome-doc', 'create', 'overlay', '--no-titlebar');

    expect(furnaceChromeDocCreateCommand).toHaveBeenCalledWith(
      '/project',
      'overlay',
      expect.objectContaining({ titlebar: false })
    );
  });

  it('passes --dry-run to the chrome-doc scaffolder', async () => {
    await runFurnaceCommand('chrome-doc', 'create', 'mybrowser', '--dry-run');

    expect(furnaceChromeDocCreateCommand).toHaveBeenCalledWith(
      '/project',
      'mybrowser',
      expect.objectContaining({ dryRun: true })
    );
  });

  it('routes "furnace chrome-doc remove" to the chrome-doc remover', async () => {
    await runFurnaceCommand('chrome-doc', 'remove', 'mybrowser', '--yes', '--dry-run');

    expect(furnaceChromeDocRemoveCommand).toHaveBeenCalledWith('/project', 'mybrowser', {
      yes: true,
      dryRun: true,
    });
  });

  it('routes override with typed options', async () => {
    await runFurnaceCommand(
      'override',
      'moz-button',
      '--type',
      'css-only',
      '--description',
      'Override button'
    );

    expect(furnaceOverrideCommand).toHaveBeenCalledWith('/project', 'moz-button', {
      type: 'css-only',
      description: 'Override button',
    });
  });

  it('routes multi-name override invocations to batch override', async () => {
    await runFurnaceCommand('override', 'moz-button', 'moz-card', '--type', 'full');

    expect(furnaceBatchOverrideCommand).toHaveBeenCalledWith(
      '/project',
      ['moz-button', 'moz-card'],
      {
        type: 'full',
      }
    );
  });

  it('routes list to the Furnace listing entrypoint', async () => {
    await runFurnaceCommand('list');

    expect(furnaceListCommand).toHaveBeenCalledWith('/project', {});
  });

  it('routes remove with the yes option', async () => {
    await runFurnaceCommand('remove', 'moz-button', '--yes');

    expect(furnaceRemoveCommand).toHaveBeenCalledWith('/project', 'moz-button', {
      yes: true,
    });
  });

  it('routes preview with install toggles', async () => {
    await runFurnaceCommand('preview', '--install');

    expect(furnacePreviewCommand).toHaveBeenCalledWith('/project', {
      install: true,
    });
  });

  it('routes validate with an optional component name', async () => {
    await runFurnaceCommand('validate', 'moz-button');

    expect(furnaceValidateCommand).toHaveBeenCalledWith('/project', 'moz-button', {});
  });

  it('routes diff to the component diff entrypoint', async () => {
    await runFurnaceCommand('diff', 'moz-button');

    expect(furnaceDiffCommand).toHaveBeenCalledWith('/project', 'moz-button');
  });

  it('routes refresh with filtered options', async () => {
    await runFurnaceCommand('refresh', 'moz-button', '--dry-run');

    expect(furnaceRefreshCommand).toHaveBeenCalledWith('/project', 'moz-button', {
      dryRun: true,
    });
  });

  it('routes validate with --fix option', async () => {
    await runFurnaceCommand('validate', '--fix');

    expect(furnaceValidateCommand).toHaveBeenCalledWith('/project', undefined, { fix: true });
  });

  it('routes sync with options', async () => {
    await runFurnaceCommand('sync', '--dry-run', '--strategy', 'theirs');

    expect(furnaceSyncCommand).toHaveBeenCalledWith('/project', {
      dryRun: true,
      strategy: 'theirs',
    });
  });

  it('routes mutating sync through the engine session lock', async () => {
    await runFurnaceCommand('sync', '--strategy', 'ours');

    expect(furnaceSyncCommand).toHaveBeenCalledWith('/project', {
      strategy: 'ours',
    });
  });

  it('threads --wait-lock <seconds> into the engine session lock wait budget', async () => {
    await runFurnaceCommand('apply', 'moz-button', '--wait-lock', '30');

    expect(withEngineSessionLock).toHaveBeenCalledWith(
      '/project',
      'furnace apply',
      expect.any(Function),
      { waitLockSeconds: 30 }
    );
    // The flag is a CLI-layer concern and must not leak into command options.
    expect(furnaceApplyCommand).toHaveBeenCalledWith('/project', 'moz-button', {});
  });

  it('maps a bare --wait-lock to the 60-second default budget', async () => {
    await runFurnaceCommand('sync', '--wait-lock');

    expect(withEngineSessionLock).toHaveBeenCalledWith(
      '/project',
      'furnace sync',
      expect.any(Function),
      { waitLockSeconds: 60 }
    );
    expect(furnaceSyncCommand).toHaveBeenCalledWith('/project', {});
  });

  it('rejects out-of-range --wait-lock values', async () => {
    const program = createProgram();
    // registerFurnace built the subcommands before exitOverride could be
    // inherited, so apply it to the nested commands explicitly.
    program.exitOverride();
    const furnace = program.commands.find((command) => command.name() === 'furnace');
    furnace?.exitOverride();
    for (const subcommand of furnace?.commands ?? []) {
      subcommand.exitOverride();
    }
    await expect(
      program.parseAsync(['node', 'fireforge', 'furnace', 'deploy', '--wait-lock', '0'])
    ).rejects.toThrow('--wait-lock must be an integer in 1..3600 (got "0")');
    expect(furnaceDeployCommand).not.toHaveBeenCalled();
  });

  it('routes diff without a name (all components)', async () => {
    await runFurnaceCommand('diff');

    expect(furnaceDiffCommand).toHaveBeenCalledWith('/project', undefined);
  });

  it('routes rename with old and new names', async () => {
    await runFurnaceCommand('rename', 'moz-old-widget', 'moz-new-widget');

    expect(furnaceRenameCommand).toHaveBeenCalledWith(
      '/project',
      'moz-old-widget',
      'moz-new-widget'
    );
  });
});
