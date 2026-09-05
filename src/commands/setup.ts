// SPDX-License-Identifier: EUPL-1.2
import { resolve } from 'node:path';

import { confirm } from '@clack/prompts';
import { Command, Option } from 'commander';

import { configExists } from '../core/config.js';
import { stdioIsInteractive } from '../core/destructive.js';
import { ConfigError } from '../errors/config.js';
import type { CommandContext } from '../types/cli.js';
import type { SetupOptions } from '../types/commands/index.js';
import { cancel, intro, isCancel, note, outro, spinner } from '../utils/logger.js';
import { pickDefined } from '../utils/options.js';
import { FIREFOX_PRODUCTS, PROJECT_LICENSES } from '../utils/validation.js';
import {
  buildSetupConfig,
  resolveFirefoxProduct,
  resolveProjectLicense,
  resolveSetupInputs,
  validateSetupOptions,
  writeSetupProjectFiles,
} from './setup-support.js';

/**
 * Runs the setup command.
 * @param projectRoot - Root directory for the project
 * @param options - CLI options for non-interactive mode
 */
export async function setupCommand(projectRoot: string, options: SetupOptions = {}): Promise<void> {
  // Validate any CLI-provided options first
  validateSetupOptions(options);

  // Determine if we can run interactively
  const isInteractive = stdioIsInteractive();

  intro('FireForge Setup');

  // Check if config already exists
  if (await configExists(projectRoot)) {
    if (options.force) {
      // Skip confirmation when --force is provided
    } else if (isInteractive) {
      const overwrite = await confirm({
        message: 'A fireforge.json already exists. Overwrite?',
        initialValue: false,
      });

      if (isCancel(overwrite) || !overwrite) {
        cancel('Setup cancelled');
        return;
      }
    } else {
      throw new ConfigError('fireforge.json already exists. Use --force to overwrite.');
    }
  }

  const resolved = await resolveSetupInputs(options, isInteractive);
  const config = buildSetupConfig(resolved);

  const s = spinner('Creating project structure...');

  try {
    await writeSetupProjectFiles(projectRoot, config);

    s.stop('Project structure created');

    // Show next steps
    note(
      `Next steps:\n` +
        `  1. fireforge download    # Download Firefox source\n` +
        `  2. fireforge bootstrap   # Install build dependencies\n` +
        `  3. fireforge build       # Build the browser\n` +
        `  4. fireforge run         # Launch the browser`,
      'Getting Started'
    );

    outro(`${config.name} project created successfully!`);
  } catch (error: unknown) {
    s.error('Failed to create project');
    throw error;
  }
}

/** Registers the setup command on the CLI program. */
export function registerSetup(program: Command, { withErrorHandling }: CommandContext): void {
  program
    .command('setup')
    .description('Initialize a new FireForge project')
    .option('--name <name>', 'Browser name')
    .option('--vendor <vendor>', 'Vendor/company name')
    .option('--app-id <appId>', 'Application ID (reverse-domain format)')
    .option('--binary-name <binaryName>', 'Binary name (executable name)')
    .option('--firefox-version <version>', 'Firefox version to base on')
    .addOption(new Option('--product <product>', 'Firefox product').choices([...FIREFOX_PRODUCTS]))
    .addOption(new Option('--license <license>', 'Project license').choices([...PROJECT_LICENSES]))
    .option('-f, --force', 'Overwrite existing configuration without prompting')
    // `--yes` is a plain alias here: `setup`'s only bypass is the overwrite
    // prompt, so the two flags mean exactly the same thing. Seventeen other
    // commands spell this bypass `--yes`; accepting it means a scripted
    // sequence can use one spelling throughout.
    .option('-y, --yes', 'Alias for --force: skip the overwrite confirmation')
    .action(
      withErrorHandling(
        async (options: {
          name?: string;
          vendor?: string;
          appId?: string;
          binaryName?: string;
          firefoxVersion?: string;
          product?: string;
          license?: string;
          force?: boolean;
          yes?: boolean;
        }) => {
          const { product, license, yes, ...rest } = options;
          const setupOptions: SetupOptions = { ...pickDefined(rest) };
          // `--yes` is an alias, so either flag sets the same bypass.
          if (yes === true) setupOptions.force = true;

          if (product !== undefined) {
            setupOptions.product = resolveFirefoxProduct(product, '--product');
          }

          if (license !== undefined) {
            setupOptions.license = resolveProjectLicense(license, '--license');
          }

          await setupCommand(resolve(process.cwd()), setupOptions);
        }
      )
    );
}
