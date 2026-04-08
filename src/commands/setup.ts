// SPDX-License-Identifier: EUPL-1.2
import { confirm } from '@clack/prompts';
import { Command, Option } from 'commander';

import { configExists } from '../core/config.js';
import { ConfigError } from '../errors/config.js';
import type { CommandContext } from '../types/cli.js';
import type { SetupOptions } from '../types/commands/index.js';
import { cancel, intro, isCancel, note, outro, spinner } from '../utils/logger.js';
import { pickDefined } from '../utils/options.js';
import { PROJECT_LICENSES } from '../utils/validation.js';
import {
  buildSetupConfig,
  parseFirefoxProductOption,
  parseProjectLicenseOption,
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
  const isInteractive = process.stdin.isTTY && process.stdout.isTTY;

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
export function registerSetup(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  program
    .command('setup')
    .description('Initialize a new FireForge project')
    .option('--name <name>', 'Browser name')
    .option('--vendor <vendor>', 'Vendor/company name')
    .option('--app-id <appId>', 'Application ID (reverse-domain format)')
    .option('--binary-name <binaryName>', 'Binary name (executable name)')
    .option('--firefox-version <version>', 'Firefox version to base on')
    .addOption(
      new Option('--product <product>', 'Firefox product').choices([
        'firefox',
        'firefox-esr',
        'firefox-beta',
      ])
    )
    .addOption(new Option('--license <license>', 'Project license').choices([...PROJECT_LICENSES]))
    .option('-f, --force', 'Overwrite existing configuration without prompting')
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
        }) => {
          const { product, license, ...rest } = options;
          const setupOptions: SetupOptions = { ...pickDefined(rest) };

          if (product !== undefined) {
            const parsedProduct = parseFirefoxProductOption(product);
            if (parsedProduct !== undefined) {
              setupOptions.product = parsedProduct;
            }
          }

          if (license !== undefined) {
            const parsedLicense = parseProjectLicenseOption(license);
            if (parsedLicense !== undefined) {
              setupOptions.license = parsedLicense;
            }
          }

          await setupCommand(getProjectRoot(), setupOptions);
        }
      )
    );
}
