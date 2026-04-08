// SPDX-License-Identifier: EUPL-1.2
import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../furnace/apply.js', () => ({
  furnaceApplyCommand: vi.fn(() => Promise.resolve()),
}));

vi.mock('../furnace/create.js', () => ({
  furnaceCreateCommand: vi.fn(() => Promise.resolve()),
}));

vi.mock('../furnace/deploy.js', () => ({
  furnaceDeployCommand: vi.fn(() => Promise.resolve()),
}));

vi.mock('../furnace/diff.js', () => ({
  furnaceDiffCommand: vi.fn(() => Promise.resolve()),
}));

vi.mock('../furnace/list.js', () => ({
  furnaceListCommand: vi.fn(() => Promise.resolve()),
}));

vi.mock('../furnace/override.js', () => ({
  furnaceOverrideCommand: vi.fn(() => Promise.resolve()),
}));

vi.mock('../furnace/preview.js', () => ({
  furnacePreviewCommand: vi.fn(() => Promise.resolve()),
}));

vi.mock('../furnace/remove.js', () => ({
  furnaceRemoveCommand: vi.fn(() => Promise.resolve()),
}));

vi.mock('../furnace/scan.js', () => ({
  furnaceScanCommand: vi.fn(() => Promise.resolve()),
}));

vi.mock('../furnace/status.js', () => ({
  furnaceStatusCommand: vi.fn(() => Promise.resolve()),
}));

vi.mock('../furnace/validate.js', () => ({
  furnaceValidateCommand: vi.fn(() => Promise.resolve()),
}));

import { furnaceApplyCommand } from '../furnace/apply.js';
import { furnaceCreateCommand } from '../furnace/create.js';
import { furnaceDeployCommand } from '../furnace/deploy.js';
import { furnaceDiffCommand } from '../furnace/diff.js';
import { registerFurnace } from '../furnace/index.js';
import { furnaceListCommand } from '../furnace/list.js';
import { furnaceOverrideCommand } from '../furnace/override.js';
import { furnacePreviewCommand } from '../furnace/preview.js';
import { furnaceRemoveCommand } from '../furnace/remove.js';
import { furnaceScanCommand } from '../furnace/scan.js';
import { furnaceStatusCommand } from '../furnace/status.js';
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
      'create',
      'override',
      'list',
      'remove',
      'preview',
      'validate',
      'diff',
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

    expect(furnaceApplyCommand).toHaveBeenCalledWith('/project', { dryRun: true });
  });

  it('routes deploy with an optional component name and options', async () => {
    await runFurnaceCommand('deploy', 'moz-button', '--dry-run');

    expect(furnaceDeployCommand).toHaveBeenCalledWith('/project', 'moz-button', {
      dryRun: true,
    });
  });

  it('routes scan to the Furnace scanner entrypoint', async () => {
    await runFurnaceCommand('scan');

    expect(furnaceScanCommand).toHaveBeenCalledWith('/project');
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

  it('routes list to the Furnace listing entrypoint', async () => {
    await runFurnaceCommand('list');

    expect(furnaceListCommand).toHaveBeenCalledWith('/project');
  });

  it('routes remove with the force option', async () => {
    await runFurnaceCommand('remove', 'moz-button', '--force');

    expect(furnaceRemoveCommand).toHaveBeenCalledWith('/project', 'moz-button', {
      force: true,
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

    expect(furnaceValidateCommand).toHaveBeenCalledWith('/project', 'moz-button');
  });

  it('routes diff to the component diff entrypoint', async () => {
    await runFurnaceCommand('diff', 'moz-button');

    expect(furnaceDiffCommand).toHaveBeenCalledWith('/project', 'moz-button');
  });
});
