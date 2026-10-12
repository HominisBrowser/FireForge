// SPDX-License-Identifier: EUPL-1.2
/**
 * `patch staged-dependency --add --from <json-file>`: adds every
 * declaration a file supplies for one patch in a single manifest update
 * under one lock hold. The file format and the history delta live in
 * `staged-dependency-batch.ts`.
 */

import { appendHistoryBestEffort } from '../../core/history-log.js';
import { mutatePatchMetadata } from '../../core/patch-export.js';
import { GeneralError, InvalidArgumentError } from '../../errors/base.js';
import type {
  PatchStagedDependencies,
  PatchStagedDependencyOptions,
} from '../../types/commands/index.js';
import { info, outro } from '../../utils/logger.js';
import { resolveWaitLockSeconds } from '../../utils/options.js';
import { requirePatchQueue, requirePatchTarget } from './patch-context.js';
import {
  readStagedDependencyBatch,
  type StagedDependencyBatch,
  stagedDependencyDelta,
} from './staged-dependency-batch.js';
import {
  applyMode,
  countStagedEntries,
  importView,
  registrationView,
  type StagedDependencyMode,
} from './staged-dependency-entries.js';
import { validateStagedDependencyAdd } from './staged-dependency-validate.js';

/** Flags that describe one declaration and so cannot combine with `--from`. */
const SINGLE_DECLARATION_FLAGS = [
  ['--kind', 'kind'],
  ['--file', 'file'],
  ['--specifier', 'specifier'],
  ['--line', 'line'],
  ['--creates', 'creates'],
  ['--owner', 'owner'],
] as const;

/** Adds every `--from` declaration not already present, keyed like a single `--add`. */
function mergeBatch(
  staged: PatchStagedDependencies | undefined,
  batch: StagedDependencyBatch
): PatchStagedDependencies {
  let forwardImports = [...(staged?.forwardImports ?? [])];
  for (const entry of batch.forwardImports) {
    forwardImports = applyMode(forwardImports, 'add', importView(entry), importView, entry);
  }
  let registrations = [...(staged?.registrations ?? [])];
  for (const entry of batch.registrations) {
    registrations = applyMode(
      registrations,
      'add',
      registrationView(entry),
      registrationView,
      entry
    );
  }
  return {
    ...(forwardImports.length > 0 ? { forwardImports } : {}),
    ...(registrations.length > 0 ? { registrations } : {}),
  };
}

/**
 * `--add --from <json-file>`: every declaration the file supplies for the
 * target patch, validated up front and written in one manifest update
 * under one lock hold, with one delta history record.
 */
export async function runBatchAdd(
  projectRoot: string,
  identifier: string,
  mode: StagedDependencyMode,
  options: PatchStagedDependencyOptions
): Promise<void> {
  const from = options.from ?? '';
  if (mode !== 'add') {
    throw new InvalidArgumentError('--from only applies to --add.', '--from');
  }
  const clashing = SINGLE_DECLARATION_FLAGS.filter(([, key]) => options[key] !== undefined);
  if (clashing.length > 0) {
    throw new InvalidArgumentError(
      `--from supplies the declarations itself; drop ${clashing.map(([flag]) => flag).join(', ')}.`,
      '--from'
    );
  }

  const { paths, manifest } = await requirePatchQueue(projectRoot);
  const targetPatch = requirePatchTarget(identifier, manifest.patches);
  const batch = await readStagedDependencyBatch(from, targetPatch.filename, options.reason);
  for (const entry of [...batch.forwardImports, ...batch.registrations]) {
    validateStagedDependencyAdd(entry, manifest.patches);
  }
  const supplied = batch.forwardImports.length + batch.registrations.length;
  if (batch.skippedForOtherPatches > 0) {
    info(
      `Skipped ${batch.skippedForOtherPatches} declaration(s) in ${from} that name another patch.`
    );
  }
  if (supplied === 0) {
    info(`${from} holds no declarations for ${targetPatch.filename}; nothing to add.`);
    outro('Patch staged-dependency complete');
    return;
  }

  const existing = targetPatch.stagedDependencies;
  const projectedCount = countStagedEntries(mergeBatch(existing, batch));
  const describe = (beforeCount: number, afterCount: number): string =>
    `added ${afterCount - beforeCount} of ${supplied} staged declaration(s) from ${from}` +
    (supplied > afterCount - beforeCount
      ? ` (${supplied - (afterCount - beforeCount)} already present or repeated)`
      : '');

  if (options.dryRun === true) {
    info(
      `[dry-run] ${targetPatch.filename}: ${describe(countStagedEntries(existing), projectedCount)}.`
    );
    outro('Dry run complete — no changes made');
    return;
  }

  const result = await mutatePatchMetadata(
    paths.patches,
    targetPatch.filename,
    (current) => {
      const after = mergeBatch(current.stagedDependencies, batch);
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
    `${targetPatch.filename}: ${describe(countStagedEntries(before), countStagedEntries(after))}.`
  );

  await appendHistoryBestEffort(
    paths.patches,
    {
      operation: 'patch-staged-dependency',
      args: {
        filename: targetPatch.filename,
        mode,
        from,
        ...stagedDependencyDelta(before, after),
      },
      ...(options.yes === true ? { yes: true } : {}),
      result: 'ok',
    },
    `patch staged-dependency committed (${targetPatch.filename})`
  );
  outro('Patch staged-dependency complete');
}
