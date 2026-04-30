// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge patch lint-ignore <name>` — adds, removes, or clears entries
 * in `PatchMetadata.lintIgnore` without rewriting the `.patch` file body.
 *
 * Companion to `fireforge re-export <name> --lint-ignore <id>` (which is
 * append-only). Existence is justified by the cases re-export cannot
 * express:
 * - Removing a single entry without dropping the rest of the list.
 * - Clearing the entire list when the operator wants the rule(s) to
 *   start firing again.
 * - Editing metadata when the patch body is already correct, so the
 *   re-export's engine read + diff regeneration roundtrip is wasted.
 *
 * Modes are mutually exclusive: exactly one of `--add`, `--remove`, or
 * `--clear` must be supplied per invocation. The read-modify-write
 * happens inside the patch directory lock via {@link mutatePatchMetadata}
 * so a concurrent writer cannot interleave between the read and the
 * write — important when an operator scripts repeated invocations or
 * runs `--add` and `--remove` back-to-back.
 */

import { Command } from 'commander';

import { getProjectPaths } from '../../core/config.js';
import { appendHistory } from '../../core/destructive.js';
import { mutatePatchMetadata } from '../../core/patch-export.js';
import { formatPatchNotFoundError } from '../../core/patch-identifier-suggest.js';
import { loadPatchesManifest, resolvePatchIdentifier } from '../../core/patch-manifest.js';
import { GeneralError, InvalidArgumentError } from '../../errors/base.js';
import type { CommandContext } from '../../types/cli.js';
import type { PatchLintIgnoreOptions } from '../../types/commands/index.js';
import { toError } from '../../utils/errors.js';
import { pathExists } from '../../utils/fs.js';
import { info, intro, outro, warn } from '../../utils/logger.js';

type LintIgnoreMode = 'add' | 'remove' | 'clear';

/**
 * Computes the post-mutation `lintIgnore` list for a given mode.
 * Returns `undefined` when the result should drop the field from the
 * manifest entirely (matching the validator's "preserve only when
 * present" contract).
 */
function applyMode(
  existing: ReadonlyArray<string>,
  mode: LintIgnoreMode,
  values: ReadonlyArray<string>
): string[] | undefined {
  const existingSet = new Set<string>(existing);

  if (mode === 'add') {
    for (const v of values) existingSet.add(v);
    const merged = [...existingSet];
    return merged.length > 0 ? merged : undefined;
  }

  if (mode === 'remove') {
    for (const v of values) existingSet.delete(v);
    const remaining = [...existingSet];
    return remaining.length > 0 ? remaining : undefined;
  }

  // mode === 'clear'
  return undefined;
}

/**
 * Renders a one-line summary of the planned change for use in
 * `info()` / dry-run / history args. Exported for unit-testing the
 * message format directly without mocking the logger transport.
 */
export function describeChange(
  before: ReadonlyArray<string>,
  after: ReadonlyArray<string>,
  mode: LintIgnoreMode,
  values: ReadonlyArray<string>
): string {
  const beforeSet = new Set<string>(before);
  const afterSet = new Set<string>(after);
  if (mode === 'clear') {
    return before.length === 0
      ? 'lintIgnore was already empty — no change'
      : `lintIgnore cleared (was ${before.join(', ')})`;
  }
  const currentLabel = before.length > 0 ? `[${before.join(', ')}]` : '(empty)';
  if (mode === 'add') {
    const added = values.filter((v) => !beforeSet.has(v));
    if (added.length === 0) {
      // Surface the existing list so a no-op `--add` does not require a
      // follow-up `patches.json` read to confirm what was already present.
      return `lintIgnore unchanged (current: ${currentLabel}; all requested IDs already present)`;
    }
    return `lintIgnore += ${added.join(', ')} → ${[...afterSet].join(', ') || '(empty)'}`;
  }
  // mode === 'remove'
  const removed = values.filter((v) => beforeSet.has(v));
  if (removed.length === 0) {
    return `lintIgnore unchanged (current: ${currentLabel}; none of the requested IDs were present)`;
  }
  return `lintIgnore −= ${removed.join(', ')} → ${[...afterSet].join(', ') || '(empty)'}`;
}

/**
 * Runs the `patch lint-ignore` command: reads the patch's existing
 * `lintIgnore`, applies the requested mode, and writes the manifest.
 *
 * @param projectRoot - Project root directory
 * @param identifier - Patch filename, ordinal, or manifest `name`
 * @param options - Command options (exactly one of `add`/`remove`/`clear`)
 */
export async function patchLintIgnoreCommand(
  projectRoot: string,
  identifier: string,
  options: PatchLintIgnoreOptions = {}
): Promise<void> {
  const isDryRun = options.dryRun === true;
  intro(isDryRun ? 'FireForge patch lint-ignore (dry run)' : 'FireForge patch lint-ignore');

  // Mode mutex: exactly one mode per invocation. Combinations like
  // `--add foo --remove bar` are rejected — an operator who needs both
  // runs the command twice (clearer audit trail) and `--clear` plus a
  // mode is contradictory.
  const adding = (options.add?.length ?? 0) > 0;
  const removing = (options.remove?.length ?? 0) > 0;
  const clearing = options.clear === true;
  const modeCount = [adding, removing, clearing].filter(Boolean).length;
  if (modeCount > 1) {
    throw new InvalidArgumentError(
      '--add, --remove, and --clear are mutually exclusive. Pick one mode per invocation.',
      'patch lint-ignore'
    );
  }
  if (modeCount === 0) {
    throw new InvalidArgumentError(
      'Specify --add <id>, --remove <id>, or --clear.',
      'patch lint-ignore'
    );
  }

  const mode: LintIgnoreMode = adding ? 'add' : removing ? 'remove' : 'clear';
  const values: ReadonlyArray<string> =
    mode === 'add' ? (options.add ?? []) : mode === 'remove' ? (options.remove ?? []) : [];

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

  if (isDryRun) {
    const existing = target.lintIgnore ?? [];
    const projected = applyMode(existing, mode, values) ?? [];
    info(`[dry-run] ${target.filename}: ${describeChange(existing, projected, mode, values)}.`);
    outro('Dry run complete — no changes made');
    return;
  }

  const result = await mutatePatchMetadata(paths.patches, target.filename, (existing) => {
    const next = applyMode(existing.lintIgnore ?? [], mode, values);
    // Either set the new list when non-empty or unset the field
    // entirely. The mutation API splits these to keep the
    // exactOptionalPropertyTypes contract clean — only set values land
    // in the typed `Partial<PatchMetadata>`, and the unset list is
    // applied via `delete` after spread.
    return next !== undefined ? { set: { lintIgnore: next } } : { unset: ['lintIgnore'] };
  });

  if (!result) {
    // Race: target vanished between the manifest read above and the
    // locked mutate. Surfacing as a hard error rather than a silent
    // no-op — the operator's intent did not land.
    throw new GeneralError(
      `Patch ${target.filename} disappeared from the manifest during the update. Re-run after investigating.`
    );
  }

  const existing = result.before.lintIgnore ?? [];
  const projected = result.after.lintIgnore ?? [];
  info(`${target.filename}: ${describeChange(existing, projected, mode, values)}.`);

  try {
    await appendHistory(paths.patches, {
      operation: 'patch-lint-ignore',
      args: {
        filename: target.filename,
        mode,
        values: [...values],
        before: existing,
        after: projected,
      },
      ...(options.yes === true ? { yes: true } : {}),
      result: 'ok',
    });
  } catch (historyError: unknown) {
    warn(
      `History log append failed after patch lint-ignore committed (${target.filename}): ${toError(historyError).message}`
    );
  }

  outro('Patch lint-ignore complete');
}

/**
 * Registers the `patch lint-ignore` subcommand on the `patch` parent.
 *
 * @param parent - Parent Commander command
 * @param context - Shared CLI registration context
 */
export function registerPatchLintIgnore(parent: Command, context: CommandContext): void {
  const { getProjectRoot, withErrorHandling } = context;
  parent
    .command('lint-ignore <name>')
    .description(
      'Edit PatchMetadata.lintIgnore on a single patch (no .patch body rewrite). One mode per invocation.'
    )
    .option(
      '--add <check-id>',
      'Lint check ID to add to the patch lintIgnore list (repeatable)',
      (value: string, prev: string[]) => [...prev, value],
      [] as string[]
    )
    .option(
      '--remove <check-id>',
      'Lint check ID to remove from the patch lintIgnore list (repeatable)',
      (value: string, prev: string[]) => [...prev, value],
      [] as string[]
    )
    .option('--clear', 'Drop the lintIgnore field entirely')
    .option('--dry-run', 'Show what would change without writing')
    .option('-y, --yes', 'Skip confirmation prompt (required for non-TTY)')
    .action(
      withErrorHandling(
        async (
          name: string,
          options: {
            add?: string[];
            remove?: string[];
            clear?: boolean;
            dryRun?: boolean;
            yes?: boolean;
          }
        ) => {
          // Commander defaults `--add`/`--remove` to `[]` so they appear in
          // the options object even when unused. Strip empty arrays so
          // `pickDefined` sees them as absent — otherwise the mode-count
          // mutex would treat zero-length arrays as a present mode.
          const normalized: PatchLintIgnoreOptions = {};
          if (options.add !== undefined && options.add.length > 0) normalized.add = options.add;
          if (options.remove !== undefined && options.remove.length > 0)
            normalized.remove = options.remove;
          if (options.clear === true) normalized.clear = true;
          if (options.dryRun === true) normalized.dryRun = true;
          if (options.yes === true) normalized.yes = true;
          await patchLintIgnoreCommand(getProjectRoot(), name, normalized);
        }
      )
    );
}
