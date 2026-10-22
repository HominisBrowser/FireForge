// SPDX-License-Identifier: EUPL-1.2
/**
 * Re-export prunes a staged registration the queue can no longer satisfy.
 *
 * A merge that deletes a file whose jar.mn line lives in another patch
 * leaves the staged registration on that patch: lint warns
 * `staged-dependency-unused`, and the stale declaration keeps the holder
 * measuring above a just-lowered size ceiling. When no patch in
 * the queue owns a registration's `creates` path any more, the declaration
 * cannot be met, so the holder's own re-export drops it and says so.
 *
 * A registration whose `creates` file exists in `engine/`, or is an
 * `--expect-new` path of the run, is kept: a manifest owner's re-export can
 * run between declaring the registration and the scan that adopts the
 * file, and pruning it there would break the scan that needs it next.
 */
import { join } from 'node:path';

import { appendHistoryBestEffort } from '../core/history-log.js';
import type {
  PatchesManifest,
  PatchMetadata,
  PatchStagedDependencies,
  PatchStagedForwardImport,
  PatchStagedRegistration,
} from '../types/commands/index.js';
import { pathExists } from '../utils/fs.js';
import { info } from '../utils/logger.js';

/** The holder's registrations split by whether the queue still owns `creates`. */
export interface StaleRegistrationPlan {
  /** Registrations whose `creates` path no patch owns. */
  dropped: PatchStagedRegistration[];
  /** Unowned registrations kept because their `creates` file is pending adoption. */
  pending: PatchStagedRegistration[];
  /** The staged block to write, or undefined when nothing is left. */
  stagedDependencies: PatchStagedDependencies | undefined;
}

/**
 * The unowned `creates` paths of `patch`'s registrations that are pending
 * adoption: the file exists in `engine/`, or is an `--expect-new` path of
 * this run. Such a registration is waiting for its subject patch's scan.
 */
export async function findPendingRegistrationCreates(
  engineDir: string,
  manifest: PatchesManifest,
  patch: PatchMetadata,
  currentFilesAffected: readonly string[],
  expectedNew: ReadonlySet<string>
): Promise<Set<string>> {
  const owned = ownedPaths(manifest, patch, currentFilesAffected);
  const pending = new Set<string>();
  for (const registration of patch.stagedDependencies?.registrations ?? []) {
    const creates = registration.creates;
    if (owned.has(creates) || pending.has(creates)) continue;
    if (expectedNew.has(creates) || (await pathExists(join(engineDir, creates)))) {
      pending.add(creates);
    }
  }
  return pending;
}

function ownedPaths(
  manifest: PatchesManifest,
  patch: PatchMetadata,
  currentFilesAffected: readonly string[]
): Set<string> {
  const owned = new Set<string>(currentFilesAffected);
  for (const entry of manifest.patches) {
    if (entry.filename === patch.filename) continue;
    for (const file of entry.filesAffected) owned.add(file);
  }
  return owned;
}

/**
 * Finds `patch`'s registrations whose `creates` path no patch in the queue
 * owns, judging `patch` by the file list this re-export will write. A
 * registration whose `creates` path is in `pending` (see
 * {@link findPendingRegistrationCreates}) is kept and reported instead.
 * Returns undefined when nothing is stale or pending.
 */
export function planStaleRegistrationDrop(
  manifest: PatchesManifest,
  patch: PatchMetadata,
  currentFilesAffected: readonly string[],
  pendingCreates: ReadonlySet<string> = new Set()
): StaleRegistrationPlan | undefined {
  const registrations = patch.stagedDependencies?.registrations ?? [];
  if (registrations.length === 0) return undefined;
  const owned = ownedPaths(manifest, patch, currentFilesAffected);
  const unowned = registrations.filter((registration) => !owned.has(registration.creates));
  const pending = unowned.filter((registration) => pendingCreates.has(registration.creates));
  const dropped = unowned.filter((registration) => !pendingCreates.has(registration.creates));
  if (dropped.length === 0 && pending.length === 0) return undefined;
  const kept = registrations.filter((registration) => !dropped.includes(registration));
  const forwardImports = patch.stagedDependencies?.forwardImports ?? [];
  const staged: PatchStagedDependencies = {
    ...(forwardImports.length > 0 ? { forwardImports } : {}),
    ...(kept.length > 0 ? { registrations: kept } : {}),
  };
  return {
    dropped,
    pending,
    stagedDependencies: Object.keys(staged).length > 0 ? staged : undefined,
  };
}

/** Names each dropped and each kept-pending registration, in both a dry run and a write. */
export function reportStaleRegistrationDrop(
  patchFilename: string,
  plan: StaleRegistrationPlan,
  isDryRun: boolean
): void {
  const verb = isDryRun ? 'would drop' : 'drops';
  for (const registration of plan.dropped) {
    info(
      `${patchFilename}: ${verb} staged registration ${registration.file} "${registration.line.trim()}": ` +
        `no patch in the queue creates ${registration.creates} any more.`
    );
  }
  for (const registration of plan.pending) {
    info(
      `${patchFilename}: staged registration ${registration.file} "${registration.line.trim()}" ` +
        `for ${registration.creates} kept: file exists but no patch owns it yet.`
    );
  }
}

/** One declaration a re-export pruned, as the history log records it. */
export type PrunedStagedDeclaration =
  | ({ kind: 'registration' } & PatchStagedRegistration)
  | ({ kind: 'import' } & PatchStagedForwardImport);

/**
 * Records declarations a re-export pruned from one patch as a delta, like
 * `staged-dependency --remove`.
 */
export async function recordStagedDeclarationPrune(
  patchesDir: string,
  patchFilename: string,
  removed: readonly PrunedStagedDeclaration[],
  what: string
): Promise<void> {
  if (removed.length === 0) return;
  await appendHistoryBestEffort(
    patchesDir,
    {
      operation: 're-export-staged-prune',
      args: { filename: patchFilename, removed: [...removed] },
      result: 'ok',
    },
    `re-export pruned ${what} on ${patchFilename}`
  );
}

/** Records the dropped registrations as a delta, like `staged-dependency --remove`. */
export async function recordStaleRegistrationDrop(
  patchesDir: string,
  patchFilename: string,
  plan: StaleRegistrationPlan
): Promise<void> {
  await recordStagedDeclarationPrune(
    patchesDir,
    patchFilename,
    plan.dropped.map((registration) => ({ kind: 'registration' as const, ...registration })),
    'stale staged registrations'
  );
}
