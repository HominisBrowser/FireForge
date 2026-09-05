// SPDX-License-Identifier: EUPL-1.2
import { Command, Option } from 'commander';

import { loadConfig } from '../core/config.js';
import { furnaceConfigExists, loadFurnaceConfig } from '../core/furnace-config.js';
import {
  addToken,
  type AddTokenResult,
  getTokensCssPath,
  isTokenMode,
  TOKEN_MODES,
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
import { tokenListCommand, tokenShowCommand } from './token-list.js';

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
      // A bare name that already starts with the configured prefix text is
      // treated as fully qualified. Blindly prepending would silently
      // produce a double-prefixed token (e.g. "--hominis-hominis-shadow-low").
      if (strippedName === strippedPrefix || strippedName.startsWith(`${strippedPrefix}-`)) {
        info(
          `Token name "${rawTokenName}" already starts with the configured prefix ` +
            `"${strippedPrefix}"; using --${strippedName} instead of prefixing it again.`
        );
        return normalizeTokenName(strippedName);
      }
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
 * Reports a no-op add, naming where the existing declaration lives.
 *
 * A variant skip has no category to name, because the declaration lives in
 * a `:root<selector>` block, so the location reads as that block. The
 * variant path used to report no location at all, so a re-run meant to
 * change a value exited 0 having silently changed nothing.
 *
 * @param tokenName - Full token name including prefix
 * @param result - Result carrying the skip location, when known
 * @param options - The invocation's options
 */
function reportSkippedToken(
  tokenName: string,
  result: AddTokenResult,
  options: TokenAddOptions
): void {
  const scope =
    options.variant !== undefined
      ? `:root${options.variant}`
      : `category "${result.skippedExisting?.category ?? options.category ?? ''}"`;
  const where = result.skippedExisting
    ? ` in ${scope} (line ${result.skippedExisting.line}), unchanged`
    : '';
  info(`Token ${tokenName} already exists${where} (skipped)`);
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

  // A fresh project without furnace.json otherwise fails deep inside the
  // token-manager's `assertTokenCategoryExists` with "Token CSS file not
  // found: browser/themes/shared/<binary>-tokens.css", which is technically
  // correct, but the operator's actual next step is to initialize Furnace, which
  // scaffolds the tokens CSS file. Catching the uninitialized case here
  // gives the right guidance before the generic "file not found" error.
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

  // Validate mode. The guard IS the runtime proof, so the three `as
  // TokenMode` casts this replaced are gone with it.
  if (!isTokenMode(options.mode)) {
    throw new InvalidArgumentError(
      `Invalid mode "${options.mode}". Must be one of: ${TOKEN_MODES.join(', ')}`,
      'mode'
    );
  }

  if (options.dryRun) {
    await validateTokenAdd(projectRoot, {
      tokenName,
      value,
      mode: options.mode,
      ...(options.category !== undefined ? { category: options.category } : {}),
      ...(options.description !== undefined ? { description: options.description } : {}),
      ...(options.darkValue !== undefined ? { darkValue: options.darkValue } : {}),
      ...(options.createCategory === true ? { createCategory: true } : {}),
      ...(options.variant !== undefined ? { variant: options.variant } : {}),
      dryRun: true,
    });

    info('[dry-run] Would add token:');
    info(`  Name: ${tokenName}`);
    info(`  Value: ${value}`);
    if (options.variant !== undefined) {
      info(`  Variant: :root${options.variant}`);
    } else {
      info(
        `  Category: ${options.category ?? '(none)'}${options.createCategory === true ? ' (created if missing)' : ''}`
      );
    }
    info(`  Mode: ${options.mode}`);
    if (options.description) info(`  Description: ${options.description}`);
    if (options.darkValue) info(`  Dark value: ${options.darkValue}`);
    outro('Dry run complete');
    return;
  }

  const result = await addToken(projectRoot, {
    tokenName,
    value,
    mode: options.mode,
    ...(options.category !== undefined ? { category: options.category } : {}),
    ...(options.description !== undefined ? { description: options.description } : {}),
    ...(options.darkValue !== undefined ? { darkValue: options.darkValue } : {}),
    ...(options.createCategory === true ? { createCategory: true } : {}),
    ...(options.variant !== undefined ? { variant: options.variant } : {}),
  });

  if (result.skipped) {
    reportSkippedToken(tokenName, result, options);
  } else {
    const forgeConfig = await loadConfig(projectRoot);
    const tokensCssFile = getTokensCssPath(forgeConfig.binaryName).split('/').pop();
    if (result.categoryCreated) success(`Created category "${options.category ?? ''}"`);
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
  const token = program
    .command('token')
    .description('Design token management')
    // Match `fireforge furnace`'s no-args contract: print the group's help
    // and exit 0. Without this default action, commander routes
    // `fireforge token` (no subcommand) through its own help-then-exit-1
    // path, so scripts probing the CLI surface see a misleading non-zero
    // exit for a purely informational invocation.
    .action(() => {
      token.outputHelp();
    });

  token
    .command('add <token-name> <value>')
    .description(
      'Add a design token to CSS and documentation. The token name is a positional argument, but most tokens start with `--` (CSS custom property syntax), which Commander reads as an option flag. Use the standard `--` separator to mark the end of options before the token name, e.g. `fireforge token add --mode static --category Colors -- --my-token "#fff"`. Bare names without `--` are accepted directly and prefixed using the configured Furnace `tokenPrefix`.'
    )
    .option(
      '--category <cat>',
      'Token category (e.g., "Colors — Canvas", "Spacing"). Required for a base declaration; ' +
        'not required with --variant, which routes into a :root<selector> block where no ' +
        'category applies'
    )
    .addOption(
      // Use Commander's .choices() so invalid --mode values are rejected with
      // the built-in "argument must be one of …" message and --help lists the
      // valid choices up-front. The runtime check in tokenAddCommand remains
      // as a defence-in-depth guard for programmatic callers that bypass
      // Commander's argument parsing.
      // Description ends with `(required)` because Commander's
      // `makeOptionMandatory` does not render a required marker in `--help`
      // output. Only `.requiredOption` does that, and switching to
      // `.requiredOption` would lose the `.choices()` enforcement. The
      // explicit suffix keeps the runtime validation and surfaces required
      // status in help alongside the other options that use `.requiredOption`.
      new Option('--mode <mode>', 'Dark mode behavior (required)')
        .choices(['auto', 'static', 'override'])
        .makeOptionMandatory(true)
    )
    .option('--description <desc>', 'Comment description for the CSS file')
    .option('--dark-value <val>', 'Dark mode value (required if mode is "override")')
    .option(
      '--variant <selector>',
      'Attribute selector fragment routing the declaration into a `:root<selector>` block ' +
        "(e.g. '[data-skin=precision]', '[data-private]', a run such as " +
        "'[data-skin=precision][data-theme=dark]', or one with a pseudo-class tail such as " +
        "'[data-skin=precision]:not([data-private])'); creates or updates the block. " +
        'CSS-only — cannot be combined with --mode override or --create-category. To author ' +
        'a new category and its variants, add the BASE token first (with --create-category), ' +
        'then add each variant with --variant.'
    )
    .option(
      '--create-category',
      'Declare the category banner in the tokens CSS if it does not exist yet'
    )
    .option('--dry-run', 'Show what would be changed without writing')
    .action(
      withErrorHandling(
        async (
          tokenName: string,
          value: string,
          options: {
            category?: string;
            mode: string;
            description?: string;
            darkValue?: string;
            dryRun?: boolean;
            createCategory?: boolean;
            variant?: string;
          }
        ) => {
          await tokenAddCommand(getProjectRoot(), tokenName, value, {
            mode: options.mode,
            ...pickDefined({
              category: options.category,
              description: options.description,
              darkValue: options.darkValue,
              dryRun: options.dryRun,
              createCategory: options.createCategory,
              variant: options.variant,
            }),
          });
        }
      )
    );

  token
    .command('list')
    .description(
      'List the design-token categories declared in the tokens CSS with their token names, in file order'
    )
    .option('--category <name>', 'Restrict the report to one category')
    .option('--json', 'Emit the machine-readable envelope on stdout (see docs/machine-output.md)')
    .action(
      withErrorHandling(async (options: { category?: string; json?: boolean }) => {
        await tokenListCommand(
          getProjectRoot(),
          pickDefined({ category: options.category, json: options.json })
        );
      })
    );

  token
    .command('show <token-name>')
    .description(
      'Show one token: its category, the value it takes in every declaring block, and where it is defined. The leading `--` is optional; with it, use the `--` separator first (e.g. `fireforge token show -- --my-token`).'
    )
    .option('--json', 'Emit the machine-readable envelope on stdout (see docs/machine-output.md)')
    .action(
      withErrorHandling(async (tokenName: string, options: { json?: boolean }) => {
        await tokenShowCommand(getProjectRoot(), tokenName, pickDefined({ json: options.json }));
      })
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
