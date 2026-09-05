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
import { furnaceInitCommand } from '../furnace/init.js';
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

  // The router's whole job is dispatch, so the dispatch table IS its
  // behaviour: a `list` that reaches `furnaceRemoveCommand` is a data-loss
  // bug no other suite would catch. One table beats sixteen near-identical
  // tests, and it fails loudly when a subcommand is added without wiring.
  it.each([
    ['scan', furnaceScanCommand, ['/project', {}]],
    ['init', furnaceInitCommand, ['/project', {}]],
    ['list', furnaceListCommand, ['/project', {}]],
    ['preview', furnacePreviewCommand, ['/project', {}]],
    ['refresh', furnaceRefreshCommand, ['/project', undefined, {}]],
  ] as const)('routes %s to its command handler', async (name, handler, expected) => {
    await runFurnaceCommand(name);

    expect(handler).toHaveBeenCalledWith(...expected);
  });

  it('routes remove and rename to their handlers with the named component', async () => {
    await runFurnaceCommand('remove', 'moz-thing', '--yes');
    expect(furnaceRemoveCommand).toHaveBeenCalledWith('/project', 'moz-thing', { yes: true });

    await runFurnaceCommand('rename', 'moz-old', 'moz-new');
    expect(furnaceRenameCommand).toHaveBeenCalledWith('/project', 'moz-old', 'moz-new');
  });

  it('routes the nested "furnace chrome-doc remove" to its own handler', async () => {
    await runFurnaceCommand('chrome-doc', 'remove', 'moz-thing');

    expect(furnaceChromeDocRemoveCommand).toHaveBeenCalled();
  });

  it('routes the top-level furnace command to status', async () => {
    await runFurnaceCommand();

    expect(furnaceStatusCommand).toHaveBeenCalledWith('/project');
  });

  it('routes apply with filtered options', async () => {
    await runFurnaceCommand('apply', '--dry-run');

    expect(furnaceApplyCommand).toHaveBeenCalledWith('/project', undefined, { dryRun: true });
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

  it('routes the nested "furnace chrome-doc create" with its parsed options', async () => {
    await runFurnaceCommand('chrome-doc', 'create', 'overlay', '--no-titlebar', '--dry-run');

    expect(furnaceChromeDocCreateCommand).toHaveBeenCalledWith(
      '/project',
      'overlay',
      expect.objectContaining({ titlebar: false, dryRun: true })
    );
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

  it('routes validate with an optional component name', async () => {
    await runFurnaceCommand('validate', 'moz-button');

    expect(furnaceValidateCommand).toHaveBeenCalledWith('/project', 'moz-button', {});
  });

  it('routes diff to the component diff entrypoint', async () => {
    await runFurnaceCommand('diff', 'moz-button');

    expect(furnaceDiffCommand).toHaveBeenCalledWith('/project', 'moz-button');
  });

  it('routes status with a named component', async () => {
    await runFurnaceCommand('status', 'moz-button');

    expect(furnaceStatusCommand).toHaveBeenCalledWith('/project', 'moz-button');
  });

  it('routes deploy and sync through the engine session lock', async () => {
    await runFurnaceCommand('deploy', 'moz-button');
    expect(furnaceDeployCommand).toHaveBeenCalledWith('/project', 'moz-button', {});
    expect(withEngineSessionLock).toHaveBeenCalledWith(
      '/project',
      'furnace deploy',
      expect.any(Function),
      {}
    );

    vi.mocked(withEngineSessionLock).mockClear();
    await runFurnaceCommand('sync');
    expect(furnaceSyncCommand).toHaveBeenCalledWith('/project', {});
    expect(withEngineSessionLock).toHaveBeenCalledWith(
      '/project',
      'furnace sync',
      expect.any(Function),
      {}
    );
  });

  it('runs a --dry-run deploy or sync WITHOUT taking the engine session lock', async () => {
    // A dry run mutates nothing, so making it queue behind a running build
    // would be a needless refusal; the short-circuit is the contract.
    await runFurnaceCommand('deploy', 'moz-button', '--dry-run');
    expect(furnaceDeployCommand).toHaveBeenCalledWith('/project', 'moz-button', { dryRun: true });
    expect(withEngineSessionLock).not.toHaveBeenCalled();

    await runFurnaceCommand('sync', '--dry-run');
    expect(furnaceSyncCommand).toHaveBeenCalledWith('/project', { dryRun: true });
    expect(withEngineSessionLock).not.toHaveBeenCalled();
  });

  it('threads --wait-lock <seconds> into BOTH locks the mutation takes', async () => {
    await runFurnaceCommand('apply', 'moz-button', '--wait-lock', '30');

    expect(withEngineSessionLock).toHaveBeenCalledWith(
      '/project',
      'furnace apply',
      expect.any(Function),
      { waitLockSeconds: 30 }
    );
    // A furnace mutation takes the engine session lock and then
    // `.fireforge/furnace.lock`. The budget reaching only the first is what
    // made `--wait-lock 1800` die at the file lock's fixed 30 s having paid
    // the entire wait, so the resolved value must reach the command options
    // too — `runFurnaceMutation` turns it into the file lock's timeout.
    expect(furnaceApplyCommand).toHaveBeenCalledWith('/project', 'moz-button', {
      waitLockSeconds: 30,
    });
  });

  it('maps a bare --wait-lock to the 60-second default budget', async () => {
    await runFurnaceCommand('sync', '--wait-lock');

    expect(withEngineSessionLock).toHaveBeenCalledWith(
      '/project',
      'furnace sync',
      expect.any(Function),
      { waitLockSeconds: 60 }
    );
    expect(furnaceSyncCommand).toHaveBeenCalledWith('/project', { waitLockSeconds: 60 });
  });

  it('leaves the furnace lock on its default budget when no --wait-lock is given', async () => {
    await runFurnaceCommand('apply', 'moz-button');

    // Absent the flag (and the env var), nothing is threaded: the file lock
    // keeps its 30 s default and the ~1 s fail-fast path is untouched.
    expect(furnaceApplyCommand).toHaveBeenCalledWith('/project', 'moz-button', {});
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
});
