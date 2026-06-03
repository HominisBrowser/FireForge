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
import { info, intro, outro, success } from '../utils/logger.js';
import { isValidFirefoxProduct } from '../utils/validation.js';

const SOURCE_PRODUCTS = [
  'firefox',
  'firefox-esr',
  'firefox-beta',
  'firefox-devedition',
] as const satisfies readonly FirefoxProduct[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneRawConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const cloned: unknown = structuredClone(raw);
  if (!isRecord(cloned)) {
    throw new GeneralError('Cannot update fireforge.json: config clone was not an object.');
  }
  return cloned;
}

function parseSourceProduct(product: string): FirefoxProduct {
  if (isValidFirefoxProduct(product)) {
    return product as FirefoxProduct;
  }
  throw new InvalidArgumentError(
    `--product must be one of: ${SOURCE_PRODUCTS.join(', ')}`,
    '--product'
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

  const written = await withConfigFileLock(projectRoot, async () => {
    const raw = await loadRawConfigDocument(projectRoot);
    const updated = cloneRawConfig(raw);
    const firefox = isRecord(updated['firefox']) ? { ...updated['firefox'] } : {};

    firefox['version'] = options.version;
    firefox['product'] = options.product;
    if (options.clearSha256 === true) {
      delete firefox['sha256'];
    } else if (options.sha256 !== undefined) {
      firefox['sha256'] = options.sha256;
    }
    updated['firefox'] = firefox;

    const validated = validateConfig(updated);
    if (validated.firefox.sha256 !== undefined) {
      firefox['sha256'] = validated.firefox.sha256;
    }

    await writeConfigDocument(projectRoot, updated);
    return validated.firefox;
  });

  const archive = resolveArchive(written.version, written.product);

  success(`Set firefox.version = ${written.version}`);
  success(`Set firefox.product = ${written.product}`);
  success(`Resolved source URL: ${archive.url}`);
  if (written.sha256 !== undefined) {
    success(`Set firefox.sha256 = ${written.sha256}`);
  } else if (options.clearSha256 === true) {
    info('Cleared firefox.sha256');
  }
  outro('');
}

/** Registers the source command on the CLI program. */
export function registerSource(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  const source = program.command('source').description('Manage Firefox source configuration');

  source
    .command('set')
    .description('Atomically set Firefox source version, product, and optional checksum')
    .requiredOption('--version <version>', 'Firefox version to base on')
    .addOption(
      new Option('--product <product>', 'Firefox product')
        .choices([...SOURCE_PRODUCTS])
        .makeOptionMandatory()
    )
    .option('--sha256 <hash>', 'Pinned SHA-256 for the resolved source archive')
    .option('--clear-sha256', 'Clear any existing pinned SHA-256')
    .action(
      withErrorHandling(
        async (options: {
          version: string;
          product: string;
          sha256?: string;
          clearSha256?: boolean;
        }) => {
          const { product, version, sha256, clearSha256 } = options;
          await sourceSetCommand(getProjectRoot(), {
            version,
            product: parseSourceProduct(product),
            ...(sha256 !== undefined ? { sha256 } : {}),
            ...(clearSha256 !== undefined ? { clearSha256 } : {}),
          });
        }
      )
    );
}
