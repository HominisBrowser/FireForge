// SPDX-License-Identifier: EUPL-1.2
/**
 * Transactional file-ownership move into an existing patch.
 *
 * A preview-only `patch move-files <from> <to>` prints two
 * `re-export --files` commands whose real execution costs three further
 * refusals (`--allow-shrink`, `--yes`, and a projected
 * `duplicate-new-file-creation` unless the shrink lands first, while the
 * printed plan lists the grow first). This module performs the same
 * shrink→grow as one transaction under the patch-directory lock with
 * rollback, mirroring `patch split` / `move-files --create`.
 *
 * Preconditions match `re-export`: the engine worktree must currently
 * reflect both patches' content, because both bodies are regenerated from
 * the worktree.
 *
 * The same transaction can also adopt new, unowned engine files
 * into the target (`--scan-file`, see move-files-adopt.ts) and fold the
 * whole source into the target, retiring its slot (`--retire-empty`, see
 * move-files-retire.ts).
 */

import { dirname, join, resolve } from 'node:path';

import {
  assertConfirmationAvailable,
  confirmDestructive,
  type ConflictReport,
} from '../../core/destructive.js';
import { appendHistoryBestEffort } from '../../core/history-log.js';
import {
  buildPatchQueueContext,
  collectForwardImportEdges,
  formatPatchLintIssue,
  lintPatchQueue,
  type PatchQueueEntry,
} from '../../core/patch-lint.js';
import type { PatchQueueContext } from '../../core/patch-lint-cross.js';
import { buildLintIgnoreChecks } from '../../core/patch-lint-ignore.js';
import { computeProjectedLintRegressions } from '../../core/patch-lint-projection.js';
import { withPatchDirectoryLock } from '../../core/patch-lock.js';
import {
  loadPatchesManifest,
  savePatchesManifest,
  validatePatchesManifest,
} from '../../core/patch-manifest.js';
import { removePatchFileAndManifest } from '../../core/patch-manifest.js';
import { GeneralError, InvalidArgumentError } from '../../errors/base.js';
import type {
  PatchLintIssue,
  PatchMetadata,
  PatchMoveFilesOptions,
  PatchStagedForwardImport,
} from '../../types/commands/index.js';
import type { FireForgeConfig } from '../../types/config.js';
import { toError } from '../../utils/errors.js';
import { pathExists, readText, writeText } from '../../utils/fs.js';
import { info, outro, success, warn } from '../../utils/logger.js';
import { resolveWaitLockSeconds } from '../../utils/options.js';
import { withDeclarationsReport } from '../declarations-report.js';
import { proceedAfterDecision } from '../destructive-decision.js';
import { projectEntryBody } from './entry-projection.js';
import { assertAdoptedStillUnowned } from './move-files-adopt.js';
import { foldSourceRows, retiredSlotForFold } from './move-files-retire.js';
import { runMoveSideLint } from './move-size-tier.js';
import { buildSplitDiff, mergeStagedForwardImports, moveDeclarationReason } from './split-plan.js';
import { findOwnerRewriteHolders, rewriteSplitOwners } from './split-staged.js';

/** Everything the commit step needs, computed and confirmed up front. */
export interface MoveIntoPlan {
  source: PatchMetadata;
  target: PatchMetadata;
  movedFiles: string[];
  sourceAfter: string[];
  targetAfter: string[];
  sourceDiff: string;
  targetDiff: string;
  /** Patches (by filename) whose staged-dependency owners re-point to the target. */
  ownerRewrites: string[];
  /** Forward-import declarations the move introduces, keyed by importing patch. */
  stagedDependencyAdditions: Map<string, PatchStagedForwardImport[]>;
  /** New engine files no patch owned that the target adopts (`--scan-file`). */
  adoptedFiles: string[];
  /**
   * `--retire-empty`: the move empties the source, so every declaration
   * owned by the source re-points to the target and the source's slot is
   * retired. `sourceDiff` is empty then.
   */
  retireSource: boolean;
}

/**
 * Applies the manifest side of a move to its rows: owner rewrites (every
 * source-owned declaration on a fold, the moved files' otherwise), the
 * auto-declared forward imports and both `filesAffected` lists. A folded
 * source row is left as is for the retire step to remove.
 */
function applyMoveToRows(rows: readonly PatchMetadata[], plan: MoveIntoPlan): PatchMetadata[] {
  const movedSet = new Set([...plan.movedFiles, ...plan.adoptedFiles]);
  const rewritten = plan.retireSource
    ? foldSourceRows(rows, plan.source.filename, plan.target.filename).patches
    : rows.map((row) =>
        rewriteSplitOwners(row, plan.source.filename, movedSet, plan.target.filename)
      );
  return rewritten.map((row) => {
    let updated = row;
    const decls = plan.stagedDependencyAdditions.get(updated.filename);
    if (decls?.length) updated = mergeStagedForwardImports(updated, decls);
    if (updated.filename === plan.source.filename && !plan.retireSource) {
      return { ...updated, filesAffected: plan.sourceAfter };
    }
    if (updated.filename === plan.target.filename) {
      return { ...updated, filesAffected: plan.targetAfter };
    }
    return updated;
  });
}

/**
 * Projects the post-move queue through cross-patch lint, auto-declaring the
 * forward edges the move introduces into the target (an importer that used
 * to live in the same patch as the moved file gains a forward edge when the
 * target is later-ordered). Reports only regressions the move itself adds.
 */
function runProjectedMoveLint(
  plan: MoveIntoPlan,
  baseCtx: PatchQueueContext
): {
  conflicts: ConflictReport | null;
  regressions: PatchLintIssue[];
  stagedDependencyAdditions: Map<string, PatchStagedForwardImport[]>;
} {
  const movedSet = new Set([...plan.movedFiles, ...plan.adoptedFiles]);
  const reason = moveDeclarationReason(
    plan.source.filename,
    plan.target.filename,
    'patch move-files'
  );

  // The projected rows go through the same rewrite the commit applies, so
  // the projection and the written manifest cannot disagree.
  const rows = baseCtx.entries.flatMap((entry) => (entry.metadata ? [entry.metadata] : []));
  const projectedRows = new Map(
    applyMoveToRows(rows, { ...plan, stagedDependencyAdditions: new Map() }).map(
      (row) => [row.filename, row] as const
    )
  );
  const entries: PatchQueueEntry[] = baseCtx.entries
    .filter((entry) => !(plan.retireSource && entry.filename === plan.source.filename))
    .map((entry) => {
      const metadata = entry.metadata ? (projectedRows.get(entry.filename) ?? null) : null;
      if (entry.filename === plan.source.filename) {
        return { ...entry, metadata, ...projectEntryBody(plan.sourceDiff) };
      }
      if (entry.filename === plan.target.filename) {
        return { ...entry, metadata, ...projectEntryBody(plan.targetDiff) };
      }
      return { ...entry, metadata };
    });

  const stagedDependencyAdditions = new Map<string, PatchStagedForwardImport[]>();
  for (const edge of collectForwardImportEdges({ entries })) {
    if (edge.owner !== plan.target.filename || !movedSet.has(edge.creates)) continue;
    const decl: PatchStagedForwardImport = {
      file: edge.sitePath,
      specifier: edge.specifier,
      creates: edge.creates,
      owner: plan.target.filename,
      reason,
    };
    const list = stagedDependencyAdditions.get(edge.entry) ?? [];
    if (
      !list.some(
        (d) => d.file === decl.file && d.specifier === decl.specifier && d.creates === decl.creates
      )
    ) {
      list.push(decl);
    }
    stagedDependencyAdditions.set(edge.entry, list);
  }
  for (const entry of entries) {
    const decls = stagedDependencyAdditions.get(entry.filename);
    if (decls?.length && entry.metadata) {
      entry.metadata = mergeStagedForwardImports(entry.metadata, decls);
    }
  }

  const baselineIssues = lintPatchQueue(baseCtx).filter((i) => i.severity === 'error');
  // Keep every queue-wide lint setting (patch policy, forward-registration
  // scope, token scales) so the projection checks what the committed gate
  // checks, test-manifest suite entries included.
  const projectedIssues = lintPatchQueue({ ...baseCtx, entries }).filter(
    (i) => i.severity === 'error'
  );
  const regressions = computeProjectedLintRegressions(baselineIssues, projectedIssues);
  if (baselineIssues.length > 0 && regressions.length === 0) {
    warn(
      `Note: projected queue still has ${baselineIssues.length} pre-existing cross-patch ` +
        'error(s) unrelated to this move. Run "fireforge verify" to list them.'
    );
  }
  const conflicts =
    regressions.length === 0
      ? null
      : {
          reason: `move would introduce ${regressions.length} cross-patch lint error(s)`,
          details: regressions.map(formatPatchLintIssue),
        };
  return { conflicts, regressions, stagedDependencyAdditions };
}

/** Restores one body during rollback, warning instead of throwing. */
async function restoreBody(path: string, body: string, label: string): Promise<void> {
  try {
    await writeText(path, body);
  } catch (rollbackError: unknown) {
    warn(`Rollback warning: could not restore ${label} body: ${toError(rollbackError).message}`);
  }
}

/**
 * Commits a confirmed move under the patch-directory lock: write both
 * rewritten bodies, then one manifest rewrite (filesAffected on both rows +
 * owner rewrites + auto-declared forward imports). Rolled back in reverse
 * order on any failure.
 */
async function commitMoveInto(
  patchesDir: string,
  plan: MoveIntoPlan,
  waitLockSeconds?: number
): Promise<void> {
  await withPatchDirectoryLock(
    patchesDir,
    async () => {
      const manifest = await loadPatchesManifest(patchesDir);
      if (!manifest) throw new GeneralError('Manifest disappeared while waiting for lock.');
      const currentSource = manifest.patches.find((p) => p.filename === plan.source.filename);
      const currentTarget = manifest.patches.find((p) => p.filename === plan.target.filename);
      if (
        !currentSource ||
        !currentTarget ||
        currentSource.filesAffected.join('\n') !== plan.source.filesAffected.join('\n') ||
        currentTarget.filesAffected.join('\n') !== plan.target.filesAffected.join('\n')
      ) {
        throw new InvalidArgumentError(
          'Patch queue changed while waiting for move confirmation. Re-run the command.',
          'patch move-files'
        );
      }

      assertAdoptedStillUnowned(manifest.patches, plan.adoptedFiles, 'patch move-files');

      const sourcePath = join(patchesDir, plan.source.filename);
      const targetPath = join(patchesDir, plan.target.filename);
      const originalSourceBody = await readText(sourcePath);
      const originalTargetBody = await readText(targetPath);
      let sourceWritten = false;
      let targetWritten = false;

      try {
        if (!plan.retireSource) {
          await writeText(sourcePath, plan.sourceDiff);
          sourceWritten = true;
        }
        await writeText(targetPath, plan.targetDiff);
        targetWritten = true;

        const updatedPatches = applyMoveToRows(manifest.patches, plan);
        const updated = validatePatchesManifest({ ...manifest, patches: updatedPatches });
        await savePatchesManifest(patchesDir, updated);
        if (plan.retireSource) {
          // Same write `patch retire` makes: the row and the .patch file
          // leave, and the order stays spent as a retired slot.
          await removePatchFileAndManifest(
            patchesDir,
            plan.source.filename,
            retiredSlotForFold(plan.source, plan.target.filename)
          );
        }

        await appendHistoryBestEffort(
          patchesDir,
          {
            operation: 'patch-move-files',
            args: {
              source: plan.source.filename,
              target: plan.target.filename,
              files: plan.movedFiles,
              ownerRewrites: plan.ownerRewrites,
              ...(plan.adoptedFiles.length > 0 ? { adoptedFiles: plan.adoptedFiles } : {}),
              ...(plan.retireSource
                ? { retiredSource: { filename: plan.source.filename, order: plan.source.order } }
                : {}),
            },
            result: 'ok',
          },
          `patch move-files committed`
        );
      } catch (error: unknown) {
        if (targetWritten) await restoreBody(targetPath, originalTargetBody, 'target');
        if (sourceWritten || !(await pathExists(sourcePath))) {
          await restoreBody(sourcePath, originalSourceBody, 'source');
        }
        try {
          await savePatchesManifest(patchesDir, manifest);
        } catch (rollbackError: unknown) {
          warn(`Rollback warning: could not restore manifest: ${toError(rollbackError).message}`);
        }
        throw error;
      }
    },
    { waitLockSeconds, command: 'patch move-files' }
  );
}

/**
 * Plans, lints, confirms, and commits a file-ownership move into an
 * existing patch. Called by `patchMoveFilesCommand` after its ownership
 * pre-checks resolved and validated both patches.
 */
export async function runMoveFilesInto(args: {
  enginePath: string;
  patchesDir: string;
  source: PatchMetadata;
  target: PatchMetadata;
  files: string[];
  sourceAfter: string[];
  /** Includes `adoptedFiles`. */
  targetAfter: string[];
  /** New, unowned engine files the target adopts (`--scan-file`). */
  adoptedFiles?: string[];
  /** The move empties the source and retires its slot (`--retire-empty`). */
  retireSource?: boolean;
  options: PatchMoveFilesOptions;
  config: FireForgeConfig;
}): Promise<void> {
  const { enginePath, patchesDir, source, target, files, sourceAfter, targetAfter, options } = args;
  const adoptedFiles = args.adoptedFiles ?? [];
  const retireSource = args.retireSource === true;

  // Refuse a prompt-less run before the diff/lint work, not after it.
  assertConfirmationAvailable('patch move-files', options);

  const sourceDiff = retireSource
    ? ''
    : await buildSplitDiff(enginePath, sourceAfter, 'remaining', source.filename);
  const targetDiff = await buildSplitDiff(enginePath, targetAfter, 'moved', target.filename);

  // Per-patch lint both projected bodies with each patch's own waivers,
  // judged on what the whole transaction leaves (adopted files land in the
  // target directly, so no patch is judged on an intermediate body). The
  // whole-queue context (built once, with the config for committed-gate
  // parity) resolves cross-patch imports and sibling head.js harness roots
  // instead of linting each projected body blind.
  const patchQueueCtx = await buildPatchQueueContext(patchesDir, args.config);
  if (!retireSource) {
    await runMoveSideLint({
      engineDir: enginePath,
      filesAffected: sourceAfter,
      filesBefore: source.filesAffected,
      role: 'source',
      diffContent: sourceDiff,
      config: args.config,
      skipLint: options.skipLint,
      patchQueueCtx,
      ignoreChecks: buildLintIgnoreChecks(source.lintIgnore),
      patchTier: source.tier,
    });
  }
  await runMoveSideLint({
    engineDir: enginePath,
    filesAffected: targetAfter,
    filesBefore: target.filesAffected,
    role: 'destination',
    diffContent: targetDiff,
    config: args.config,
    skipLint: options.skipLint,
    patchQueueCtx,
    ignoreChecks: buildLintIgnoreChecks(target.lintIgnore),
    patchTier: target.tier,
  });

  const manifest = await loadPatchesManifest(patchesDir);
  const plan: MoveIntoPlan = {
    source,
    target,
    movedFiles: files,
    sourceAfter,
    targetAfter,
    sourceDiff,
    targetDiff,
    ownerRewrites: retireSource
      ? foldSourceRows(manifest?.patches ?? [], source.filename, target.filename).repointed
      : findOwnerRewriteHolders(
          manifest?.patches ?? [],
          source.filename,
          new Set([...files, ...adoptedFiles])
        ),
    stagedDependencyAdditions: new Map(),
    adoptedFiles,
    retireSource,
  };

  const projected = runProjectedMoveLint(plan, patchQueueCtx);
  plan.stagedDependencyAdditions = projected.stagedDependencyAdditions;
  const conflicts = await withDeclarationsReport(projected.conflicts, {
    projectRoot: dirname(resolve(patchesDir)),
    regressions: projected.regressions,
    out: options.declarationsOut,
    reason: moveDeclarationReason(source.filename, target.filename, 'patch move-files'),
  });

  const decision = await confirmDestructive({
    operation: 'patch-move-files',
    title: `Move ${files.length} file(s) from ${source.filename} to ${target.filename}`,
    summary: [
      `moved files (${files.length}): ${files.join(', ')}`,
      ...(adoptedFiles.length > 0
        ? [
            `adopted from the worktree (no patch owned them) (${adoptedFiles.length}): ${adoptedFiles.join(', ')}`,
          ]
        : []),
      retireSource
        ? `${source.filename} is emptied and retired; order ${source.order} stays spent as a retired slot`
        : `${source.filename} keeps (${sourceAfter.length}): ${sourceAfter.join(', ')}`,
      `${target.filename} grows to (${targetAfter.length}): ${targetAfter.join(', ')}`,
      ...(plan.ownerRewrites.length > 0
        ? [`staged-dependency owners re-pointed in: ${plan.ownerRewrites.join(', ')}`]
        : []),
    ],
    yes: options.yes === true,
    dryRun: options.dryRun === true,
    unsafeOverride: options.forceUnsafe === true,
    conflicts,
  });
  if (!proceedAfterDecision(decision, 'Move cancelled')) return;

  await commitMoveInto(patchesDir, plan, resolveWaitLockSeconds(options.waitLock));

  success(`Moved ${files.length} file(s) from ${source.filename} to ${target.filename}`);
  if (adoptedFiles.length > 0) {
    info(`Adopted ${adoptedFiles.length} new file(s) into ${target.filename}`);
  }
  if (plan.ownerRewrites.length > 0) {
    info(`Re-pointed staged-dependency owners in: ${plan.ownerRewrites.join(', ')}`);
  }
  if (retireSource) {
    info(`Retired ${source.filename}; order ${source.order} is kept as a retired slot.`);
  }
  outro('Move complete');
}
