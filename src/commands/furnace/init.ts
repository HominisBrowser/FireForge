// SPDX-License-Identifier: EUPL-1.2
import { dirname, isAbsolute, join, normalize } from 'node:path';

import { text } from '@clack/prompts';

import { getProjectPaths, loadConfig, mutateConfig, writeConfig } from '../../core/config.js';
import {
  createDefaultFurnaceConfig,
  furnaceConfigExists,
  writeFurnaceConfig,
} from '../../core/furnace-config.js';
import { DEFAULT_LICENSE } from '../../core/license-headers.js';
import { getTokensCssPath } from '../../core/token-manager.js';
import { generateDefaultTokensCss } from '../../core/token-scaffold.js';
import { FurnaceError } from '../../errors/furnace.js';
import type { FurnaceConfig } from '../../types/furnace.js';
import { toError } from '../../utils/errors.js';
import { ensureDir, pathExists, writeText } from '../../utils/fs.js';
import { cancel, info, intro, isCancel, note, outro, success, warn } from '../../utils/logger.js';

/**
 * Validates an FTL base path before writing it to furnace.json. Rejects
 * absolute paths, null bytes, and any normalised segment starting with
 * `..` — the previous `includes('..')` substring check caught the common
 * case but missed `./../../` and absolute paths that are arguably worse.
 */
function validateFtlBasePath(value: string): void {
  if (value.length === 0) {
    throw new FurnaceError('ftlBasePath must not be empty.');
  }
  if (value.includes('\0')) {
    throw new FurnaceError('ftlBasePath must not contain null bytes.');
  }
  if (isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value)) {
    throw new FurnaceError(
      `ftlBasePath "${value}" must be a relative path inside the engine checkout, not absolute.`
    );
  }
  const normalized = normalize(value.replace(/\\/g, '/'));
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new FurnaceError(
      `ftlBasePath "${value}" must not escape the engine checkout via parent-directory segments.`
    );
  }
}

/**
 * Runs the furnace init command to create a default furnace.json with
 * user-specified settings.
 * @param projectRoot - Root directory of the project
 * @param options - Init options
 */
export async function furnaceInitCommand(
  projectRoot: string,
  options: { prefix?: string; ftlBasePath?: string; force?: boolean } = {}
): Promise<void> {
  intro('Furnace Init');

  if ((await furnaceConfigExists(projectRoot)) && !options.force) {
    throw new FurnaceError('furnace.json already exists. Use --force to overwrite it.');
  }

  const config: FurnaceConfig = createDefaultFurnaceConfig();
  const isInteractive = process.stdin.isTTY && process.stdout.isTTY;

  // Resolve componentPrefix
  if (options.prefix !== undefined) {
    config.componentPrefix = options.prefix;
  } else if (isInteractive) {
    const prefixResult = await text({
      message: 'Component prefix (e.g. "moz-", "ff-")',
      initialValue: config.componentPrefix,
      validate: (value) => {
        if (!value) return 'Prefix is required';
        return undefined;
      },
    });
    if (isCancel(prefixResult)) {
      cancel('Init cancelled');
      return;
    }
    config.componentPrefix = prefixResult as string;
  }

  // Resolve ftlBasePath
  if (options.ftlBasePath !== undefined) {
    validateFtlBasePath(options.ftlBasePath);
    config.ftlBasePath = options.ftlBasePath;
  } else if (isInteractive) {
    const ftlResult = await text({
      message: 'Fluent l10n base path (leave empty for default)',
      placeholder: 'toolkit/locales/en-US/toolkit/global',
    });
    if (isCancel(ftlResult)) {
      cancel('Init cancelled');
      return;
    }
    const ftlValue = (ftlResult as string).trim();
    if (ftlValue) {
      validateFtlBasePath(ftlValue);
      config.ftlBasePath = ftlValue;
    }
  }

  await writeFurnaceConfig(projectRoot, config);
  success('Created furnace.json');

  const scaffoldResult = await scaffoldTokensCss(projectRoot);

  const lines: string[] = [`Component prefix: ${config.componentPrefix}`];
  if (config.ftlBasePath) {
    lines.push(`FTL base path: ${config.ftlBasePath}`);
  }
  if (scaffoldResult.tokensCssPath) {
    lines.push(`Tokens CSS:       ${scaffoldResult.tokensCssPath}`);
  }
  note(lines.join('\n'), 'Configuration');

  info(
    'Next steps:\n' +
      '  fireforge furnace scan        — discover engine components\n' +
      '  fireforge furnace create       — create a new custom component\n' +
      '  fireforge furnace override     — fork an existing component'
  );

  outro('Init complete');
}

/**
 * Scaffolds the default tokens CSS file under the engine and registers
 * its path in `fireforge.json`'s `patchLint.rawColorAllowlist`. Both
 * operations are skipped silently when the engine directory does not
 * yet exist (a fresh project that hasn't `fireforge download`ed yet);
 * the scaffold is re-driven on the next `furnace init --force`.
 *
 * Returns the scaffolded path when the file was actually created, so
 * the init command can surface it in the summary note.
 */
async function scaffoldTokensCss(projectRoot: string): Promise<{ tokensCssPath?: string }> {
  const paths = getProjectPaths(projectRoot);
  if (!(await pathExists(paths.engine))) {
    info(
      'Skipping tokens CSS scaffold: engine/ not found. Run "fireforge download" followed by "fireforge furnace init --force" to scaffold it.'
    );
    return {};
  }

  let forgeConfig;
  try {
    forgeConfig = await loadConfig(projectRoot);
  } catch (error: unknown) {
    warn(
      `Skipping tokens CSS scaffold: fireforge.json could not be loaded (${toError(error).message}). Re-run "fireforge furnace init --force" after fixing the config.`
    );
    return {};
  }

  const tokensCssPath = getTokensCssPath(forgeConfig.binaryName);
  const tokensCssAbsPath = join(paths.engine, tokensCssPath);

  if (!(await pathExists(tokensCssAbsPath))) {
    try {
      await ensureDir(dirname(tokensCssAbsPath));
      await writeText(
        tokensCssAbsPath,
        generateDefaultTokensCss(forgeConfig.binaryName, forgeConfig.license ?? DEFAULT_LICENSE)
      );
      success(`Scaffolded tokens CSS at engine/${tokensCssPath}`);
    } catch (error: unknown) {
      warn(
        `Could not scaffold tokens CSS at engine/${tokensCssPath}: ${toError(error).message}. Create the file manually before running "fireforge token add".`
      );
      return {};
    }
  } else {
    info(`Tokens CSS already present at engine/${tokensCssPath}; leaving it untouched.`);
  }

  // Registering the tokens file in `patchLint.rawColorAllowlist` is the
  // complement to the scaffold itself: the file exists specifically to
  // carry raw color literals, and without the allowlist entry the very
  // first `fireforge lint` run against a post-`token add` workspace
  // fails on raw-color-value issues for tokens the operator just
  // created. The add is idempotent, so re-running `furnace init --force`
  // does not duplicate the entry.
  try {
    const existingAllowlist = forgeConfig.patchLint?.rawColorAllowlist ?? [];
    if (!existingAllowlist.includes(tokensCssPath)) {
      const updatedConfig = mutateConfig(forgeConfig, 'patchLint.rawColorAllowlist', [
        ...existingAllowlist,
        tokensCssPath,
      ]);
      await writeConfig(projectRoot, updatedConfig);
      info(`Added ${tokensCssPath} to patchLint.rawColorAllowlist`);
    }
  } catch (error: unknown) {
    warn(
      `Could not register tokens CSS in patchLint.rawColorAllowlist: ${toError(error).message}. ` +
        `Add "${tokensCssPath}" manually under patchLint.rawColorAllowlist in fireforge.json if lint flags its contents.`
    );
  }

  return { tokensCssPath };
}
