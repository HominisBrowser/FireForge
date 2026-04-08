// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { Command } from 'commander';

import { getProjectPaths } from '../core/config.js';
import { registerFile } from '../core/manifest-rules.js';
import { InvalidArgumentError } from '../errors/base.js';
import type { CommandContext } from '../types/cli.js';
import type { RegisterOptions } from '../types/commands/index.js';
import { pathExists } from '../utils/fs.js';
import { info, intro, outro, success, warn } from '../utils/logger.js';
import { pickDefined } from '../utils/options.js';

/**
 * Registers a file in the appropriate build manifest.
 *
 * @param projectRoot - Root directory of the project
 * @param filePath - Path relative to engine/
 * @param options - Command options
 */
export async function registerCommand(
  projectRoot: string,
  filePath: string,
  options: RegisterOptions = {}
): Promise<void> {
  intro('Register');

  // Verify the file exists in engine/ (skip for dry-run)
  if (!options.dryRun) {
    const paths = getProjectPaths(projectRoot);
    const fullPath = join(paths.engine, filePath);
    if (!(await pathExists(fullPath))) {
      throw new InvalidArgumentError(`File not found in engine: ${filePath}`, 'path');
    }
  }

  const result = await registerFile(projectRoot, filePath, options.dryRun, options.after);

  if (options.dryRun) {
    info(`[dry-run] Would register ${filePath}`);
    info(`  manifest: ${result.manifest}`);
    info(`  entry: ${result.entry}`);
    if (result.previousEntry) {
      info(`  insert after: ${result.previousEntry}`);
    } else {
      info('  insert at: start of matching section');
    }
    if (result.afterFallback) {
      warn(`--after target "${options.after}" not found, falling back to alphabetical order`);
    }
    outro('Dry run complete');
    return;
  }

  if (result.skipped) {
    info(`Already registered: ${filePath} in ${result.manifest}`);
  } else {
    if (result.afterFallback) {
      warn(`--after target "${options.after}" not found, falling back to alphabetical order`);
    }
    const position = result.previousEntry ? ` (after ${result.previousEntry})` : '';
    success(`Registered ${filePath} in ${result.manifest}${position}`);
    info("hint: Run 'fireforge build --ui' to make the new module available at runtime");
  }

  outro('Done');
}

/** Registers the browser content registration command on the CLI program. */
export function registerRegister(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  program
    .command('register <path>')
    .description('Register a file in the appropriate build manifest')
    .option('--dry-run', 'Show what would be changed without writing')
    .option(
      '--after <entry>',
      'Place entry after line containing this substring (instead of alphabetical)'
    )
    .action(
      withErrorHandling(async (path: string, options: { dryRun?: boolean; after?: string }) => {
        await registerCommand(getProjectRoot(), path, pickDefined(options));
      })
    );
}
