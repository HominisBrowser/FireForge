// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { confirm, select, text } from '@clack/prompts';

import { addLicenseHeaderToFile, getLicenseHeader } from '../core/license-headers.js';
import { findAllPatchesForFiles } from '../core/patch-export.js';
import {
  commentStyleForFile,
  detectNewFilesInDiff,
  lintExportedPatch,
} from '../core/patch-lint.js';
import { GeneralError, InvalidArgumentError } from '../errors/base.js';
import type { ExportOptions, PatchCategory } from '../types/commands/index.js';
import type { FireForgeConfig } from '../types/config.js';
import { pathExists, readText } from '../utils/fs.js';
import type { SpinnerHandle } from '../utils/logger.js';
import { cancel, info, isCancel, warn } from '../utils/logger.js';
import { isValidPatchCategory, PATCH_CATEGORIES, validatePatchName } from '../utils/validation.js';

/**
 * Runs the full patch lint pipeline and reports results.
 * Warnings are always displayed. Errors block the export unless skipLint is true.
 *
 * @param engineDir - Engine root directory
 * @param filesAffected - Files touched by the patch
 * @param diffContent - Raw unified diff string
 * @param config - Project configuration
 * @param skipLint - If true, downgrade errors to warnings
 */
export async function runPatchLint(
  engineDir: string,
  filesAffected: string[],
  diffContent: string,
  config: FireForgeConfig,
  skipLint?: boolean
): Promise<void> {
  const issues = await lintExportedPatch(engineDir, filesAffected, diffContent, config);
  if (issues.length === 0) return;

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');

  for (const issue of warnings) {
    warn(`[${issue.check}] ${issue.file}: ${issue.message}`);
  }

  if (errors.length > 0) {
    for (const issue of errors) {
      if (skipLint) {
        warn(`[${issue.check}] ${issue.file}: ${issue.message}`);
      } else {
        warn(`ERROR [${issue.check}] ${issue.file}: ${issue.message}`);
      }
    }

    if (!skipLint) {
      throw new GeneralError(
        `Patch lint found ${errors.length} error(s) that must be fixed before exporting.\n` +
          'Use --skip-lint to bypass this check.'
      );
    }

    info(`Lint: ${errors.length} error(s) downgraded to warnings (--skip-lint)`);
  }

  const warnCount = warnings.length + (skipLint ? errors.length : 0);
  if (warnCount > 0) {
    info(`Patch lint: ${warnCount} warning(s)`);
  }
}

/**
 * Resolves patch metadata interactively or from flags, with shared validation.
 * @param options - Export command options
 * @param isInteractive - Whether interactive prompts are allowed
 * @param commandName - Command name for error/help text
 */
export async function promptExportPatchMetadata(
  options: ExportOptions,
  isInteractive: boolean,
  commandName: 'export' | 'export-all'
): Promise<{ patchName: string; selectedCategory: PatchCategory; description: string } | null> {
  let patchName = options.name;

  if (patchName) {
    const validationError = validatePatchName(patchName);
    if (validationError) {
      throw new InvalidArgumentError(validationError, '--name');
    }
  }

  if (!patchName && !isInteractive) {
    throw new InvalidArgumentError(
      'The --name flag is required in non-interactive mode',
      `Use: fireforge ${commandName} ${commandName === 'export' ? '<paths...> ' : ''}--name "my-patch-name" --category ui`
    );
  }

  if (!patchName) {
    const nameResult = await text({
      message: 'Enter a name for this patch:',
      placeholder: commandName === 'export' ? 'my-change' : 'my-changes',
      validate: (value) => validatePatchName((value ?? '').trim()),
    });

    if (isCancel(nameResult)) {
      cancel('Export cancelled');
      return null;
    }

    patchName = String(nameResult).trim();
  }

  let category = options.category;
  if (category) {
    if (!isValidPatchCategory(category)) {
      throw new InvalidArgumentError(
        `Invalid category. Must be one of: ${PATCH_CATEGORIES.join(', ')}`,
        '--category'
      );
    }
  } else if (!isInteractive) {
    throw new InvalidArgumentError(
      'The --category flag is required in non-interactive mode',
      `Use: fireforge ${commandName} ${commandName === 'export' ? '<paths...> ' : ''}--name "name" --category <${PATCH_CATEGORIES.join('|')}>`
    );
  } else {
    const categoryResult = await select({
      message: 'Select a category for this patch:',
      options: [
        { value: 'branding', label: 'branding - Logo, icons, names, about pages' },
        { value: 'ui', label: 'ui - User interface changes' },
        { value: 'privacy', label: 'privacy - Telemetry, tracking, data collection' },
        { value: 'security', label: 'security - Security hardening, policies' },
        { value: 'infra', label: 'infra - Build system, tooling, CI, configuration' },
      ],
    });

    if (isCancel(categoryResult)) {
      cancel('Export cancelled');
      return null;
    }

    category = categoryResult as PatchCategory;
  }

  let description = options.description ?? '';
  if (!description && isInteractive) {
    const descResult = await text({
      message: 'Enter a description (optional):',
      placeholder: 'Brief description of what this patch does',
    });

    if (!isCancel(descResult)) {
      description = String(descResult);
    }
  }

  return {
    patchName,
    selectedCategory: category,
    description,
  };
}

/**
 * Confirms whether an export may supersede existing patches.
 * @param patchesDir - Patches directory
 * @param filesAffected - Files touched by the pending export
 * @param supersede - Explicit supersede flag from CLI options
 * @param isInteractive - Whether interactive prompts are allowed
 * @param s - Active spinner handle to stop before prompting
 */
export async function confirmSupersedePatches(
  patchesDir: string,
  filesAffected: string[],
  supersede: boolean | undefined,
  isInteractive: boolean,
  s: SpinnerHandle
): Promise<boolean> {
  const wouldSupersede = await findAllPatchesForFiles(patchesDir, filesAffected);
  if (wouldSupersede.length === 0 || supersede) {
    return true;
  }

  s.stop();
  const count = wouldSupersede.length;
  warn(`This export would supersede ${count} existing patch${count === 1 ? '' : 'es'}:`);
  for (const patch of wouldSupersede) {
    warn(`  - ${patch.filename}`);
  }

  if (!isInteractive) {
    throw new GeneralError(
      `Refusing to supersede ${count} patch${count === 1 ? '' : 'es'} in non-interactive mode. ` +
        'Use --supersede to confirm, or use "fireforge re-export" to update existing patches in place.'
    );
  }

  const confirmed = await confirm({
    message: `Supersede ${count} patch${count === 1 ? '' : 'es'}? This cannot be undone.`,
    initialValue: false,
  });

  if (isCancel(confirmed) || !confirmed) {
    cancel('Export cancelled');
    return false;
  }

  return true;
}

/**
 * Detects new files missing license headers and offers to add them.
 *
 * In interactive mode the user is prompted before any files are modified.
 * In non-interactive mode the function is a no-op — the existing lint error
 * will block the export instead.
 *
 * @param engineDir - Absolute path to engine directory
 * @param diffContent - Current unified diff
 * @param config - Project configuration
 * @param isInteractive - Whether interactive prompts are available
 * @returns true if files were modified on disk (caller must regenerate diff)
 */
export async function autoFixLicenseHeaders(
  engineDir: string,
  diffContent: string,
  config: FireForgeConfig,
  isInteractive: boolean
): Promise<boolean> {
  const license = config.license ?? 'MPL-2.0';
  const newFiles = detectNewFilesInDiff(diffContent);
  if (newFiles.size === 0) return false;

  const filesToFix: string[] = [];
  for (const file of newFiles) {
    const style = commentStyleForFile(file);
    if (!style) continue;

    const filePath = join(engineDir, file);
    if (!(await pathExists(filePath))) continue;

    const content = await readText(filePath);
    const expectedHeader = getLicenseHeader(license, style);
    if (!content.startsWith(expectedHeader)) {
      filesToFix.push(file);
    }
  }

  if (filesToFix.length === 0) return false;
  if (!isInteractive) return false;

  const fileList = filesToFix.map((f) => `  - ${f}`).join('\n');
  info(`${filesToFix.length} new file(s) missing the ${license} license header:\n${fileList}`);

  const confirmed = await confirm({
    message: `Add ${license} headers to ${filesToFix.length} file(s)?`,
    initialValue: true,
  });

  if (isCancel(confirmed) || !confirmed) return false;

  for (const file of filesToFix) {
    const style = commentStyleForFile(file);
    if (!style) continue;
    const filePath = join(engineDir, file);
    await addLicenseHeaderToFile(filePath, license, style);
    info(`Added ${license} header to ${file}`);
  }

  return true;
}
