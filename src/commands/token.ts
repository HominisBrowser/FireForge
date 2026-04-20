// SPDX-License-Identifier: EUPL-1.2
import { Command, Option } from 'commander';

import { loadConfig } from '../core/config.js';
import { furnaceConfigExists, loadFurnaceConfig } from '../core/furnace-config.js';
import {
  addToken,
  getTokensCssPath,
  type TokenMode,
  validateTokenAdd,
} from '../core/token-manager.js';
import { InvalidArgumentError } from '../errors/base.js';
import { FurnaceError } from '../errors/furnace.js';
import type { CommandContext } from '../types/cli.js';
import type { TokenAddOptions } from '../types/commands/index.js';
import { toError } from '../utils/errors.js';
import { info, intro, outro, success, warn } from '../utils/logger.js';
import { pickDefined } from '../utils/options.js';
import { normalizeTokenName } from '../utils/validation.js';
import { tokenCoverageCommand } from './token-coverage.js';

async function normalizeTokenNameForProject(
  projectRoot: string,
  rawTokenName: string
): Promise<string> {
  if (rawTokenName.startsWith('--')) {
    return normalizeTokenName(rawTokenName);
  }

  try {
    const furnaceConfig = await loadFurnaceConfig(projectRoot);
    if (furnaceConfig.tokenPrefix) {
      const strippedPrefix = furnaceConfig.tokenPrefix.replace(/^--/, '').replace(/-$/, '');
      const strippedName = rawTokenName.replace(/^--/, '');
      return `--${strippedPrefix}-${strippedName}`;
    }
  } catch (error: unknown) {
    warn(
      `Falling back to generic token normalization because furnace.json could not be loaded: ${toError(error).message}`
    );
  }

  return normalizeTokenName(rawTokenName);
}

/**
 * Adds a design token to the CSS file and documentation.
 *
 * @param projectRoot - Root directory of the project
 * @param tokenName - Full token name including prefix
 * @param value - CSS value
 * @param options - Command options
 */
export async function tokenAddCommand(
  projectRoot: string,
  tokenName: string,
  value: string,
  options: TokenAddOptions
): Promise<void> {
  intro('Token Add');

  // Finding #15: a fresh project without furnace.json failed deep inside
  // the token-manager's `assertTokenCategoryExists` with "Token CSS file
  // not found: browser/themes/shared/<binary>-tokens.css" — technically
  // correct, but the operator's actual next step is to initialize
  // Furnace (which scaffolds the tokens CSS file among other things).
  // Catching the uninitialized case here gives the right guidance up-
  // front before the generic "file not found" error fires.
  if (!(await furnaceConfigExists(projectRoot))) {
    throw new FurnaceError(
      'Token management requires Furnace to be initialized. ' +
        'Tokens live in the Furnace-managed tokens CSS file, which `fireforge furnace init` scaffolds alongside the rest of the Furnace workspace.\n\n' +
        'Run "fireforge furnace init" first, then rerun "fireforge token add ...".'
    );
  }

  // Normalize token name using the configured Furnace token prefix when the
  // user supplied a bare token name like "canvas-gap".
  tokenName = await normalizeTokenNameForProject(projectRoot, tokenName);

  // Validate mode
  const validModes: TokenMode[] = ['auto', 'static', 'override'];
  if (!validModes.includes(options.mode as TokenMode)) {
    throw new InvalidArgumentError(
      `Invalid mode "${options.mode}". Must be one of: ${validModes.join(', ')}`,
      'mode'
    );
  }

  if (options.dryRun) {
    await validateTokenAdd(projectRoot, {
      tokenName,
      value,
      category: options.category,
      mode: options.mode as TokenMode,
      ...(options.description !== undefined ? { description: options.description } : {}),
      ...(options.darkValue !== undefined ? { darkValue: options.darkValue } : {}),
      dryRun: true,
    });

    info('[dry-run] Would add token:');
    info(`  Name: ${tokenName}`);
    info(`  Value: ${value}`);
    info(`  Category: ${options.category}`);
    info(`  Mode: ${options.mode}`);
    if (options.description) info(`  Description: ${options.description}`);
    if (options.darkValue) info(`  Dark value: ${options.darkValue}`);
    outro('Dry run complete');
    return;
  }

  const result = await addToken(projectRoot, {
    tokenName,
    value,
    category: options.category,
    mode: options.mode as TokenMode,
    ...(options.description !== undefined ? { description: options.description } : {}),
    ...(options.darkValue !== undefined ? { darkValue: options.darkValue } : {}),
  });

  if (result.skipped) {
    info(`Token ${tokenName} already exists (skipped)`);
  } else {
    const forgeConfig = await loadConfig(projectRoot);
    const tokensCssFile = getTokensCssPath(forgeConfig.binaryName).split('/').pop();
    if (result.cssAdded) success(`Added ${tokenName} to ${tokensCssFile}`);
    if (result.docsAdded) success(`Added ${tokenName} to SRC_TOKENS.md`);
    if (result.unmappedAdded) info(`Added to unmapped tokens table (literal value)`);
    if (result.countUpdated) info(`Updated mode count in documentation`);
  }

  outro('Done');
}

/** Registers token management commands on the CLI program. */
export function registerToken(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  const token = program.command('token').description('Design token management');

  token
    .command('add <token-name> <value>')
    .description('Add a design token to CSS and documentation')
    .requiredOption('--category <cat>', 'Token category (e.g., "Colors — Canvas", "Spacing")')
    .addOption(
      // Use Commander's .choices() so invalid --mode values are rejected with
      // the built-in "argument must be one of …" message and --help lists the
      // valid choices up-front. The runtime check in tokenAddCommand remains
      // as a defence-in-depth guard for programmatic callers that bypass
      // Commander's argument parsing.
      new Option('--mode <mode>', 'Dark mode behavior')
        .choices(['auto', 'static', 'override'])
        .makeOptionMandatory(true)
    )
    .option('--description <desc>', 'Comment description for the CSS file')
    .option('--dark-value <val>', 'Dark mode value (required if mode is "override")')
    .option('--dry-run', 'Show what would be changed without writing')
    .action(
      withErrorHandling(
        async (
          tokenName: string,
          value: string,
          options: {
            category: string;
            mode: string;
            description?: string;
            darkValue?: string;
            dryRun?: boolean;
          }
        ) => {
          await tokenAddCommand(getProjectRoot(), tokenName, value, {
            category: options.category,
            mode: options.mode,
            ...pickDefined({
              description: options.description,
              darkValue: options.darkValue,
              dryRun: options.dryRun,
            }),
          });
        }
      )
    );

  token
    .command('coverage')
    .description('Measure design token usage across modified CSS files')
    .action(
      withErrorHandling(async () => {
        await tokenCoverageCommand(getProjectRoot());
      })
    );
}
