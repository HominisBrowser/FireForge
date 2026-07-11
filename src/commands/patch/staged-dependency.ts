// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge patch staged-dependency <name>` — edits
 * PatchMetadata.stagedDependencies without rewriting the .patch body.
 */

import { Command } from 'commander';

import { appendHistory } from '../../core/destructive.js';
import { mutatePatchMetadata } from '../../core/patch-export.js';
import { GeneralError, InvalidArgumentError } from '../../errors/base.js';
import type { CommandContext } from '../../types/cli.js';
import type {
  PatchStagedDependencies,
  PatchStagedDependencyOptions,
  PatchStagedForwardImport,
  PatchStagedRegistration,
} from '../../types/commands/index.js';
import { toError } from '../../utils/errors.js';
import { info, intro, outro, warn } from '../../utils/logger.js';
import { requirePatchQueue, requirePatchTarget } from './patch-context.js';

type StagedDependencyMode = 'add' | 'remove' | 'clear';
type StagedDependencyKind = 'import' | 'registration';

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

function kindFromOptions(options: PatchStagedDependencyOptions): StagedDependencyKind {
  const kind = options.kind ?? 'import';
  if (kind !== 'import' && kind !== 'registration') {
    throw new InvalidArgumentError(
      `--kind must be "import" or "registration" (got "${kind}").`,
      'patch staged-dependency'
    );
  }
  if (kind === 'import' && options.line !== undefined) {
    throw new InvalidArgumentError(
      '--line only applies to --kind registration; import declarations use --specifier.',
      'patch staged-dependency'
    );
  }
  if (kind === 'registration' && options.specifier !== undefined) {
    throw new InvalidArgumentError(
      '--specifier only applies to --kind import; registration declarations use --line.',
      'patch staged-dependency'
    );
  }
  return kind;
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

function requireRegistrationOptions(
  options: PatchStagedDependencyOptions,
  mode: Exclude<StagedDependencyMode, 'clear'>
): PatchStagedRegistration {
  if (!options.file || !options.line || !options.creates) {
    throw new InvalidArgumentError(
      `--${mode} --kind registration requires --file, --line, and --creates.`,
      'patch staged-dependency'
    );
  }
  const dependency: PatchStagedRegistration = {
    file: options.file,
    line: options.line,
    creates: options.creates,
  };
  if (options.owner !== undefined) dependency.owner = options.owner;
  if (options.reason !== undefined) dependency.reason = options.reason;
  return dependency;
}

/**
 * One staged-dependency entry of either kind. The `matcher` field is the
 * kind-specific middle term: the import specifier for import entries, the
 * registration line for registration entries. Key/removal/label logic is
 * shared across kinds through this shape.
 */
interface StagedEntryView {
  file: string;
  matcher: string;
  creates: string;
  owner?: string;
  reason?: string;
}

function importView(dependency: PatchStagedForwardImport): StagedEntryView {
  return { ...dependency, matcher: dependency.specifier };
}

function registrationView(dependency: PatchStagedRegistration): StagedEntryView {
  return { ...dependency, matcher: dependency.line };
}

function dependencyKey(view: StagedEntryView): string {
  return [view.file, view.matcher, view.creates, view.owner ?? ''].join('\0');
}

function dependencyLabel(kind: StagedDependencyKind, view: StagedEntryView): string {
  const owner = view.owner ? ` owner=${view.owner}` : '';
  const reason = view.reason ? ` reason="${view.reason}"` : '';
  if (kind === 'import') {
    return `${view.file} imports "${view.matcher}" from ${view.creates}${owner}${reason}`;
  }
  return `${view.file} registers "${view.matcher}" for ${view.creates}${owner}${reason}`;
}

function matchesTarget(view: StagedEntryView, target: StagedEntryView): boolean {
  return (
    view.file === target.file &&
    view.matcher === target.matcher &&
    view.creates === target.creates &&
    (target.owner === undefined || view.owner === target.owner)
  );
}

function applyMode<T>(
  existing: readonly T[],
  mode: StagedDependencyMode,
  target: StagedEntryView | undefined,
  toView: (entry: T) => StagedEntryView,
  addition: T | undefined
): T[] {
  if (mode === 'clear') return [];
  if (!target) return [...existing];
  if (mode === 'remove') return existing.filter((entry) => !matchesTarget(toView(entry), target));

  const seen = new Set(existing.map((entry) => dependencyKey(toView(entry))));
  if (seen.has(dependencyKey(target)) || addition === undefined) return [...existing];
  return [...existing, addition];
}

/**
 * Renders a one-line summary of a staged-dependency metadata change.
 */
function describeStagedDependencyChange(
  beforeCount: number,
  afterCount: number,
  mode: StagedDependencyMode,
  kind: StagedDependencyKind,
  target: StagedEntryView | undefined
): string {
  const noun = kind === 'import' ? 'staged forward-import' : 'staged registration';
  if (mode === 'clear') {
    return beforeCount === 0
      ? 'stagedDependencies was already empty — no change'
      : `cleared ${beforeCount} staged dependency declaration(s)`;
  }
  if (!target) return 'stagedDependencies unchanged';
  if (mode === 'add') {
    return afterCount === beforeCount
      ? `${noun} already present: ${dependencyLabel(kind, target)}`
      : `added ${noun}: ${dependencyLabel(kind, target)}`;
  }
  return afterCount === beforeCount
    ? `no ${noun} matched: ${dependencyLabel(kind, target)}`
    : `removed ${beforeCount - afterCount} ${noun} declaration(s): ${dependencyLabel(kind, target)}`;
}

function countStagedEntries(staged: PatchStagedDependencies | undefined): number {
  return (staged?.forwardImports?.length ?? 0) + (staged?.registrations?.length ?? 0);
}

/**
 * Runs the metadata-only staged-dependency mutation command.
 *
 * @param projectRoot - Project root directory
 * @param identifier - Patch filename, ordinal, or manifest name
 * @param options - Mutation mode, entry kind, and declaration fields
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
  const kind = kindFromOptions(options);
  const importDependency =
    mode === 'clear' || kind !== 'import' ? undefined : requireForwardImportOptions(options, mode);
  const registrationDependency =
    mode === 'clear' || kind !== 'registration'
      ? undefined
      : requireRegistrationOptions(options, mode);
  const target =
    importDependency !== undefined
      ? importView(importDependency)
      : registrationDependency !== undefined
        ? registrationView(registrationDependency)
        : undefined;

  const { paths, manifest } = await requirePatchQueue(projectRoot);
  const targetPatch = requirePatchTarget(identifier, manifest.patches);

  const applyToStaged = (staged: PatchStagedDependencies | undefined): PatchStagedDependencies => {
    if (mode === 'clear') return {};
    const forwardImports = applyMode(
      staged?.forwardImports ?? [],
      kind === 'import' ? mode : 'add',
      kind === 'import' ? target : undefined,
      importView,
      importDependency
    );
    const registrations = applyMode(
      staged?.registrations ?? [],
      kind === 'registration' ? mode : 'add',
      kind === 'registration' ? target : undefined,
      registrationView,
      registrationDependency
    );
    return {
      ...(forwardImports.length > 0 ? { forwardImports } : {}),
      ...(registrations.length > 0 ? { registrations } : {}),
    };
  };

  const existing = targetPatch.stagedDependencies;
  const projected = applyToStaged(existing);
  const summary = describeStagedDependencyChange(
    countStagedEntries(existing),
    countStagedEntries(projected),
    mode,
    kind,
    target
  );

  if (isDryRun) {
    info(`[dry-run] ${targetPatch.filename}: ${summary}.`);
    outro('Dry run complete — no changes made');
    return;
  }

  const result = await mutatePatchMetadata(paths.patches, targetPatch.filename, (current) => {
    const after = applyToStaged(current.stagedDependencies);
    if (countStagedEntries(after) === 0) return { unset: ['stagedDependencies'] };
    return { set: { stagedDependencies: after } };
  });

  if (!result) {
    throw new GeneralError(
      `Patch ${targetPatch.filename} disappeared from the manifest during the update. Re-run after investigating.`
    );
  }

  const before = result.before.stagedDependencies;
  const after = result.after.stagedDependencies;
  info(
    `${targetPatch.filename}: ${describeStagedDependencyChange(
      countStagedEntries(before),
      countStagedEntries(after),
      mode,
      kind,
      target
    )}.`
  );

  try {
    await appendHistory(paths.patches, {
      operation: 'patch-staged-dependency',
      args: {
        filename: targetPatch.filename,
        mode,
        kind,
        before: before ?? {},
        after: after ?? {},
      },
      ...(options.yes === true ? { yes: true } : {}),
      result: 'ok',
    });
  } catch (historyError: unknown) {
    warn(
      `History log append failed after patch staged-dependency committed (${targetPatch.filename}): ${toError(historyError).message}`
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
    .option('--add', 'Add a staged dependency declaration')
    .option('--remove', 'Remove matching staged dependency declaration(s)')
    .option('--clear', 'Drop the stagedDependencies field entirely')
    .option(
      '--kind <kind>',
      'Declaration shape: "import" (forward import, the default) or "registration" (jar.mn packaging line, customElements or actor registration)'
    )
    .option('--file <path>', 'Declaring file path relative to engine/')
    .option(
      '--specifier <specifier>',
      'Exact import specifier as it appears in source (--kind import)'
    )
    .option(
      '--line <text>',
      'Registration/packaging line as the patch adds it, compared whitespace-trimmed (--kind registration)'
    )
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
            kind?: string;
            file?: string;
            specifier?: string;
            line?: string;
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
