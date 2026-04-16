// SPDX-License-Identifier: EUPL-1.2
import { isAbsolute, normalize } from 'node:path';

import { text } from '@clack/prompts';

import {
  createDefaultFurnaceConfig,
  furnaceConfigExists,
  writeFurnaceConfig,
} from '../../core/furnace-config.js';
import { FurnaceError } from '../../errors/furnace.js';
import type { FurnaceConfig } from '../../types/furnace.js';
import { cancel, info, intro, isCancel, note, outro, success } from '../../utils/logger.js';

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

  const lines: string[] = [`Component prefix: ${config.componentPrefix}`];
  if (config.ftlBasePath) {
    lines.push(`FTL base path: ${config.ftlBasePath}`);
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
