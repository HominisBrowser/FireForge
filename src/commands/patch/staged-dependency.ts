// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge patch staged-dependency <name>` — edits
 * PatchMetadata.stagedDependencies without rewriting the .patch body.
 */

import { Command } from 'commander';

import { appendHistoryBestEffort } from '../../core/history-log.js';
import { mutatePatchMetadata } from '../../core/patch-export.js';
import { GeneralError, InvalidArgumentError } from '../../errors/base.js';
import type { CommandContext } from '../../types/cli.js';
import type {
  PatchStagedDependencies,
  PatchStagedDependencyOptions,
  PatchStagedForwardImport,
  PatchStagedRegistration,
} from '../../types/commands/index.js';
import { info, intro, outro } from '../../utils/logger.js';
import { addWaitLockOption, resolveWaitLockSeconds } from '../../utils/options.js';
import { requirePatchQueue, requirePatchTarget } from './patch-context.js';
import { validateStagedDependencyAdd } from './staged-dependency-validate.js';

type StagedDependencyMode = 'add' | 'remove' | 'clear';
type StagedDependencyKind = 'import' | 'registration';

/** Joins the names of the missing flags for error attribution. */
function missingFlagList(pairs: readonly (readonly [string, unknown])[]): string {
  return pairs
    .filter(([, value]) => value === undefined || value === '')
    .map(([flag]) => flag)
    .join(', ');
}

function modeFromOptions(options: PatchStagedDependencyOptions): StagedDependencyMode {
  const adding = options.add === true;
  const removing = options.remove === true;
  const clearing = options.clear === true;
  const modeCount = [adding, removing, clearing].filter(Boolean).length;
  if (modeCount > 1) {
    throw new InvalidArgumentError(
      '--add, --remove, and --clear are mutually exclusive. Pick one mode per invocation.',
      '--add/--remove/--clear'
    );
  }
  if (modeCount === 0) {
    throw new InvalidArgumentError(
      'Specify --add, --remove, or --clear.',
      '--add/--remove/--clear'
    );
  }
  return adding ? 'add' : removing ? 'remove' : 'clear';
}

function kindFromOptions(options: PatchStagedDependencyOptions): StagedDependencyKind {
  const kind = options.kind ?? 'import';
  if (kind !== 'import' && kind !== 'registration') {
    throw new InvalidArgumentError(
      `--kind must be "import" or "registration" (got "${kind}").`,
      '--kind'
    );
  }
  if (kind === 'import' && options.line !== undefined) {
    throw new InvalidArgumentError(
      '--line only applies to --kind registration; import declarations use --specifier.',
      '--line'
    );
  }
  if (kind === 'registration' && options.specifier !== undefined) {
    throw new InvalidArgumentError(
      '--specifier only applies to --kind import; registration declarations use --line.',
      '--specifier'
    );
  }
  return kind;
}

function requireForwardImportOptions(
  options: PatchStagedDependencyOptions
): PatchStagedForwardImport {
  if (!options.file || !options.specifier || !options.creates) {
    throw new InvalidArgumentError(
      '--add requires --file, --specifier, and --creates.',
      missingFlagList([
        ['--file', options.file],
        ['--specifier', options.specifier],
        ['--creates', options.creates],
      ])
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
  options: PatchStagedDependencyOptions
): PatchStagedRegistration {
  if (!options.file || !options.line || !options.creates) {
    throw new InvalidArgumentError(
      '--add --kind registration requires --file, --line, and --creates.',
      missingFlagList([
        ['--file', options.file],
        ['--line', options.line],
        ['--creates', options.creates],
      ])
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
 * Resolves the `--remove` target for forward-imports:
 * `--file` + `--specifier` suffice when they identify at most one staged
 * entry — `--creates` is inferred from a unique match, an ambiguous match
 * refuses with the candidate list, and no match falls through to the
 * honest "no staged forward-import matched" summary.
 */
function resolveImportRemovalTarget(
  options: PatchStagedDependencyOptions,
  staged: PatchStagedDependencies | undefined
): PatchStagedForwardImport {
  if (!options.file || !options.specifier) {
    throw new InvalidArgumentError(
      '--remove requires --file and --specifier; --creates is only needed to disambiguate when several staged entries share them.',
      missingFlagList([
        ['--file', options.file],
        ['--specifier', options.specifier],
      ])
    );
  }
  if (options.creates) {
    return requireForwardImportOptions(options);
  }
  const { file, specifier } = options;
  const candidates = (staged?.forwardImports ?? []).filter(
    (entry) =>
      entry.file === file &&
      entry.specifier === specifier &&
      (options.owner === undefined || entry.owner === options.owner)
  );
  const single = candidates.length === 1 ? candidates[0] : undefined;
  if (single !== undefined) {
    info(`Inferred --creates ${single.creates} from the single matching staged entry.`);
    return { ...single };
  }
  if (candidates.length > 1) {
    const list = candidates
      .map((entry) => `  - ${dependencyLabel('import', importView(entry))}`)
      .join('\n');
    throw new GeneralError(
      `--remove matches ${candidates.length} staged forward-imports on this patch; ` +
        `pass --creates to pick one:\n${list}`
    );
  }
  return { file, specifier, creates: '(no match)' };
}

/** Registration twin of {@link resolveImportRemovalTarget}, keyed on `--line`. */
function resolveRegistrationRemovalTarget(
  options: PatchStagedDependencyOptions,
  staged: PatchStagedDependencies | undefined
): PatchStagedRegistration {
  if (!options.file || !options.line) {
    throw new InvalidArgumentError(
      '--remove --kind registration requires --file and --line; --creates is only needed to disambiguate when several staged entries share them.',
      missingFlagList([
        ['--file', options.file],
        ['--line', options.line],
      ])
    );
  }
  if (options.creates) {
    return requireRegistrationOptions(options);
  }
  const { file, line } = options;
  const candidates = (staged?.registrations ?? []).filter(
    (entry) =>
      entry.file === file &&
      entry.line === line &&
      (options.owner === undefined || entry.owner === options.owner)
  );
  const single = candidates.length === 1 ? candidates[0] : undefined;
  if (single !== undefined) {
    info(`Inferred --creates ${single.creates} from the single matching staged entry.`);
    return { ...single };
  }
  if (candidates.length > 1) {
    const list = candidates
      .map((entry) => `  - ${dependencyLabel('registration', registrationView(entry))}`)
      .join('\n');
    throw new GeneralError(
      `--remove matches ${candidates.length} staged registrations on this patch; ` +
        `pass --creates to pick one:\n${list}`
    );
  }
  return { file, line, creates: '(no match)' };
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

  // The patch queue loads BEFORE the declaration fields resolve so
  // `--remove` can infer `--creates` from the target patch's staged
  // entries.
  const { paths, manifest } = await requirePatchQueue(projectRoot);
  const targetPatch = requirePatchTarget(identifier, manifest.patches);

  const importDependency =
    mode === 'clear' || kind !== 'import'
      ? undefined
      : mode === 'add'
        ? requireForwardImportOptions(options)
        : resolveImportRemovalTarget(options, targetPatch.stagedDependencies);
  const registrationDependency =
    mode === 'clear' || kind !== 'registration'
      ? undefined
      : mode === 'add'
        ? requireRegistrationOptions(options)
        : resolveRegistrationRemovalTarget(options, targetPatch.stagedDependencies);
  // Shape-check --add declarations against the loaded queue:
  // a patch-name-shaped --creates/--file is refused HERE instead of
  // surfacing later as an undischargeable staged-dependency-unused.
  if (mode === 'add') {
    const added = importDependency ?? registrationDependency;
    if (added !== undefined) {
      validateStagedDependencyAdd(added, manifest.patches);
    }
  }
  const target =
    importDependency !== undefined
      ? importView(importDependency)
      : registrationDependency !== undefined
        ? registrationView(registrationDependency)
        : undefined;

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

  const result = await mutatePatchMetadata(
    paths.patches,
    targetPatch.filename,
    (current) => {
      const after = applyToStaged(current.stagedDependencies);
      if (countStagedEntries(after) === 0) return { unset: ['stagedDependencies'] };
      return { set: { stagedDependencies: after } };
    },
    {
      waitLockSeconds: resolveWaitLockSeconds(options.waitLock),
      command: 'patch staged-dependency',
    }
  );

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

  await appendHistoryBestEffort(
    paths.patches,
    {
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
    },
    `patch staged-dependency committed (${targetPatch.filename})`
  );

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
  const command = parent
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
    .option(
      '-y, --yes',
      'Record scripted consent in the destructive-operation history log. This command never prompts; the flag exists for workflow uniformity with commands that do.'
    );
  addWaitLockOption(command).action(
    withErrorHandling(async (name: string, options: PatchStagedDependencyOptions) => {
      await patchStagedDependencyCommand(getProjectRoot(), name, options);
    })
  );
}
