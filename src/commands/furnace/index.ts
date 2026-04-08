// SPDX-License-Identifier: EUPL-1.2
import { Command, Option } from 'commander';

import type { CommandContext } from '../../types/cli.js';
import { pickDefined } from '../../utils/options.js';
import { furnaceApplyCommand } from './apply.js';
import { furnaceCreateCommand } from './create.js';
import { furnaceDeployCommand } from './deploy.js';
import { furnaceDiffCommand } from './diff.js';
import { furnaceListCommand } from './list.js';
import { furnaceOverrideCommand } from './override.js';
import { furnacePreviewCommand } from './preview.js';
import { furnaceRemoveCommand } from './remove.js';
import { furnaceScanCommand } from './scan.js';
import { furnaceStatusCommand } from './status.js';
import { furnaceValidateCommand } from './validate.js';

export {
  furnaceApplyCommand,
  furnaceCreateCommand,
  furnaceDeployCommand,
  furnaceDiffCommand,
  furnaceListCommand,
  furnaceOverrideCommand,
  furnacePreviewCommand,
  furnaceRemoveCommand,
  furnaceScanCommand,
  furnaceStatusCommand,
  furnaceValidateCommand,
};

/**
 * Registers read-only Furnace commands such as status, apply, deploy, and scan.
 * @param furnace - Parent Furnace command
 * @param context - Shared CLI registration context
 */
function registerFurnaceInfoCommands(furnace: Command, context: CommandContext): void {
  const { getProjectRoot, withErrorHandling } = context;

  furnace
    .command('status [name]')
    .description('Show component status and registration details')
    .action(
      withErrorHandling(async (name?: string) => {
        await furnaceStatusCommand(getProjectRoot(), name);
      })
    );

  furnace
    .command('apply')
    .description('Apply all components to the engine')
    .option('--dry-run', 'Show what would be changed without writing')
    .action(
      withErrorHandling(async (options: { dryRun?: boolean }) => {
        await furnaceApplyCommand(getProjectRoot(), pickDefined(options));
      })
    );

  furnace
    .command('deploy [name]')
    .description('Apply components and validate in one step')
    .option('--dry-run', 'Show what would be changed without writing')
    .action(
      withErrorHandling(async (name?: string, options?: { dryRun?: boolean }) => {
        await furnaceDeployCommand(getProjectRoot(), name, pickDefined(options ?? {}));
      })
    );

  furnace
    .command('scan')
    .description('Scan engine for available components')
    .action(
      withErrorHandling(async () => {
        await furnaceScanCommand(getProjectRoot());
      })
    );

  furnace
    .command('create [name]')
    .description('Create a new custom component')
    .option('-d, --description <desc>', 'Component description')
    .option('--localized', 'Include Fluent l10n support')
    .option('--no-register', 'Skip customElements.js registration')
    .option('--with-tests', 'Scaffold Mochitest directory and register in moz.build')
    .option(
      '--compose <tags>',
      'Stock component tags composed internally (comma-separated)',
      (val: string) => val.split(',').map((s) => s.trim())
    )
    .action(
      withErrorHandling(
        async (
          name: string | undefined,
          options: {
            description?: string;
            localized?: boolean;
            register?: boolean;
            withTests?: boolean;
            compose?: string[];
          }
        ) => {
          await furnaceCreateCommand(getProjectRoot(), name, options);
        }
      )
    );
}

/**
 * Registers modifying Furnace commands such as override, remove, preview, and diff.
 * @param furnace - Parent Furnace command
 * @param context - Shared CLI registration context
 */
function registerFurnaceModifyCommands(furnace: Command, context: CommandContext): void {
  const { getProjectRoot, withErrorHandling } = context;

  furnace
    .command('override [name]')
    .description('Fork an existing component for modification')
    .addOption(new Option('-t, --type <type>', 'Override type').choices(['css-only', 'full']))
    .option('-d, --description <desc>', 'Description')
    .action(
      withErrorHandling(
        async (
          name: string | undefined,
          options: { type?: 'css-only' | 'full'; description?: string }
        ) => {
          await furnaceOverrideCommand(getProjectRoot(), name, options);
        }
      )
    );

  furnace
    .command('list')
    .description('List all registered components')
    .action(
      withErrorHandling(async () => {
        await furnaceListCommand(getProjectRoot());
      })
    );

  furnace
    .command('remove <name>')
    .description('Remove a component from the workspace')
    .option('-f, --force', 'Skip confirmation')
    .action(
      withErrorHandling(async (name: string, options: { force?: boolean }) => {
        await furnaceRemoveCommand(getProjectRoot(), name, options);
      })
    );

  furnace
    .command('preview')
    .description('Start component preview (Storybook)')
    .option('--install', 'Force reinstall Storybook dependencies')
    .action(
      withErrorHandling(async (options: { install?: boolean }) => {
        await furnacePreviewCommand(getProjectRoot(), options);
      })
    );

  furnace
    .command('validate [name]')
    .description('Run accessibility and compatibility checks')
    .action(
      withErrorHandling(async (name?: string) => {
        await furnaceValidateCommand(getProjectRoot(), name);
      })
    );

  furnace
    .command('diff <name>')
    .description('Show changes vs Firefox original (overrides only)')
    .action(
      withErrorHandling(async (name: string) => {
        await furnaceDiffCommand(getProjectRoot(), name);
      })
    );
}

/** Registers the furnace command on the CLI program. */
export function registerFurnace(program: Command, context: CommandContext): void {
  const { getProjectRoot, withErrorHandling } = context;

  const furnace = program
    .command('furnace')
    .description('Component management (Furnace)')
    .action(
      withErrorHandling(async () => {
        await furnaceStatusCommand(getProjectRoot());
      })
    );

  registerFurnaceInfoCommands(furnace, context);
  registerFurnaceModifyCommands(furnace, context);
}
