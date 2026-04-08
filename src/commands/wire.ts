// SPDX-License-Identifier: EUPL-1.2
import { join, relative } from 'node:path';

import { Command } from 'commander';

import { DEFAULT_BROWSER_SUBSCRIPT_DIR, wireSubscript } from '../core/browser-wire.js';
import { getProjectPaths, loadConfig } from '../core/config.js';
import { consumeParserFallbackEvents } from '../core/parser-fallback.js';
import { InvalidArgumentError } from '../errors/base.js';
import type { CommandContext } from '../types/cli.js';
import type { WireOptions } from '../types/commands/index.js';
import { toError } from '../utils/errors.js';
import { pathExists } from '../utils/fs.js';
import { info, intro, outro, success, warn } from '../utils/logger.js';
import { pickDefined } from '../utils/options.js';
import { isContainedRelativePath, isPathInsideRoot, toRootRelativePath } from '../utils/paths.js';

const BROWSER_BASE_DIR = 'browser/base';

function printWireDryRun(
  engineDir: string,
  name: string,
  subscriptDir: string,
  domFilePath: string | undefined,
  options: WireOptions
): void {
  info('[dry-run] Would wire subscript:');
  info(`  source: ${subscriptDir}/${name}.js`);
  info(`  browser-main.js: loadSubScript("chrome://browser/content/${name}.js")`);
  if (options.init) {
    info(`  browser-init.js: ${options.init}`);
  }
  if (options.destroy) {
    info(`  browser-init.js onUnload(): ${options.destroy}`);
  }
  if (domFilePath) {
    const includePath = relative(
      join(engineDir, subscriptDir),
      join(engineDir, domFilePath)
    ).replace(/\\/g, '/');
    info(`  browser.xhtml: #include ${includePath}`);
  }
  const relPath = relative(
    join(engineDir, BROWSER_BASE_DIR),
    join(engineDir, subscriptDir)
  ).replace(/\\/g, '/');
  info(`  jar.mn: content/browser/${name}.js (${relPath}/${name}.js)`);
  outro('Dry run complete');
}

/**
 * Wires a chrome subscript into the browser.
 *
 * @param projectRoot - Root directory of the project
 * @param name - Subscript name (without .js extension)
 * @param options - Command options
 */
export async function wireCommand(
  projectRoot: string,
  name: string,
  options: WireOptions = {}
): Promise<void> {
  intro('Wire');
  consumeParserFallbackEvents();

  // Resolve subscript directory: CLI flag > fireforge.json > default
  let subscriptDir = DEFAULT_BROWSER_SUBSCRIPT_DIR;
  try {
    const config = await loadConfig(projectRoot);
    if (config.wire?.subscriptDir) {
      subscriptDir = config.wire.subscriptDir;
    }
  } catch (error: unknown) {
    warn(
      `Using default wire.subscriptDir because fireforge.json could not be loaded: ${toError(error).message}`
    );
  }
  if (options.subscriptDir) {
    if (!isContainedRelativePath(options.subscriptDir)) {
      throw new InvalidArgumentError(
        `Subscript directory must stay within engine/: ${options.subscriptDir}`,
        'subscriptDir'
      );
    }
    subscriptDir = options.subscriptDir;
  }

  // Validate DOM fragment file exists and compute path relative to engine root
  let domFilePath: string | undefined;
  if (options.dom) {
    const paths = getProjectPaths(projectRoot);
    if (!(await pathExists(options.dom))) {
      throw new InvalidArgumentError(`DOM fragment file not found: ${options.dom}`, 'dom');
    }
    if (!isPathInsideRoot(paths.engine, options.dom)) {
      throw new InvalidArgumentError(
        `DOM fragment file must stay within engine/: ${options.dom}`,
        'dom'
      );
    }
    domFilePath = toRootRelativePath(paths.engine, options.dom);
  }

  // Verify the subscript file exists in engine/ (skip for dry-run)
  if (!options.dryRun) {
    const paths = getProjectPaths(projectRoot);
    const subscriptPath = join(paths.engine, subscriptDir, `${name}.js`);
    if (!(await pathExists(subscriptPath))) {
      throw new InvalidArgumentError(
        `Subscript file not found: ${subscriptDir}/${name}.js\n` +
          'Create the file in engine/ before wiring.',
        'name'
      );
    }
  }

  if (options.dryRun) {
    printWireDryRun(getProjectPaths(projectRoot).engine, name, subscriptDir, domFilePath, options);
    return;
  }

  const result = await wireSubscript(projectRoot, name, {
    ...(options.init !== undefined ? { init: options.init } : {}),
    ...(options.destroy !== undefined ? { destroy: options.destroy } : {}),
    ...(domFilePath !== undefined ? { domFilePath } : {}),
    ...(options.after !== undefined ? { after: options.after } : {}),
    ...(subscriptDir !== DEFAULT_BROWSER_SUBSCRIPT_DIR ? { subscriptDir } : {}),
    dryRun: false,
  });

  const parserFallbacks = consumeParserFallbackEvents();
  if (parserFallbacks.length > 0) {
    const contexts = [...new Set(parserFallbacks.map((event) => event.context))];
    info(
      `Legacy parser fallback was used for ${contexts.length} file${contexts.length === 1 ? '' : 's'}: ${contexts.join(', ')}`
    );
  }

  if (result.subscriptAdded) {
    success(`Added loadSubScript for ${name}.js to browser-main.js`);
  } else {
    info(`${name}.js already registered in browser-main.js (skipped)`);
  }

  if (options.init) {
    if (result.initAdded) {
      success(`Added init expression to browser-init.js onLoad()`);
    } else {
      info(`Init expression already present in browser-init.js (skipped)`);
    }
  }

  if (options.destroy) {
    if (result.destroyAdded) {
      success(`Added destroy expression to browser-init.js onUnload()`);
    } else {
      info(`Destroy expression already present in browser-init.js (skipped)`);
    }
  }

  if (domFilePath) {
    if (result.domInserted) {
      success(`Inserted #include directive into browser.xhtml`);
    } else {
      info(`#include directive already present in browser.xhtml (skipped)`);
    }
  }

  if (result.jarMnResult.skipped) {
    info(`${name}.js already registered in jar.mn (skipped)`);
  } else {
    success(`Registered ${name}.js in ${result.jarMnResult.manifest}`);
  }

  outro('Wiring complete');
}

/** Registers the wire command on the CLI program. */
export function registerWire(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  program
    .command('wire <name>')
    .description('Wire a chrome subscript into the browser')
    .option('--init <expression>', 'Init expression for browser-init.js onLoad()')
    .option('--destroy <expression>', 'Destroy expression for browser-init.js onUnload()')
    .option('--dom <file>', 'XHTML fragment file to insert into browser.xhtml')
    .option('--dry-run', 'Show what would be changed without writing')
    .option('--after <name>', 'Insert init block after the block for this name')
    .option(
      '--subscript-dir <dir>',
      'Subscript directory relative to engine/ (default: browser/base/content)'
    )
    .action(
      withErrorHandling(
        async (
          name: string,
          options: {
            init?: string;
            destroy?: string;
            dom?: string;
            dryRun?: boolean;
            after?: string;
            subscriptDir?: string;
          }
        ) => {
          await wireCommand(getProjectRoot(), name, pickDefined(options));
        }
      )
    );
}
