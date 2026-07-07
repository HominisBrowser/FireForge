// SPDX-License-Identifier: EUPL-1.2
/**
 * Planning + dry-run + placement helpers extracted from `export.ts`.
 *
 * These functions are pure or narrowly-scoped async helpers that compose
 * into `exportCommand`. Splitting them out keeps `export.ts` under the
 * per-file / per-function line budgets and makes each step individually
 * testable without dragging the whole command harness along for the ride.
 */

import { join } from 'node:path';

import { type ConflictReport } from '../core/destructive.js';
import { normalizePatchArtifact } from '../core/patch-artifact-normalize.js';
import {
  findAllPatchesForFilesWithDetails,
  patchNameSlug,
  planExport,
} from '../core/patch-export.js';
import {
  buildModifiedFileAdditionsFromDiff,
  buildPatchQueueContext,
  detectNewFilesInDiff,
  lintPatchQueue,
} from '../core/patch-lint.js';
import { withPatchDirectoryLock } from '../core/patch-lock.js';
import {
  addPatchToManifest,
  loadPatchesManifest,
  loadPatchesManifestForWrite,
  type PatchRenameEntry,
  renumberPatchesInManifest,
  resolvePatchIdentifier,
  savePatchesManifest,
} from '../core/patch-manifest.js';
import {
  applyRenameMapToManifest,
  buildProjectedManifest,
  enforcePatchPolicy,
} from '../core/patch-policy.js';
import { extractNewFileContentFromDiff } from '../core/patch-transform.js';
import { GeneralError, InvalidArgumentError } from '../errors/base.js';
import type { ExportOptions, PatchCategory, PatchMetadata } from '../types/commands/index.js';
import type { FireForgeConfig } from '../types/config.js';
import { toError } from '../utils/errors.js';
import { pathExists, readText, removeFile, writeText } from '../utils/fs.js';
import { info, warn } from '../utils/logger.js';
import { assertPlacementPreservesReservedRanges } from './export-placement-policy.js';
import { findPartialOwnershipOverlap } from './export-shared.js';

function buildFilenameForPlacement(
  category: PatchCategory,
  name: string,
  order: number,
  width: number
): string {
  const padded = String(order).padStart(Math.max(3, width), '0');
  return `${padded}-${category}-${patchNameSlug(name, category)}.patch`;
}

/**
 * Shape for the rename map computed when a placement flag forces existing
 * patches to move out of the new slot. Keys are current filenames.
 */
export interface PlacementPlan {
  insertionOrder: number;
  newFilename: string;
  renameMap: Map<string, PatchRenameEntry>;
}

function prefixWidthForPatches(manifestPatches: PatchMetadata[], requestedOrder: number): number {
  return manifestPatches.reduce((width, patch) => {
    const match = /^(\d+)-/.exec(patch.filename);
    return Math.max(width, match?.[1]?.length ?? 3, String(requestedOrder).length);
  }, 3);
}

function getSortedRenameEntries(
  renameMap: Map<string, PatchRenameEntry>
): Array<[string, PatchRenameEntry]> {
  return Array.from(renameMap.entries()).sort((a, b) => a[1].newOrder - b[1].newOrder);
}

/**
 * Structural equality for placement plans — used by placement-mode export
 * and `patch split` to verify the queue did not change between the
 * confirmed preview and the under-lock commit.
 */
export function placementPlansEqual(left: PlacementPlan, right: PlacementPlan): boolean {
  if (left.insertionOrder !== right.insertionOrder || left.newFilename !== right.newFilename) {
    return false;
  }

  const leftEntries = getSortedRenameEntries(left.renameMap);
  const rightEntries = getSortedRenameEntries(right.renameMap);
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }

  return leftEntries.every(([leftFilename, leftEntry], index) => {
    const rightTuple = rightEntries[index];
    if (!rightTuple) return false;
    const [rightFilename, rightEntry] = rightTuple;
    return (
      leftFilename === rightFilename &&
      leftEntry.newFilename === rightEntry.newFilename &&
      leftEntry.newOrder === rightEntry.newOrder
    );
  });
}

/**
 * Computes the shift map that moves existing patches out of the requested
 * slot to make room for a new patch at `requestedOrder`.
 */
export function computePlacementPlan(
  manifestPatches: PatchMetadata[],
  newPatchCategory: PatchCategory,
  newPatchName: string,
  requestedOrder: number
): PlacementPlan {
  // Defense-in-depth: the --order argParser already validates, but this
  // function is exported and reachable from tests / future callers.
  // Failing fast here prevents a NaN requestedOrder from producing a
  // filename like "NaN-ui-foo.patch".
  if (!Number.isInteger(requestedOrder) || requestedOrder <= 0) {
    throw new InvalidArgumentError(
      `computePlacementPlan requires a positive integer order, got ${String(requestedOrder)}.`,
      'requestedOrder'
    );
  }
  const sorted = [...manifestPatches].sort((a, b) => a.order - b.order);
  const renameMap = new Map<string, PatchRenameEntry>();
  const prefixWidth = prefixWidthForPatches(sorted, requestedOrder);

  // Every existing patch at requestedOrder or later shifts up by one.
  for (const patch of sorted) {
    if (patch.order >= requestedOrder) {
      const newOrder = patch.order + 1;
      const currentRest = patch.filename.replace(/^\d+-/, '');
      const newFilename = `${String(newOrder).padStart(prefixWidth, '0')}-${currentRest}`;
      renameMap.set(patch.filename, { newOrder, newFilename });
    }
  }

  const newFilename = buildFilenameForPlacement(
    newPatchCategory,
    newPatchName,
    requestedOrder,
    prefixWidth
  );

  return {
    insertionOrder: requestedOrder,
    newFilename,
    renameMap,
  };
}

/**
 * Computes an exact sparse placement plan for `--order <N>`. Unlike
 * positional insertion, this never renumbers existing patches: the order
 * must be unused, and policy validation decides whether the requested
 * category/order is allowed.
 */
export function computeExactPlacementPlan(
  manifestPatches: PatchMetadata[],
  newPatchCategory: PatchCategory,
  newPatchName: string,
  requestedOrder: number
): PlacementPlan {
  if (!Number.isInteger(requestedOrder) || requestedOrder <= 0) {
    throw new InvalidArgumentError(
      `--order must be a positive integer, got ${String(requestedOrder)}.`,
      '--order'
    );
  }

  const occupied = manifestPatches.find((patch) => patch.order === requestedOrder);
  if (occupied) {
    throw new InvalidArgumentError(
      `--order ${String(requestedOrder)} is already occupied by ${occupied.filename}. ` +
        'Choose an unused order or use --before/--after for positional insertion.',
      '--order'
    );
  }

  return {
    insertionOrder: requestedOrder,
    newFilename: buildFilenameForPlacement(
      newPatchCategory,
      newPatchName,
      requestedOrder,
      prefixWidthForPatches(manifestPatches, requestedOrder)
    ),
    renameMap: new Map(),
  };
}

/**
 * Resolves a placement plan from CLI flags against the current manifest.
 */
export async function resolvePlacementPlan(
  patchesDir: string,
  options: ExportOptions,
  category: PatchCategory,
  name: string
): Promise<PlacementPlan> {
  // ForWrite: placement planning feeds a manifest rewrite; a corrupt
  // manifest read as empty would allocate colliding orders.
  const manifest = await loadPatchesManifestForWrite(patchesDir);
  const existingPatches = manifest?.patches ?? [];

  let targetOrder: number;
  if (options.order !== undefined) {
    // Defense-in-depth — argParser covers the CLI path, but this
    // function is called directly from the command body which could
    // reach here with a NaN/0/negative value passed in via test harness.
    if (!Number.isInteger(options.order) || options.order <= 0) {
      throw new InvalidArgumentError(
        `--order must be a positive integer, got ${String(options.order)}.`,
        '--order'
      );
    }
    return computeExactPlacementPlan(existingPatches, category, name, options.order);
  } else if (options.before !== undefined) {
    const anchor = resolvePatchIdentifier(options.before, existingPatches);
    if (!anchor) {
      throw new InvalidArgumentError(`--before anchor "${options.before}" not found.`, '--before');
    }
    targetOrder = anchor.order;
  } else {
    const afterAnchorId = options.after;
    if (afterAnchorId === undefined) {
      throw new InvalidArgumentError(
        'Placement flag resolver reached --after branch with no value set.',
        '--after'
      );
    }
    const anchor = resolvePatchIdentifier(afterAnchorId, existingPatches);
    if (!anchor) {
      throw new InvalidArgumentError(`--after anchor "${afterAnchorId}" not found.`, '--after');
    }
    targetOrder = anchor.order + 1;
  }

  return computePlacementPlan(existingPatches, category, name, targetOrder);
}

/**
 * Extracts the newly-created files a diff would produce and builds the
 * `newFiles` map in the shape expected by {@link PatchQueueEntry}. Used
 * to build a faithful synthetic entry for the pending patch when
 * projecting through cross-patch lint — without this the forward-import
 * rule cannot see imports authored by the new patch itself.
 */
function buildNewFilesFromDiff(diff: string): Map<string, string> {
  const newFiles = new Map<string, string>();
  const newFilePaths = detectNewFilesInDiff(diff);
  for (const path of newFilePaths) {
    newFiles.set(path, extractNewFileContentFromDiff(diff, path));
  }
  return newFiles;
}

/**
 * Projects the placement through cross-patch lint to detect forward-imports
 * the renumber would introduce *or* that the new patch itself would
 * introduce by landing earlier than one of its dependencies. Returns null
 * when the projection is clean.
 */
export async function projectPlacementForLint(
  patchesDir: string,
  plan: PlacementPlan,
  diff: string
): Promise<ConflictReport | null> {
  const baseCtx = await buildPatchQueueContext(patchesDir);
  const projectedEntries = baseCtx.entries.map((entry) => {
    const rename = plan.renameMap.get(entry.filename);
    if (!rename) return entry;
    return { ...entry, filename: rename.newFilename, order: rename.newOrder };
  });
  // Synthetic entry for the pending patch, populated with both its
  // new-file content AND its added-line content for files it modifies
  // so the forward-import rule can inspect imports the patch *itself*
  // authors — whether they live in a brand-new file or are added to an
  // existing file. Leaving either map empty lets a patch land before
  // one of its own dependencies and still pass the gate.
  projectedEntries.push({
    filename: plan.newFilename,
    order: plan.insertionOrder,
    metadata: null,
    diff,
    newFiles: buildNewFilesFromDiff(diff),
    modifiedFileAdditions: buildModifiedFileAdditionsFromDiff(diff),
  });
  projectedEntries.sort((a, b) => a.order - b.order || a.filename.localeCompare(b.filename));
  const projectedIssues = lintPatchQueue({ entries: projectedEntries }).filter(
    (i) => i.severity === 'error'
  );
  if (projectedIssues.length === 0) return null;
  return {
    reason: `placement would introduce ${projectedIssues.length} cross-patch lint error(s)`,
    details: projectedIssues.map((i) => `[${i.check}] ${i.file}: ${i.message}`),
  };
}

/**
 * Builds the change-summary lines printed by the placement confirmation.
 */
export function placementSummary(plan: PlacementPlan): string[] {
  const summary: string[] = [
    `place new patch as ${plan.newFilename} (order ${plan.insertionOrder})`,
  ];
  const sortedRenames = getSortedRenameEntries(plan.renameMap);
  if (sortedRenames.length > 0) {
    summary.push(`${sortedRenames.length} existing patch(es) would be renumbered:`);
    for (const [oldName, rename] of sortedRenames) {
      summary.push(`  ${oldName}  →  ${rename.newFilename}`);
    }
  }
  return summary;
}

/**
 * Writes a placement-mode export under the patch directory lock after
 * re-resolving the plan against the current queue state. If the queue has
 * changed since the user confirmed the preview, the command aborts instead
 * of silently applying a different renumber than the one that was shown.
 */
export interface CommitPlacementExportInput {
  patchesDir: string;
  options: ExportOptions;
  category: PatchCategory;
  name: string;
  diff: string;
  metadata: PatchMetadata;
  expectedPlan: PlacementPlan;
  unsafeOverride?: boolean;
  /** Project config, used only when opt-in patchPolicy is present. */
  config?: FireForgeConfig;
  /** Whether --force-unsafe was supplied by the mutating command. */
  forceUnsafe?: boolean;
  /**
   * Optional post-commit hook that runs inside the patch directory lock,
   * after the mutation has succeeded but before the lock is released.
   * Intended for the caller's history-log append so the audit record
   * lands atomically with the mutation — a crash between mutation and
   * hook leaves no room for another process's history record to sneak
   * in first.
   *
   * Failures in the hook are warned but never re-thrown: by the time it
   * runs, the mutation is already committed, and there is nothing to
   * roll back. History is advisory.
   */
  onCommitted?: (plan: PlacementPlan) => Promise<void>;
}

/**
 * Commits a previously-confirmed placement export under the patch
 * directory lock. Re-resolves the placement plan against the current
 * queue and aborts if anything changed since the preview so the command
 * never applies a silently different rename set than the user saw.
 */
export async function commitPlacementExport(
  input: CommitPlacementExportInput
): Promise<PlacementPlan> {
  return withPatchDirectoryLock(input.patchesDir, async () => {
    const currentPlan = await resolvePlacementPlan(
      input.patchesDir,
      input.options,
      input.category,
      input.name
    );
    if (!placementPlansEqual(currentPlan, input.expectedPlan)) {
      throw new InvalidArgumentError(
        'Patch queue changed while waiting for export confirmation. Re-run the command to recompute placement.',
        'export placement'
      );
    }

    const conflicts = await projectPlacementForLint(input.patchesDir, currentPlan, input.diff);
    if (conflicts && input.unsafeOverride !== true) {
      throw new InvalidArgumentError(
        `Refusing to run export: ${conflicts.reason}. ` +
          'If the conflict names files owned by another patch (e.g. duplicate-new-file-creation), ' +
          're-run the export with an explicit file list that leaves those files with their owner — ' +
          'do NOT bypass with --force-unsafe. Pass --force-unsafe only for a reviewed placement conflict.',
        '--force-unsafe'
      );
    }

    const originalManifest = await loadPatchesManifestForWrite(input.patchesDir);
    if (originalManifest !== null) {
      assertPlacementPreservesReservedRanges(
        currentPlan,
        originalManifest.patches,
        input.config,
        input.category
      );
    }
    if (input.config !== undefined) {
      const renamed =
        originalManifest !== null
          ? applyRenameMapToManifest(originalManifest, currentPlan.renameMap)
          : buildProjectedManifest(null, []);
      enforcePatchPolicy({
        config: input.config,
        manifest: buildProjectedManifest(renamed, [
          ...renamed.patches,
          {
            ...input.metadata,
            filename: currentPlan.newFilename,
            order: currentPlan.insertionOrder,
          },
        ]),
        command: 'export',
        forceUnsafe: input.forceUnsafe === true,
      });
    }

    // Snapshot pre-mutation state so we can best-effort restore the queue
    // if any of the three steps below fail mid-flight. Mirrors the
    // rollback shape in commitExportedPatch (src/core/patch-export.ts), but
    // inlined because the two rollbacks operate on different state shapes
    // (rename map vs. supersede set) and sharing a helper would be forced.
    const patchPath = join(input.patchesDir, currentPlan.newFilename);
    const originalNewPatchContent = (await pathExists(patchPath))
      ? await readText(patchPath)
      : null;
    let renumberApplied = false;

    try {
      if (currentPlan.renameMap.size > 0) {
        await renumberPatchesInManifest(input.patchesDir, currentPlan.renameMap);
        renumberApplied = true;
      }
      // Normalize identically to commitExportedPatch — the two export
      // paths must produce one artifact contract for the same diff.
      await writeText(patchPath, normalizePatchArtifact(input.diff));
      await addPatchToManifest(input.patchesDir, {
        ...input.metadata,
        filename: currentPlan.newFilename,
        order: currentPlan.insertionOrder,
      });
      if (input.onCommitted) {
        try {
          await input.onCommitted(currentPlan);
        } catch (hookError: unknown) {
          // Mutation has already committed and is not reversible. Warn
          // so operators know the audit trail has a gap, but do not
          // re-throw — that would look like the export itself failed.
          warn(
            `History log append failed after export committed (export-order, ${currentPlan.newFilename}): ` +
              toError(hookError).message
          );
        }
      }
      return currentPlan;
    } catch (error: unknown) {
      // Best-effort rollback. Each restoration step gets its own nested
      // try/catch so a secondary failure warns without masking the
      // original error we are about to rethrow.
      try {
        if (originalNewPatchContent === null) {
          if (await pathExists(patchPath)) {
            await removeFile(patchPath);
          }
        } else {
          await writeText(patchPath, originalNewPatchContent);
        }
      } catch (rollbackError: unknown) {
        warn(
          `Rollback warning: could not restore new patch file: ${toError(rollbackError).message}`
        );
      }

      if (renumberApplied) {
        // Invert the forward rename map and re-apply through the same
        // two-phase staging renumber. The oldFilename encodes its
        // original order in the leading digits, so parsing them back
        // avoids tracking a second map during the forward pass.
        const inverseMap = new Map<string, PatchRenameEntry>();
        for (const [oldFilename, entry] of currentPlan.renameMap) {
          const oldOrder = parseInt(oldFilename.split('-')[0] ?? '0', 10);
          inverseMap.set(entry.newFilename, {
            newOrder: oldOrder,
            newFilename: oldFilename,
          });
        }
        try {
          await renumberPatchesInManifest(input.patchesDir, inverseMap);
        } catch (rollbackError: unknown) {
          warn(
            `Rollback warning: could not invert placement renumber: ${toError(rollbackError).message}`
          );
        }
      }

      // Belt-and-braces: overwrite the manifest with the original
      // snapshot so a partial addPatchToManifest write (new entry
      // appended but inverse renumber skipped or incomplete) is erased.
      // Safe because by this point the disk filenames should match the
      // original manifest's filenames.
      if (originalManifest) {
        try {
          await savePatchesManifest(input.patchesDir, originalManifest);
        } catch (rollbackError: unknown) {
          warn(`Rollback warning: could not restore manifest: ${toError(rollbackError).message}`);
        }
      }

      throw error;
    }
  });
}

export interface DryRunPreviewInput {
  patchesDir: string;
  category: PatchCategory;
  name: string;
  description: string;
  filesAffected: string[];
  sourceEsrVersion: string;
  sourceProduct?: FireForgeConfig['firefox']['product'];
  sourceVersion?: string;
  explicitSupersede: boolean;
  allowOverlap: boolean;
  /** Optional `PatchMetadata.tier` opt-in carried from the CLI. */
  tier?: 'branding';
  /** Optional `PatchMetadata.lintIgnore` carried from the CLI. */
  lintIgnore?: string[];
  /** Project config, used only when opt-in patchPolicy is present. */
  config?: FireForgeConfig;
  /** Whether --force-unsafe was supplied by the mutating command. */
  forceUnsafe?: boolean;
}

/**
 * Renders the plain (non-placement) dry-run preview: calls planExport,
 * prints the allocated filename + metadata, and with supersede enumerates
 * the per-patch coverage detail that was opaque before this refactor.
 */
export async function renderDryRunPreview(input: DryRunPreviewInput): Promise<void> {
  const supersedeDetails = await findAllPatchesForFilesWithDetails(
    input.patchesDir,
    input.filesAffected
  );
  const supersedingFilenames = new Set(supersedeDetails.map((detail) => detail.patch.filename));
  const manifest = await loadPatchesManifest(input.patchesDir);
  const overlap =
    manifest !== null
      ? findPartialOwnershipOverlap(manifest, input.filesAffected, supersedingFilenames)
      : new Map<string, string[]>();
  const plan = await planExport({
    patchesDir: input.patchesDir,
    category: input.category,
    name: input.name,
    description: input.description,
    filesAffected: input.filesAffected,
    sourceEsrVersion: input.sourceEsrVersion,
    ...(input.sourceProduct !== undefined ? { sourceProduct: input.sourceProduct } : {}),
    ...(input.sourceVersion !== undefined ? { sourceVersion: input.sourceVersion } : {}),
    ...(input.tier !== undefined ? { tier: input.tier } : {}),
    ...(input.lintIgnore !== undefined ? { lintIgnore: input.lintIgnore } : {}),
    ...(input.config !== undefined ? { config: input.config } : {}),
  });

  if (input.config !== undefined) {
    enforcePatchPolicy({
      config: input.config,
      manifest: plan.manifestAfter,
      command: 'export',
      forceUnsafe: input.forceUnsafe === true,
    });
  }

  info(`\n[dry-run] Would write: patches/${plan.patchFilename}`);
  info(`  category: ${plan.metadata.category}`);
  info(`  order: ${plan.metadata.order}`);
  info(`  description: ${plan.metadata.description || '(none)'}`);
  info(
    `  filesAffected (${plan.metadata.filesAffected.length}): ${plan.metadata.filesAffected.join(', ')}`
  );
  if (plan.metadata.tier !== undefined) {
    info(`  tier: ${plan.metadata.tier}`);
  }
  if (plan.metadata.lintIgnore !== undefined && plan.metadata.lintIgnore.length > 0) {
    info(`  lintIgnore: ${plan.metadata.lintIgnore.join(', ')}`);
  }

  if (supersedeDetails.length > 0) {
    info(`\n[dry-run] Would supersede ${supersedeDetails.length} existing patch(es):`);
    for (const detail of supersedeDetails) {
      info(`  - ${detail.patch.filename}  (covered by: ${detail.coverage.byFiles.join(', ')})`);
    }
    if (!input.explicitSupersede) {
      warn(
        'Real run would prompt for confirmation or require --supersede in non-interactive mode.'
      );
    }
  } else {
    info('\n[dry-run] No patches would be superseded.');
  }

  if (overlap.size > 0) {
    const entries = [...overlap.entries()].sort(([a], [b]) => a.localeCompare(b));
    warn(
      `\n[dry-run] Would create cross-patch ownership overlap on ${String(entries.length)} file${entries.length === 1 ? '' : 's'}:`
    );
    for (const [file, owners] of entries) {
      warn(`  - ${file} already claimed by: ${owners.join(', ')}`);
    }
    warn(
      'The real export would leave the queue verify-failing. Repartition ownership with `fireforge re-export --files <paths> <existing-patch>` before exporting, or pass --allow-overlap to acknowledge the conflict.'
    );
    if (!input.allowOverlap) {
      throw new GeneralError(
        'Dry-run detected cross-patch ownership overlap. Pass --allow-overlap to preview the acknowledged conflict, or repartition ownership via `fireforge re-export --files`.'
      );
    }
  } else {
    info('[dry-run] No cross-patch ownership overlap detected.');
  }
}
