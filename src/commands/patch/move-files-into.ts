// SPDX-License-Identifier: EUPL-1.2
/**
 * Transactional file-ownership move into an EXISTING patch (FORGE F4).
 *
 * Before 0.39.0, `patch move-files <from> <to>` with an existing target was
 * preview-only: it printed two `re-export --files` commands whose real
 * execution cost three further refusals (`--allow-shrink`, `--yes`, and a
 * projected `duplicate-new-file-creation` unless the SHRINK landed first —
 * while the printed plan listed the grow first). This module performs the
 * same shrink→grow as one transaction under the patch-directory lock with
 * rollback, mirroring `patch split` / `move-files --create`.
 *
 * Preconditions match `re-export`: the engine worktree must currently
 * reflect both patches' content, because both bodies are regenerated from
 * the worktree.
 */

import { join } from 'node:path';

import { appendHistory, confirmDestructive, type ConflictReport } from '../../core/destructive.js';
import { computeProjectedLintRegressions } from '../../core/lint-projection.js';
import { normalizePatchArtifact } from '../../core/patch-artifact-normalize.js';
import {
  buildModifiedFileAdditionsFromDiff,
  buildPatchQueueContext,
  collectForwardImportEdges,
  detectNewFilesInDiff,
  lintPatchQueue,
  type PatchQueueEntry,
} from '../../core/patch-lint.js';
import { withPatchDirectoryLock } from '../../core/patch-lock.js';
import {
  loadPatchesManifest,
  savePatchesManifest,
  validatePatchesManifest,
} from '../../core/patch-manifest.js';
import { extractNewFileContentFromDiff } from '../../core/patch-transform.js';
import { GeneralError, InvalidArgumentError } from '../../errors/base.js';
import type {
  PatchMetadata,
  PatchMoveFilesOptions,
  PatchStagedForwardImport,
} from '../../types/commands/index.js';
import type { FireForgeConfig } from '../../types/config.js';
import { toError } from '../../utils/errors.js';
import { readText, writeText } from '../../utils/fs.js';
import { info, outro, success, warn } from '../../utils/logger.js';
import { runPatchLint } from '../export-shared.js';
import {
  buildSplitDiff,
  findOwnerRewriteHolders,
  mergeStagedForwardImports,
  rewriteSplitOwners,
} from './split-plan.js';

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
}

function projectEntryBody(
  diff: string
): Pick<PatchQueueEntry, 'diff' | 'newFiles' | 'modifiedFileAdditions'> {
  const newFiles = new Map<string, string>();
  for (const path of detectNewFilesInDiff(diff)) {
    newFiles.set(path, extractNewFileContentFromDiff(diff, path));
  }
  return { diff, newFiles, modifiedFileAdditions: buildModifiedFileAdditionsFromDiff(diff) };
}

/**
 * Projects the post-move queue through cross-patch lint, auto-declaring the
 * forward edges the move introduces into the target (an importer that used
 * to live in the same patch as the moved file gains a forward edge when the
 * target is later-ordered). Reports only regressions the move itself adds.
 */
async function runProjectedMoveLint(
  patchesDir: string,
  plan: MoveIntoPlan
): Promise<{
  conflicts: ConflictReport | null;
  stagedDependencyAdditions: Map<string, PatchStagedForwardImport[]>;
}> {
  const movedSet = new Set(plan.movedFiles);
  const baseCtx = await buildPatchQueueContext(patchesDir);

  const entries: PatchQueueEntry[] = baseCtx.entries.map((entry) => {
    let metadata = entry.metadata;
    if (metadata) {
      metadata = rewriteSplitOwners(metadata, plan.source.filename, movedSet, plan.target.filename);
    }
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
  const projectedIssues = lintPatchQueue({
    entries,
    ...(baseCtx.patchPolicy ? { patchPolicy: baseCtx.patchPolicy } : {}),
  }).filter((i) => i.severity === 'error');
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
          details: regressions.map((i) => `[${i.check}] ${i.file}: ${i.message}`),
        };
  return { conflicts, stagedDependencyAdditions };
}

/**
 * Commits a confirmed move under the patch-directory lock: write both
 * rewritten bodies, then one manifest rewrite (filesAffected on both rows +
 * owner rewrites + auto-declared forward imports). Rolled back in reverse
 * order on any failure.
 */
async function commitMoveInto(patchesDir: string, plan: MoveIntoPlan): Promise<void> {
  await withPatchDirectoryLock(patchesDir, async () => {
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

    const movedSet = new Set(plan.movedFiles);
    const sourcePath = join(patchesDir, plan.source.filename);
    const targetPath = join(patchesDir, plan.target.filename);
    const originalSourceBody = await readText(sourcePath);
    const originalTargetBody = await readText(targetPath);
    let sourceWritten = false;
    let targetWritten = false;

    try {
      await writeText(sourcePath, normalizePatchArtifact(plan.sourceDiff));
      sourceWritten = true;
      await writeText(targetPath, normalizePatchArtifact(plan.targetDiff));
      targetWritten = true;

      const updatedPatches = manifest.patches.map((patch) => {
        let updated = rewriteSplitOwners(
          patch,
          plan.source.filename,
          movedSet,
          plan.target.filename
        );
        const decls = plan.stagedDependencyAdditions.get(updated.filename);
        if (decls?.length) updated = mergeStagedForwardImports(updated, decls);
        if (updated.filename === plan.source.filename) {
          return { ...updated, filesAffected: plan.sourceAfter };
        }
        if (updated.filename === plan.target.filename) {
          return { ...updated, filesAffected: plan.targetAfter };
        }
        return updated;
      });
      const updated = validatePatchesManifest({ ...manifest, patches: updatedPatches });
      await savePatchesManifest(patchesDir, updated);

      try {
        await appendHistory(patchesDir, {
          operation: 'patch-move-files',
          args: {
            source: plan.source.filename,
            target: plan.target.filename,
            files: plan.movedFiles,
            ownerRewrites: plan.ownerRewrites,
          },
          result: 'ok',
        });
      } catch (historyError: unknown) {
        warn(
          `History log append failed after patch move-files committed: ${toError(historyError).message}`
        );
      }
    } catch (error: unknown) {
      if (targetWritten) {
        try {
          await writeText(targetPath, originalTargetBody);
        } catch (rollbackError: unknown) {
          warn(
            `Rollback warning: could not restore target body: ${toError(rollbackError).message}`
          );
        }
      }
      if (sourceWritten) {
        try {
          await writeText(sourcePath, originalSourceBody);
        } catch (rollbackError: unknown) {
          warn(
            `Rollback warning: could not restore source body: ${toError(rollbackError).message}`
          );
        }
      }
      try {
        await savePatchesManifest(patchesDir, manifest);
      } catch (rollbackError: unknown) {
        warn(`Rollback warning: could not restore manifest: ${toError(rollbackError).message}`);
      }
      throw error;
    }
  });
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
  targetAfter: string[];
  options: PatchMoveFilesOptions;
  config: FireForgeConfig;
}): Promise<void> {
  const { enginePath, patchesDir, source, target, files, sourceAfter, targetAfter, options } = args;

  const sourceDiff = await buildSplitDiff(enginePath, sourceAfter, 'remaining', source.filename);
  const targetDiff = await buildSplitDiff(enginePath, targetAfter, 'moved', target.filename);

  // Per-patch lint both projected bodies with each patch's own waivers.
  await runPatchLint(
    enginePath,
    sourceAfter,
    sourceDiff,
    args.config,
    options.skipLint,
    undefined,
    source.lintIgnore ? new Set<string>(source.lintIgnore) : undefined,
    source.tier
  );
  await runPatchLint(
    enginePath,
    targetAfter,
    targetDiff,
    args.config,
    options.skipLint,
    undefined,
    target.lintIgnore ? new Set<string>(target.lintIgnore) : undefined,
    target.tier
  );

  const manifest = await loadPatchesManifest(patchesDir);
  const plan: MoveIntoPlan = {
    source,
    target,
    movedFiles: files,
    sourceAfter,
    targetAfter,
    sourceDiff,
    targetDiff,
    ownerRewrites: findOwnerRewriteHolders(
      manifest?.patches ?? [],
      source.filename,
      new Set(files)
    ),
    stagedDependencyAdditions: new Map(),
  };

  const { conflicts, stagedDependencyAdditions } = await runProjectedMoveLint(patchesDir, plan);
  plan.stagedDependencyAdditions = stagedDependencyAdditions;

  const decision = await confirmDestructive({
    operation: 'patch-move-files',
    title: `Move ${files.length} file(s) from ${source.filename} to ${target.filename}`,
    summary: [
      `moved files (${files.length}): ${files.join(', ')}`,
      `${source.filename} keeps (${sourceAfter.length}): ${sourceAfter.join(', ')}`,
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
  if (decision === 'dry-run') {
    outro('Dry run complete — no changes made');
    return;
  }
  if (decision === 'cancelled') {
    outro('Move cancelled');
    return;
  }

  await commitMoveInto(patchesDir, plan);

  success(`Moved ${files.length} file(s) from ${source.filename} to ${target.filename}`);
  if (plan.ownerRewrites.length > 0) {
    info(`Re-pointed staged-dependency owners in: ${plan.ownerRewrites.join(', ')}`);
  }
  outro('Move complete');
}
