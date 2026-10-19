// SPDX-License-Identifier: EUPL-1.2
/**
 * Re-export prunes a staged registration the queue can no longer satisfy.
 *
 * A merge that deletes a file whose jar.mn line lives in another patch
 * left the staged registration on that patch: re-export kept it, lint then
 * warned `staged-dependency-unused`, and the stale declaration also kept
 * the holder measuring above a just-lowered size ceiling. When no patch in
 * the queue owns a registration's `creates` path any more, the declaration
 * cannot be met, so the holder's own re-export drops it and says so.
 */
import { appendHistoryBestEffort } from '../core/history-log.js';
import type {
  PatchesManifest,
  PatchMetadata,
  PatchStagedDependencies,
  PatchStagedRegistration,
} from '../types/commands/index.js';
import { info } from '../utils/logger.js';

/** The holder's registrations split by whether the queue still owns `creates`. */
export interface StaleRegistrationPlan {
  /** Registrations whose `creates` path no patch owns. */
  dropped: PatchStagedRegistration[];
  /** The staged block to write, or undefined when nothing is left. */
  stagedDependencies: PatchStagedDependencies | undefined;
}

/**
 * Finds `patch`'s registrations whose `creates` path no patch in the queue
 * owns, judging `patch` by the file list this re-export will write.
 * Returns undefined when nothing is stale.
 */
export function planStaleRegistrationDrop(
  manifest: PatchesManifest,
  patch: PatchMetadata,
  currentFilesAffected: readonly string[]
): StaleRegistrationPlan | undefined {
  const registrations = patch.stagedDependencies?.registrations ?? [];
  if (registrations.length === 0) return undefined;
  const owned = new Set<string>(currentFilesAffected);
  for (const entry of manifest.patches) {
    if (entry.filename === patch.filename) continue;
    for (const file of entry.filesAffected) owned.add(file);
  }
  const dropped = registrations.filter((registration) => !owned.has(registration.creates));
  if (dropped.length === 0) return undefined;
  const kept = registrations.filter((registration) => owned.has(registration.creates));
  const forwardImports = patch.stagedDependencies?.forwardImports ?? [];
  const staged: PatchStagedDependencies = {
    ...(forwardImports.length > 0 ? { forwardImports } : {}),
    ...(kept.length > 0 ? { registrations: kept } : {}),
  };
  return {
    dropped,
    stagedDependencies: Object.keys(staged).length > 0 ? staged : undefined,
  };
}

/** Names each dropped registration, in both a dry run and a write. */
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
}

/** Records the dropped declarations as a delta, like `staged-dependency --remove`. */
export async function recordStaleRegistrationDrop(
  patchesDir: string,
  patchFilename: string,
  plan: StaleRegistrationPlan
): Promise<void> {
  await appendHistoryBestEffort(
    patchesDir,
    {
      operation: 're-export-staged-prune',
      args: {
        filename: patchFilename,
        removed: plan.dropped.map((registration) => ({ kind: 'registration', ...registration })),
      },
      result: 'ok',
    },
    `re-export pruned stale staged registrations on ${patchFilename}`
  );
}
