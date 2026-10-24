// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge patch staged-dependency <name>` edits
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
import { stagedDependencyDelta } from './staged-dependency-batch.js';
import {
  applyMode,
  countReasonUpdates,
  countStagedEntries,
  dependencyLabel,
  importView,
  registrationView,
  type StagedDependencyKind,
  type StagedDependencyMode,
  type StagedEntryView,
} from './staged-dependency-entries.js';
import { runBatchAdd } from './staged-dependency-from.js';
import {
  declarationNoun,
  inferRemovalKinds,
  type KindedEntryView,
  selectRemovalEntries,
} from './staged-dependency-remove.js';
import { validateStagedDependencyAdd } from './staged-dependency-validate.js';

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
 * Renders a one-line summary of a staged-dependency metadata change.
 */
function describeStagedDependencyChange(
  before: PatchStagedDependencies | undefined,
  after: PatchStagedDependencies | undefined,
  mode: StagedDependencyMode,
  kinds: readonly StagedDependencyKind[],
  targets: readonly KindedEntryView[]
): string {
  const beforeCount = countStagedEntries(before);
  const afterCount = countStagedEntries(after);
  const targetKinds = [...new Set(targets.map((target) => target.kind))];
  const noun = declarationNoun(targetKinds.length > 0 ? targetKinds : kinds);
  if (mode === 'clear') {
    return beforeCount === 0
      ? 'stagedDependencies was already empty — no change'
      : `cleared ${beforeCount} staged dependency declaration(s)`;
  }
  const label = targets.map(({ kind, view }) => dependencyLabel(kind, view)).join('; ');
  if (targets.length === 0) return 'stagedDependencies unchanged';
  if (mode === 'add') {
    if (afterCount !== beforeCount) return `added ${noun}: ${label}`;
    return countReasonUpdates(before, after) > 0
      ? `updated 1 ${noun} reason in place: ${label}`
      : `${noun} already present: ${label}`;
  }
  return afterCount === beforeCount
    ? `no ${noun} matched: ${label}`
    : `removed ${beforeCount - afterCount} ${noun} declaration(s): ${label}`;
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
  if (options.from !== undefined) {
    await runBatchAdd(projectRoot, identifier, mode, options);
    return;
  }
  // Without --kind, --remove searches the kind its matcher names, or both.
  const kinds = (mode === 'remove' ? inferRemovalKinds(options) : undefined) ?? [
    kindFromOptions(options),
  ];
  const kind = kinds.length === 1 ? kinds[0] : undefined;

  // The patch queue loads before the declaration fields resolve so
  // `--remove` can infer `--creates` from the target patch's staged
  // entries.
  const { paths, manifest } = await requirePatchQueue(projectRoot);
  const targetPatch = requirePatchTarget(identifier, manifest.patches);

  const importDependency =
    mode === 'add' && kind === 'import' ? requireForwardImportOptions(options) : undefined;
  const registrationDependency =
    mode === 'add' && kind === 'registration' ? requireRegistrationOptions(options) : undefined;
  // Shape-check --add declarations against the loaded queue: a
  // patch-name-shaped --creates/--file is refused here instead of surfacing
  // later as an undischargeable staged-dependency-unused.
  const added = importDependency ?? registrationDependency;
  if (added !== undefined) {
    validateStagedDependencyAdd(added, manifest.patches);
  }
  const targets: KindedEntryView[] =
    mode === 'remove'
      ? selectRemovalEntries(kinds, options, targetPatch.stagedDependencies)
      : importDependency !== undefined
        ? [{ kind: 'import', view: importView(importDependency) }]
        : registrationDependency !== undefined
          ? [{ kind: 'registration', view: registrationView(registrationDependency) }]
          : [];

  const applyKind = <T>(
    entries: readonly T[],
    entryKind: StagedDependencyKind,
    toView: (entry: T) => StagedEntryView,
    addition: T | undefined
  ): T[] => {
    if (!kinds.includes(entryKind)) return [...entries];
    const own = targets.filter((target) => target.kind === entryKind).map(({ view }) => view);
    if (mode !== 'remove') return applyMode(entries, mode, own[0], toView, addition);
    return own.reduce<T[]>(
      (remaining, target) => applyMode(remaining, 'remove', target, toView, undefined),
      [...entries]
    );
  };
  const applyToStaged = (staged: PatchStagedDependencies | undefined): PatchStagedDependencies => {
    if (mode === 'clear') return {};
    const forwardImports = applyKind(
      staged?.forwardImports ?? [],
      'import',
      importView,
      importDependency
    );
    const registrations = applyKind(
      staged?.registrations ?? [],
      'registration',
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
  const summary = describeStagedDependencyChange(existing, projected, mode, kinds, targets);

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
      before,
      after,
      mode,
      kinds,
      targets
    )}.`
  );
  if (mode === 'remove' && countStagedEntries(after) === countStagedEntries(before)) {
    // The selection matched when the queue was read; a peer removed the
    // entries before the locked write. Still a miss, so still a refusal.
    throw new InvalidArgumentError(
      `${targetPatch.filename}: the selected staged declaration(s) were already gone when the manifest was written.`,
      '--remove'
    );
  }

  await appendHistoryBestEffort(
    paths.patches,
    {
      operation: 'patch-staged-dependency',
      // Only the delta: the whole list on both sides grew the log
      // quadratically with the list (see staged-dependency-batch.ts).
      args: {
        filename: targetPatch.filename,
        mode,
        // A kind-less --remove searched both kinds; the delta names which.
        ...(kind !== undefined ? { kind } : {}),
        ...stagedDependencyDelta(before, after),
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
    .option(
      '--remove',
      'Remove matching staged dependency declaration(s); a selection that matches nothing exits 8'
    )
    .option('--clear', 'Drop the stagedDependencies field entirely')
    .option(
      '--kind <kind>',
      'Declaration shape: "import" (forward import, the default) or "registration" (jar.mn packaging line, customElements or actor registration); --remove without it takes the kind --specifier or --line names, or both kinds'
    )
    .option('--file <path>', 'Declaring file path relative to engine/')
    .option(
      '--specifier <specifier>',
      'Exact import specifier as it appears in source (--kind import)'
    )
    .option(
      '--line <text>',
      'Registration/packaging line as the patch adds it, compared whitespace-insensitively (--kind registration)'
    )
    .option(
      '--creates <path>',
      'Later-created file path relative to engine/ (with --remove and no --file: removes every declaration for that path)'
    )
    .option('--owner <patch>', 'Exact later patch filename expected to create --creates')
    .option(
      '--reason <text>',
      'Human-readable rationale stored with the declaration; --add on a declaration already present replaces its reason in place (with --from: the default for entries without one)'
    )
    .option(
      '--from <json-file>',
      'Add every declaration in a JSON file under one lock hold (--add only): a "lint --per-patch --report" ' +
        "document (its findings' stagedDeclarations for this patch) or an array of " +
        '{ file, specifier | line, creates, owner?, reason?, patch? } entries'
    )
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
