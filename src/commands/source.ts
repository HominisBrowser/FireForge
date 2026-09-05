// SPDX-License-Identifier: EUPL-1.2
import { Command, Option } from 'commander';

import {
  configExists,
  loadRawConfigDocument,
  validateConfig,
  withConfigFileLock,
  writeConfigDocument,
} from '../core/config.js';
import { resolveArchive } from '../core/firefox-archive.js';
import { GeneralError, InvalidArgumentError } from '../errors/base.js';
import type { CommandContext } from '../types/cli.js';
import type { SourceSetOptions } from '../types/commands/index.js';
import type { FirefoxProduct } from '../types/config.js';
import type { JsonObject } from '../types/json.js';
import { info, intro, outro, success } from '../utils/logger.js';
import {
  FIREFOX_PRODUCTS,
  isJsonObject,
  isObject,
  isValidFirefoxCandidate,
  isValidFirefoxProduct,
} from '../utils/validation.js';

function cloneRawConfig(raw: JsonObject): JsonObject {
  const cloned: unknown = structuredClone(raw);
  if (!isObject(cloned)) {
    throw new GeneralError('Cannot update fireforge.json: config clone was not an object.');
  }
  // A structured clone of a JSON document is itself a JSON document; the
  // object check above is the only invariant left to establish.
  return cloned as JsonObject;
}

function parseSourceProduct(product: string): FirefoxProduct {
  if (isValidFirefoxProduct(product)) {
    return product;
  }
  throw new InvalidArgumentError(
    `--product must be one of: ${FIREFOX_PRODUCTS.join(', ')}`,
    '--product'
  );
}

function parseSourceCandidate(candidate: string): string {
  if (isValidFirefoxCandidate(candidate)) {
    return candidate;
  }
  throw new InvalidArgumentError(
    `--candidate must look like "buildN" (e.g. "build2"), got "${candidate}"`,
    '--candidate'
  );
}

/**
 * Atomically updates the Firefox source tuple in fireforge.json.
 */
export async function sourceSetCommand(
  projectRoot: string,
  options: SourceSetOptions
): Promise<void> {
  intro('FireForge Source');

  if (!(await configExists(projectRoot))) {
    throw new GeneralError('No fireforge.json found. Run "fireforge setup" to create a project.');
  }
  if (options.sha256 !== undefined && options.clearSha256 === true) {
    throw new InvalidArgumentError('--sha256 cannot be combined with --clear-sha256', '--sha256');
  }
  if (options.candidate !== undefined && options.clearCandidate === true) {
    throw new InvalidArgumentError(
      '--candidate cannot be combined with --clear-candidate',
      '--candidate'
    );
  }

  const written = await withConfigFileLock(projectRoot, async () => {
    const raw = await loadRawConfigDocument(projectRoot);
    const updated = cloneRawConfig(raw);
    const existingFirefox = updated['firefox'];
    const firefox: JsonObject = isJsonObject(existingFirefox) ? { ...existingFirefox } : {};

    firefox['version'] = options.version;
    firefox['product'] = options.product;
    if (options.clearSha256 === true) {
      delete firefox['sha256'];
    } else if (options.sha256 !== undefined) {
      firefox['sha256'] = options.sha256;
    }
    if (options.clearCandidate === true) {
      delete firefox['candidate'];
    } else if (options.candidate !== undefined) {
      firefox['candidate'] = options.candidate;
    }
    updated['firefox'] = firefox;

    const validated = validateConfig(updated);
    if (validated.firefox.sha256 !== undefined) {
      firefox['sha256'] = validated.firefox.sha256;
    }

    await writeConfigDocument(projectRoot, updated);
    return validated.firefox;
  });

  const archive = resolveArchive(written.version, written.product, written.candidate);

  success(`Set firefox.version = ${written.version}`);
  success(`Set firefox.product = ${written.product}`);
  success(`Resolved source URL: ${archive.url}`);
  if (written.sha256 !== undefined) {
    success(`Set firefox.sha256 = ${written.sha256}`);
  } else if (options.clearSha256 === true) {
    info('Cleared firefox.sha256');
  }
  if (written.candidate !== undefined) {
    success(`Set firefox.candidate = ${written.candidate}`);
  } else if (options.clearCandidate === true) {
    info('Cleared firefox.candidate');
  }
  outro('');
}

/** Registers the source command on the CLI program. */
export function registerSource(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  const source = program
    .command('source')
    .description('Manage Firefox source configuration')
    // No-subcommand contract shared with `patch`/`token`/`furnace`: help on
    // stdout, exit 0 (see `handleParseError` for the groups without an action).
    .action(() => {
      source.outputHelp();
    });

  source
    .command('set')
    .description('Atomically set Firefox source version, product, and optional checksum')
    .requiredOption('--version <version>', 'Firefox version to base on')
    .addOption(
      new Option('--product <product>', 'Firefox product')
        .choices([...FIREFOX_PRODUCTS])
        .makeOptionMandatory()
    )
    .option('--sha256 <hash>', 'Pinned SHA-256 for the resolved source archive')
    .option('--clear-sha256', 'Clear any existing pinned SHA-256')
    .option(
      '--candidate <buildN>',
      'Release-candidate build directory (e.g. "build2")',
      parseSourceCandidate
    )
    .option('--clear-candidate', 'Clear any existing release-candidate build directory')
    .action(
      withErrorHandling(
        async (options: {
          version: string;
          product: string;
          sha256?: string;
          clearSha256?: boolean;
          candidate?: string;
          clearCandidate?: boolean;
        }) => {
          const { product, version, sha256, clearSha256, candidate, clearCandidate } = options;
          await sourceSetCommand(getProjectRoot(), {
            version,
            product: parseSourceProduct(product),
            ...(sha256 !== undefined ? { sha256 } : {}),
            ...(clearSha256 !== undefined ? { clearSha256 } : {}),
            ...(candidate !== undefined ? { candidate } : {}),
            ...(clearCandidate !== undefined ? { clearCandidate } : {}),
          });
        }
      )
    );
}
