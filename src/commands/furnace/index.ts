// SPDX-License-Identifier: EUPL-1.2
import { Command, Option } from 'commander';

import type { CommandContext } from '../../types/cli.js';
import { pickDefined } from '../../utils/options.js';
import { furnaceApplyCommand } from './apply.js';
import { furnaceChromeDocCreateCommand } from './chrome-doc.js';
import { furnaceCreateCommand } from './create.js';
import { furnaceDeployCommand } from './deploy.js';
import { furnaceDiffCommand } from './diff.js';
import { furnaceInitCommand } from './init.js';
import { furnaceListCommand } from './list.js';
import { furnaceBatchOverrideCommand, furnaceOverrideCommand } from './override.js';
import { furnacePreviewCommand } from './preview.js';
import { furnaceRefreshCommand } from './refresh.js';
import { furnaceRemoveCommand } from './remove.js';
import { furnaceRenameCommand } from './rename.js';
import { furnaceScanCommand } from './scan.js';
import { furnaceStatusCommand } from './status.js';
import { furnaceSyncCommand } from './sync.js';
import { furnaceValidateCommand } from './validate.js';

export {
  furnaceApplyCommand,
  furnaceBatchOverrideCommand,
  furnaceChromeDocCreateCommand,
  furnaceCreateCommand,
  furnaceDeployCommand,
  furnaceDiffCommand,
  furnaceInitCommand,
  furnaceListCommand,
  furnaceOverrideCommand,
  furnacePreviewCommand,
  furnaceRefreshCommand,
  furnaceRemoveCommand,
  furnaceRenameCommand,
  furnaceScanCommand,
  furnaceStatusCommand,
  furnaceSyncCommand,
  furnaceValidateCommand,
};

/**
 * Registers Furnace commands for querying component state: status, scan,
 * and action commands like apply, deploy, and create.
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
    .command('apply [name]')
    .description('Apply components to the engine (optionally a single component)')
    .option(
      '--dry-run',
      'Show what would be changed without writing (reads may overlap concurrent mutations)'
    )
    .option('--force', 'Proceed despite baseVersion drift (stale overrides)')
    .option('-w, --watch', 'Watch component directories and re-apply on changes')
    .action(
      withErrorHandling(
        async (name?: string, options?: { dryRun?: boolean; force?: boolean; watch?: boolean }) => {
          await furnaceApplyCommand(getProjectRoot(), name, pickDefined(options ?? {}));
        }
      )
    );

  furnace
    .command('deploy [name]')
    .description('Apply components and validate in one step')
    .option(
      '--dry-run',
      'Show what would be changed without writing (reads may overlap concurrent mutations)'
    )
    .option('--force', 'Proceed despite baseVersion drift (stale overrides)')
    .option('--skip-validate', 'Skip the validation step (apply only)')
    .action(
      withErrorHandling(
        async (
          name?: string,
          options?: { dryRun?: boolean; force?: boolean; skipValidate?: boolean }
        ) => {
          await furnaceDeployCommand(getProjectRoot(), name, pickDefined(options ?? {}));
        }
      )
    );

  furnace
    .command('scan')
    .description('Scan engine for available components')
    .option('--deep', 'Search additional Firefox directories beyond the default widgets path')
    .action(
      withErrorHandling(async (options: { deep?: boolean }) => {
        await furnaceScanCommand(getProjectRoot(), pickDefined(options));
      })
    );

  furnace
    .command('init')
    .description('Initialize furnace.json with project settings')
    .option('-p, --prefix <prefix>', 'Component prefix (e.g. "moz-", "ff-")')
    .option('--ftl-base-path <path>', 'Fluent l10n base path')
    .option('--force', 'Overwrite existing furnace.json')
    .action(
      withErrorHandling(
        async (options: { prefix?: string; ftlBasePath?: string; force?: boolean }) => {
          await furnaceInitCommand(getProjectRoot(), options);
        }
      )
    );

  furnace
    .command('create [name]')
    .description('Create a new custom component')
    .option('-d, --description <desc>', 'Component description')
    .option('--localized', 'Include Fluent l10n support')
    .option('--no-register', 'Skip customElements.js registration')
    .option('--with-tests', 'Scaffold a test harness (defaults to MochiKit; see --test-style)')
    .option(
      '--xpcshell',
      'Scaffold an xpcshell test harness (for storage-layer code on forks without tabbrowser); equivalent to --test-style=xpcshell. Note: xpcshell resolves chrome://global/* URIs but not chrome://browser/* — use --test-style=browser-chrome for browser-chrome-dependent tests.'
    )
    .option(
      '--test-style <style>',
      "Override the harness written by --with-tests: mochikit (default, runs against non-tabbrowser chrome), browser-chrome (today's scaffold, needs tabbrowser), or xpcshell (headless)",
      (value: string) => {
        if (value !== 'mochikit' && value !== 'browser-chrome' && value !== 'xpcshell') {
          throw new Error(
            `--test-style must be one of: mochikit, browser-chrome, xpcshell. Got: "${value}".`
          );
        }
        return value;
      }
    )
    .option(
      '--compose <tags>',
      'Record stock tags composed internally (metadata only, comma-separated)',
      (val: string) => val.split(',').map((s) => s.trim())
    )
    .option(
      '--shared-ftl <path>',
      'Participate in an existing feature-scoped .ftl at this path (e.g. "browser/mybrowser-dock.ftl"); skips the per-component .ftl scaffold (implies --localized)'
    )
    .option('--dry-run', 'Show the planned file set and furnace.json changes without writing')
    .option(
      '--allow-prefix-mismatch',
      'Create the component even when its name does not start with the configured `componentPrefix` in furnace.json. Without this flag the command refuses to write anything on a prefix mismatch.'
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
            xpcshell?: boolean;
            testStyle?: 'mochikit' | 'browser-chrome' | 'xpcshell';
            compose?: string[];
            sharedFtl?: string;
            dryRun?: boolean;
            allowPrefixMismatch?: boolean;
          }
        ) => {
          await furnaceCreateCommand(getProjectRoot(), name, options);
        }
      )
    );

  const chromeDoc = furnace
    .command('chrome-doc')
    .description('Scaffold top-level chrome documents (xhtml + js + css + ftl + jar.mn)');

  chromeDoc
    .command('create <name>')
    .description('Scaffold a new top-level chrome document')
    .option('--no-titlebar', 'Frameless overlay-style document (omits titlebar-buttonbox)')
    .option(
      '--with-tests',
      'Scaffold an xpcshell packaging-verification test that probes XCurProcD/chrome/browser/... directly (bypasses the xpcshell chrome:// URI limitation).'
    )
    .action(
      withErrorHandling(
        async (name: string, options: { titlebar?: boolean; withTests?: boolean }) => {
          await furnaceChromeDocCreateCommand(getProjectRoot(), name, pickDefined(options));
        }
      )
    );
}

/**
 * Registers Furnace commands for authoring, inspection, and maintenance:
 * override, list, remove, preview, validate, diff, refresh, and rename.
 * @param furnace - Parent Furnace command
 * @param context - Shared CLI registration context
 */
function registerFurnaceModifyCommands(furnace: Command, context: CommandContext): void {
  const { getProjectRoot, withErrorHandling } = context;

  furnace
    .command('override [names...]')
    .description('Fork one or more existing components for modification')
    .addOption(new Option('-t, --type <type>', 'Override type').choices(['css-only', 'full']))
    .option('-d, --description <desc>', 'Description')
    .action(
      withErrorHandling(
        async (names: string[], options: { type?: 'css-only' | 'full'; description?: string }) => {
          if (names.length <= 1) {
            await furnaceOverrideCommand(getProjectRoot(), names[0], options);
          } else {
            await furnaceBatchOverrideCommand(getProjectRoot(), names, options);
          }
        }
      )
    );

  furnace
    .command('list')
    .description('List all registered components')
    .option('-v, --verbose', 'Show per-component health indicators (clean/modified/not applied)')
    .action(
      withErrorHandling(async (options: { verbose?: boolean }) => {
        await furnaceListCommand(getProjectRoot(), options);
      })
    );

  furnace
    .command('remove <name>')
    .description('Remove a component from the workspace')
    .option('-y, --yes', 'Skip confirmation')
    .action(
      withErrorHandling(async (name: string, options: { yes?: boolean }) => {
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
    .option('--fix', 'Auto-fix registration issues (missing jar.mn entries, customElements.js)')
    .action(
      withErrorHandling(async (name?: string, options?: { fix?: boolean }) => {
        await furnaceValidateCommand(getProjectRoot(), name, pickDefined(options ?? {}));
      })
    );

  furnace
    .command('diff [name]')
    .description(
      'Show changes vs baseline (overrides: vs Firefox original, custom: vs engine). Shows all components when name is omitted.'
    )
    .action(
      withErrorHandling(async (name?: string) => {
        await furnaceDiffCommand(getProjectRoot(), name);
      })
    );

  furnace
    .command('refresh [name]')
    .description('Merge upstream Firefox changes into overrides (three-way merge)')
    .option('--dry-run', 'Show what would change without modifying files')
    .option('-a, --all', 'Refresh all overrides in a single batch')
    .addOption(
      new Option(
        '-s, --strategy <strategy>',
        'Auto-resolve conflicts (ours = keep local, theirs = accept upstream)'
      ).choices(['ours', 'theirs'])
    )
    .option(
      '--reset-base',
      'Reset baseline to current engine HEAD (skips three-way merge, recovers from missing baseCommit)'
    )
    .action(
      withErrorHandling(
        async (
          name: string | undefined,
          options: {
            dryRun?: boolean;
            all?: boolean;
            strategy?: 'ours' | 'theirs';
            resetBase?: boolean;
          }
        ) => {
          await furnaceRefreshCommand(getProjectRoot(), name, pickDefined(options));
        }
      )
    );

  furnace
    .command('rename <old-name> <new-name>')
    .description('Rename a component (updates files, config, and registrations)')
    .action(
      withErrorHandling(async (oldName: string, newName: string) => {
        await furnaceRenameCommand(getProjectRoot(), oldName, newName);
      })
    );

  furnace
    .command('sync')
    .description(
      'Refresh drifted overrides and re-apply all components (recommended after fireforge download)'
    )
    .option(
      '--dry-run',
      'Show what would change without modifying files (reads may overlap concurrent mutations)'
    )
    .addOption(
      new Option(
        '-s, --strategy <strategy>',
        'Auto-resolve merge conflicts (ours = keep local, theirs = accept upstream)'
      ).choices(['ours', 'theirs'])
    )
    .action(
      withErrorHandling(async (options: { dryRun?: boolean; strategy?: 'ours' | 'theirs' }) => {
        await furnaceSyncCommand(getProjectRoot(), pickDefined(options));
      })
    );
}

/** Registers the furnace command on the CLI program. */
export function registerFurnace(program: Command, context: CommandContext): void {
  const { getProjectRoot, withErrorHandling } = context;

  const furnace = program
    .command('furnace')
    .description(
      'Component management — create, override, apply, deploy, diff, validate, sync (run furnace --help for all subcommands)'
    )
    .action(
      withErrorHandling(async () => {
        await furnaceStatusCommand(getProjectRoot());
      })
    );

  registerFurnaceInfoCommands(furnace, context);
  registerFurnaceModifyCommands(furnace, context);
}
