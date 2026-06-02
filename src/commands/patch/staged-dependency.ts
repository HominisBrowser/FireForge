// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge patch staged-dependency <name>` — edits
 * PatchMetadata.stagedDependencies without rewriting the .patch body.
 */

import { Command } from 'commander';

import { getProjectPaths } from '../../core/config.js';
import { appendHistory } from '../../core/destructive.js';
import { mutatePatchMetadata } from '../../core/patch-export.js';
import { formatPatchNotFoundError } from '../../core/patch-identifier-suggest.js';
import { loadPatchesManifest, resolvePatchIdentifier } from '../../core/patch-manifest.js';
import { GeneralError, InvalidArgumentError } from '../../errors/base.js';
import type { CommandContext } from '../../types/cli.js';
import type {
  PatchStagedDependencyOptions,
  PatchStagedForwardImport,
} from '../../types/commands/index.js';
import { toError } from '../../utils/errors.js';
import { pathExists } from '../../utils/fs.js';
import { info, intro, outro, warn } from '../../utils/logger.js';

type StagedDependencyMode = 'add' | 'remove' | 'clear';

function modeFromOptions(options: PatchStagedDependencyOptions): StagedDependencyMode {
  const adding = options.add === true;
  const removing = options.remove === true;
  const clearing = options.clear === true;
  const modeCount = [adding, removing, clearing].filter(Boolean).length;
  if (modeCount > 1) {
    throw new InvalidArgumentError(
      '--add, --remove, and --clear are mutually exclusive. Pick one mode per invocation.',
      'patch staged-dependency'
    );
  }
  if (modeCount === 0) {
    throw new InvalidArgumentError(
      'Specify --add, --remove, or --clear.',
      'patch staged-dependency'
    );
  }
  return adding ? 'add' : removing ? 'remove' : 'clear';
}

function requireForwardImportOptions(
  options: PatchStagedDependencyOptions,
  mode: Exclude<StagedDependencyMode, 'clear'>
): PatchStagedForwardImport {
  if (!options.file || !options.specifier || !options.creates) {
    throw new InvalidArgumentError(
      `--${mode} requires --file, --specifier, and --creates.`,
      'patch staged-dependency'
    );
  }
  const dependency: PatchStagedForwardImport = {
    file: options.file,
    specifier: options.specifier,
    creates: options.creates,
  };
  if (options.owner !== undefined) dependency.owner = options.owner;
  if (options.reason !== undefined) dependency.reason = options.reason;
  return dependency;
}

function dependencyKey(dependency: PatchStagedForwardImport): string {
  return [dependency.file, dependency.specifier, dependency.creates, dependency.owner ?? ''].join(
    '\0'
  );
}

function dependencyLabel(dependency: PatchStagedForwardImport): string {
  const owner = dependency.owner ? ` owner=${dependency.owner}` : '';
  const reason = dependency.reason ? ` reason="${dependency.reason}"` : '';
  return `${dependency.file} imports "${dependency.specifier}" from ${dependency.creates}${owner}${reason}`;
}

function removeMatching(
  existing: readonly PatchStagedForwardImport[],
  target: PatchStagedForwardImport
): PatchStagedForwardImport[] {
  return existing.filter(
    (dependency) =>
      dependency.file !== target.file ||
      dependency.specifier !== target.specifier ||
      dependency.creates !== target.creates ||
      (target.owner !== undefined && dependency.owner !== target.owner)
  );
}

function applyMode(
  existing: readonly PatchStagedForwardImport[],
  mode: StagedDependencyMode,
  dependency: PatchStagedForwardImport | undefined
): PatchStagedForwardImport[] {
  if (mode === 'clear') return [];
  if (!dependency) return [...existing];
  if (mode === 'remove') return removeMatching(existing, dependency);

  const seen = new Set(existing.map(dependencyKey));
  if (seen.has(dependencyKey(dependency))) return [...existing];
  return [...existing, dependency];
}

/**
 * Renders a one-line summary of a staged-dependency metadata change.
 */
export function describeStagedDependencyChange(
  before: readonly PatchStagedForwardImport[],
  after: readonly PatchStagedForwardImport[],
  mode: StagedDependencyMode,
  dependency: PatchStagedForwardImport | undefined
): string {
  if (mode === 'clear') {
    return before.length === 0
      ? 'stagedDependencies was already empty — no change'
      : `cleared ${before.length} staged forward-import declaration(s)`;
  }
  if (!dependency) return 'stagedDependencies unchanged';
  if (mode === 'add') {
    return after.length === before.length
      ? `staged forward-import already present: ${dependencyLabel(dependency)}`
      : `added staged forward-import: ${dependencyLabel(dependency)}`;
  }
  return after.length === before.length
    ? `no staged forward-import matched: ${dependencyLabel(dependency)}`
    : `removed ${before.length - after.length} staged forward-import declaration(s): ${dependencyLabel(dependency)}`;
}

/**
 * Runs the metadata-only staged-dependency mutation command.
 *
 * @param projectRoot - Project root directory
 * @param identifier - Patch filename, ordinal, or manifest name
 * @param options - Mutation mode and forward-import fields
 */
export async function patchStagedDependencyCommand(
  projectRoot: string,
  identifier: string,
  options: PatchStagedDependencyOptions = {}
): Promise<void> {
  const isDryRun = options.dryRun === true;
  intro(
    isDryRun ? 'FireForge patch staged-dependency (dry run)' : 'FireForge patch staged-dependency'
  );

  const mode = modeFromOptions(options);
  const dependency = mode === 'clear' ? undefined : requireForwardImportOptions(options, mode);

  const paths = getProjectPaths(projectRoot);
  if (!(await pathExists(paths.patches))) {
    throw new GeneralError('Patches directory not found.');
  }

  const manifest = await loadPatchesManifest(paths.patches);
  if (!manifest || manifest.patches.length === 0) {
    throw new GeneralError('No patches in manifest.');
  }

  const target = resolvePatchIdentifier(identifier, manifest.patches);
  if (!target) {
    throw new InvalidArgumentError(
      formatPatchNotFoundError(identifier, manifest.patches),
      identifier
    );
  }

  const existing = target.stagedDependencies?.forwardImports ?? [];
  const projected = applyMode(existing, mode, dependency);
  const summary = describeStagedDependencyChange(existing, projected, mode, dependency);

  if (isDryRun) {
    info(`[dry-run] ${target.filename}: ${summary}.`);
    outro('Dry run complete — no changes made');
    return;
  }

  const result = await mutatePatchMetadata(paths.patches, target.filename, (current) => {
    const before = current.stagedDependencies?.forwardImports ?? [];
    const after = applyMode(before, mode, dependency);
    if (after.length === 0) return { unset: ['stagedDependencies'] };
    return { set: { stagedDependencies: { forwardImports: after } } };
  });

  if (!result) {
    throw new GeneralError(
      `Patch ${target.filename} disappeared from the manifest during the update. Re-run after investigating.`
    );
  }

  const before = result.before.stagedDependencies?.forwardImports ?? [];
  const after = result.after.stagedDependencies?.forwardImports ?? [];
  info(`${target.filename}: ${describeStagedDependencyChange(before, after, mode, dependency)}.`);

  try {
    await appendHistory(paths.patches, {
      operation: 'patch-staged-dependency',
      args: {
        filename: target.filename,
        mode,
        before,
        after,
      },
      ...(options.yes === true ? { yes: true } : {}),
      result: 'ok',
    });
  } catch (historyError: unknown) {
    warn(
      `History log append failed after patch staged-dependency committed (${target.filename}): ${toError(historyError).message}`
    );
  }

  outro('Patch staged-dependency complete');
}

/**
 * Registers the `patch staged-dependency` subcommand.
 *
 * @param parent - Parent `patch` command
 * @param context - Shared CLI registration context
 */
export function registerPatchStagedDependency(parent: Command, context: CommandContext): void {
  const { getProjectRoot, withErrorHandling } = context;
  parent
    .command('staged-dependency <name>')
    .description(
      'Edit PatchMetadata.stagedDependencies on a single patch (no .patch body rewrite).'
    )
    .option('--add', 'Add a staged forward-import declaration')
    .option('--remove', 'Remove matching staged forward-import declaration(s)')
    .option('--clear', 'Drop the stagedDependencies field entirely')
    .option('--file <path>', 'Importing file path relative to engine/')
    .option('--specifier <specifier>', 'Exact import specifier as it appears in source')
    .option('--creates <path>', 'Later-created file path relative to engine/')
    .option('--owner <patch>', 'Exact later patch filename expected to create --creates')
    .option('--reason <text>', 'Human-readable rationale stored with the declaration')
    .option('--dry-run', 'Show what would change without writing')
    .option('-y, --yes', 'Skip confirmation prompt (required for non-TTY)')
    .action(
      withErrorHandling(
        async (
          name: string,
          options: {
            add?: boolean;
            remove?: boolean;
            clear?: boolean;
            file?: string;
            specifier?: string;
            creates?: string;
            owner?: string;
            reason?: string;
            dryRun?: boolean;
            yes?: boolean;
          }
        ) => {
          await patchStagedDependencyCommand(getProjectRoot(), name, options);
        }
      )
    );
}
