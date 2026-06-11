// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge patch move-files <from> <to>` previews the explicit
 * re-export choreography needed to move file ownership between two patches.
 */

import { relative } from 'node:path';

import { Command } from 'commander';

import { getProjectPaths } from '../../core/config.js';
import { formatPatchNotFoundError } from '../../core/patch-identifier-suggest.js';
import { loadPatchesManifest, resolvePatchIdentifier } from '../../core/patch-manifest.js';
import { GeneralError, InvalidArgumentError } from '../../errors/base.js';
import type { CommandContext } from '../../types/cli.js';
import type { PatchMetadata, PatchMoveFilesOptions } from '../../types/commands/index.js';
import { pathExists } from '../../utils/fs.js';
import { info, intro, note, outro, warn } from '../../utils/logger.js';

function collectOption(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function normalizeFileList(files: readonly string[] | undefined): string[] {
  const cleaned = (files ?? []).map((file) => file.trim()).filter((file) => file.length > 0);
  return [...new Set(cleaned)].sort((left, right) => left.localeCompare(right));
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function formatFiles(files: readonly string[]): string {
  return files.length === 0 ? '(none)' : files.map((file) => `  - ${file}`).join('\n');
}

function formatReExportCommand(
  identifier: string,
  files: readonly string[],
  extraFlags: string[]
): string {
  return [
    'fireforge',
    're-export',
    shellQuote(identifier),
    '--files',
    ...files.map(shellQuote),
    ...extraFlags,
  ].join(' ');
}

function assertPatchHasFiles(owner: PatchMetadata, files: readonly string[]): void {
  const owned = new Set(owner.filesAffected);
  const missing = files.filter((file) => !owned.has(file));
  if (missing.length === 0) return;

  throw new InvalidArgumentError(
    `${owner.filename} does not currently own ${missing.length} requested file(s):\n${formatFiles(
      missing
    )}`,
    'patch move-files'
  );
}

function assertTargetDoesNotAlreadyOwnFiles(target: PatchMetadata, files: readonly string[]): void {
  const owned = new Set(target.filesAffected);
  const duplicates = files.filter((file) => owned.has(file));
  if (duplicates.length === 0) return;

  throw new InvalidArgumentError(
    `${target.filename} already owns ${duplicates.length} requested file(s):\n${formatFiles(
      duplicates
    )}`,
    'patch move-files'
  );
}

function computeFileMovePlan(
  source: PatchMetadata,
  target: PatchMetadata,
  files: readonly string[]
): { sourceAfter: string[]; targetAfter: string[] } {
  const moved = new Set(files);
  return {
    sourceAfter: source.filesAffected.filter((file) => !moved.has(file)).sort(),
    targetAfter: [...new Set([...target.filesAffected, ...files])].sort(),
  };
}

/**
 * Builds and prints a safe, no-write file ownership move plan.
 *
 * @param projectRoot - Project root directory
 * @param fromIdentifier - Patch filename, ordinal, or manifest name that currently owns the files
 * @param toIdentifier - Patch filename, ordinal, or manifest name that should own the files
 * @param options - Files to move and display mode
 */
export async function patchMoveFilesCommand(
  projectRoot: string,
  fromIdentifier: string,
  toIdentifier: string,
  options: PatchMoveFilesOptions = {}
): Promise<void> {
  intro('FireForge patch move-files');

  if (fromIdentifier === toIdentifier) {
    throw new InvalidArgumentError(
      'Source and target patch identifiers must be different.',
      'patch move-files'
    );
  }

  const files = normalizeFileList(options.file);
  if (files.length === 0) {
    throw new InvalidArgumentError('Specify at least one --file path to move.', 'patch move-files');
  }

  const paths = getProjectPaths(projectRoot);
  if (!(await pathExists(paths.patches))) {
    throw new GeneralError('Patches directory not found.');
  }

  const manifest = await loadPatchesManifest(paths.patches);
  if (!manifest || manifest.patches.length === 0) {
    throw new GeneralError('No patches in manifest.');
  }

  const source = resolvePatchIdentifier(fromIdentifier, manifest.patches);
  if (!source) {
    throw new InvalidArgumentError(
      formatPatchNotFoundError(fromIdentifier, manifest.patches),
      fromIdentifier
    );
  }

  const target = resolvePatchIdentifier(toIdentifier, manifest.patches);
  if (!target) {
    throw new InvalidArgumentError(
      formatPatchNotFoundError(toIdentifier, manifest.patches),
      toIdentifier
    );
  }

  if (source.filename === target.filename) {
    throw new InvalidArgumentError(
      'Source and target resolved to the same patch.',
      'patch move-files'
    );
  }

  assertPatchHasFiles(source, files);
  assertTargetDoesNotAlreadyOwnFiles(target, files);

  const { sourceAfter, targetAfter } = computeFileMovePlan(source, target, files);
  if (sourceAfter.length === 0) {
    throw new InvalidArgumentError(
      `${source.filename} would have no filesAffected after this move. Delete or re-export that patch explicitly instead.`,
      'patch move-files'
    );
  }

  for (const file of files) {
    if (!(await pathExists(`${paths.engine}/${file}`))) {
      warn(`engine/${file} does not exist in the current worktree; re-export may drop or fail it.`);
    }
  }

  const relativePatchesDir = relative(projectRoot, paths.patches) || 'patches';
  info(`Planning ownership move in ${relativePatchesDir}/patches.json.`);
  info(`Move ${files.length} file(s) from ${source.filename} to ${target.filename}:`);
  note(formatFiles(files), 'Files');

  note(formatFiles(sourceAfter), `${source.filename} files after move`);
  note(formatFiles(targetAfter), `${target.filename} files after move`);

  const dryRunSource = formatReExportCommand(source.filename, sourceAfter, ['--dry-run']);
  const dryRunTarget = formatReExportCommand(target.filename, targetAfter, ['--dry-run']);
  const applySource = formatReExportCommand(source.filename, sourceAfter, ['--yes']);
  const applyTarget = formatReExportCommand(target.filename, targetAfter, []);

  note(`${dryRunSource}\n${dryRunTarget}`, 'Preview commands');
  note(`${applySource}\n${applyTarget}`, 'Apply commands');

  info(
    'Tip: to move files into a brand-new patch in one transaction (including ' +
      'staged-dependency owner rewrites), use "fireforge patch split" instead.'
  );

  outro('Move plan complete - no changes made');
}

/**
 * Registers the preview-only `patch move-files` subcommand.
 *
 * @param parent - Parent `patch` command
 * @param context - Shared CLI registration context
 */
export function registerPatchMoveFiles(parent: Command, context: CommandContext): void {
  const { getProjectRoot, withErrorHandling } = context;
  parent
    .command('move-files <from> <to>')
    .description('Preview the re-export commands needed to move file ownership between patches.')
    .option(
      '--file <path>',
      'File path relative to engine/ to move (repeatable)',
      collectOption,
      []
    )
    .action(
      withErrorHandling(
        async (
          from: string,
          to: string,
          options: {
            file?: string[];
          }
        ) => {
          await patchMoveFilesCommand(getProjectRoot(), from, to, options);
        }
      )
    );
}
