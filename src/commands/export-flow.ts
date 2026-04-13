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
import { findAllPatchesForFilesWithDetails, planExport } from '../core/patch-export.js';
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
  type PatchRenameEntry,
  renumberPatchesInManifest,
  savePatchesManifest,
} from '../core/patch-manifest.js';
import { extractNewFileContentFromDiff } from '../core/patch-transform.js';
import { InvalidArgumentError } from '../errors/base.js';
import type { ExportOptions, PatchCategory, PatchMetadata } from '../types/commands/index.js';
import { toError } from '../utils/errors.js';
import { pathExists, readText, removeFile, writeText } from '../utils/fs.js';
import { info, warn } from '../utils/logger.js';

/**
 * Sanitizes a patch name for use in a filename. Mirrors the private helper
 * in patch-export.ts.
 */
function sanitizeExportName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function buildFilenameForPlacement(
  category: PatchCategory,
  name: string,
  order: number,
  width: number
): string {
  const padded = String(order).padStart(Math.max(3, width), '0');
  return `${padded}-${category}-${sanitizeExportName(name)}.patch`;
}

function resolvePatchByIdentifier(
  identifier: string,
  patches: PatchMetadata[]
): PatchMetadata | null {
  if (/^\d+$/.test(identifier)) {
    const order = parseInt(identifier, 10);
    return patches.find((p) => p.order === order) ?? null;
  }
  const normalized = identifier.endsWith('.patch') ? identifier : `${identifier}.patch`;
  return patches.find((p) => p.filename === normalized) ?? null;
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

function getSortedRenameEntries(
  renameMap: Map<string, PatchRenameEntry>
): Array<[string, PatchRenameEntry]> {
  return Array.from(renameMap.entries()).sort((a, b) => a[1].newOrder - b[1].newOrder);
}

function placementPlansEqual(left: PlacementPlan, right: PlacementPlan): boolean {
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

  // Decide the canonical prefix width by inspecting the widest existing
  // filename (falling back to 3). Keeps zero-padding consistent post-shift.
  const prefixWidth = sorted.reduce((w, p) => {
    const match = /^(\d+)-/.exec(p.filename);
    return match ? Math.max(w, match[1]?.length ?? 3) : w;
  }, 3);

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
 * Resolves a placement plan from CLI flags against the current manifest.
 */
export async function resolvePlacementPlan(
  patchesDir: string,
  options: ExportOptions,
  category: PatchCategory,
  name: string
): Promise<PlacementPlan> {
  const manifest = await loadPatchesManifest(patchesDir);
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
    targetOrder = options.order;
  } else if (options.before !== undefined) {
    const anchor = resolvePatchByIdentifier(options.before, existingPatches);
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
    const anchor = resolvePatchByIdentifier(afterAnchorId, existingPatches);
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
        `Refusing to run export: ${conflicts.reason}. Pass --force-unsafe to override.`,
        '--force-unsafe'
      );
    }

    // Snapshot pre-mutation state so we can best-effort restore the queue
    // if any of the three steps below fail mid-flight. Mirrors the
    // rollback shape in commitExportedPatch (src/core/patch-export.ts), but
    // inlined because the two rollbacks operate on different state shapes
    // (rename map vs. supersede set) and sharing a helper would be forced.
    const patchPath = join(input.patchesDir, currentPlan.newFilename);
    const originalManifest = await loadPatchesManifest(input.patchesDir);
    const originalNewPatchContent = (await pathExists(patchPath))
      ? await readText(patchPath)
      : null;
    let renumberApplied = false;

    try {
      if (currentPlan.renameMap.size > 0) {
        await renumberPatchesInManifest(input.patchesDir, currentPlan.renameMap);
        renumberApplied = true;
      }
      await writeText(patchPath, input.diff);
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
  explicitSupersede: boolean;
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
  const plan = await planExport({
    patchesDir: input.patchesDir,
    category: input.category,
    name: input.name,
    description: input.description,
    filesAffected: input.filesAffected,
    sourceEsrVersion: input.sourceEsrVersion,
  });

  info(`\n[dry-run] Would write: patches/${plan.patchFilename}`);
  info(`  category: ${plan.metadata.category}`);
  info(`  order: ${plan.metadata.order}`);
  info(`  description: ${plan.metadata.description || '(none)'}`);
  info(
    `  filesAffected (${plan.metadata.filesAffected.length}): ${plan.metadata.filesAffected.join(', ')}`
  );

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
}
