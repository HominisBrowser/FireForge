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
import { stripEnginePrefix } from '../utils/paths.js';

/**
 * Registers a file in the appropriate build manifest.
 *
 * @param projectRoot - Root directory of the project
 * @param filePath - Path relative to engine/ (a leading `engine/` segment is stripped)
 * @param options - Command options
 */
export async function registerCommand(
  projectRoot: string,
  filePath: string,
  options: RegisterOptions = {}
): Promise<void> {
  intro('Register');

  // --after is matched as a substring against existing manifest lines;
  // guard against control characters / line terminators that would either
  // break the match logic or, worse, inject a second line if the value
  // is ever echoed back to a manifest writer. Null bytes are explicitly
  // rejected to mirror the hardening already applied to other user-
  // supplied identifiers (binaryName, furnace targetPath, …).
  if (options.after !== undefined) {
    // eslint-disable-next-line no-control-regex -- control chars in --after would break the manifest match
    const hasControlChar = /[\u0000-\u001f]/.test(options.after);
    if (options.after.length === 0 || hasControlChar) {
      throw new InvalidArgumentError(
        '--after must be a non-empty substring without control characters or line terminators.',
        'after'
      );
    }
  }

  // Accept either repo-root-relative (`engine/browser/...`) or
  // engine-relative (`browser/...`) inputs — operators frequently paste
  // the former from the output of tab completion or `git status`, and
  // the mismatch used to produce a "File not found" error that named
  // the original path with no hint that dropping `engine/` would fix it.
  const engineRelativePath = stripEnginePrefix(filePath);

  // Verify the file exists in engine/ (skip for dry-run)
  if (!options.dryRun) {
    const paths = getProjectPaths(projectRoot);
    const fullPath = join(paths.engine, engineRelativePath);
    if (!(await pathExists(fullPath))) {
      throw new InvalidArgumentError(`File not found in engine: ${engineRelativePath}`, 'path');
    }
  }

  const result = await registerFile(projectRoot, engineRelativePath, options.dryRun, options.after);

  if (options.dryRun) {
    info(`[dry-run] Would register ${engineRelativePath}`);
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
    info(`Already registered: ${engineRelativePath} in ${result.manifest}`);
  } else {
    if (result.afterFallback) {
      warn(`--after target "${options.after}" not found, falling back to alphabetical order`);
    }
    const position = result.previousEntry ? ` (after ${result.previousEntry})` : '';
    success(`Registered ${engineRelativePath} in ${result.manifest}${position}`);
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
