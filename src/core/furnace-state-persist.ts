// SPDX-License-Identifier: EUPL-1.2
/**
 * Single-component furnace state persistence.
 *
 * There are exactly two sanctioned ways checksums land in
 * furnace-state.json:
 *
 *  1. The BATCH path inside `applyAllComponents` (persistState: true), which
 *     replaces `appliedChecksums` wholesale — correct only when the run
 *     covered every component.
 *  2. The per-component MERGE in this module, which rewrites only the
 *     `<type>/<name>/…` keys of the component that was applied.
 *
 * Every targeted (named) apply/deploy MUST use path 2 with
 * `persistState: false`. Routing a named run through the batch path wipes
 * every other component's checksum state: the batch loops filter to the
 * named component, so the wholesale replace persists a state file containing
 * only that component. Downstream, `diffDeletedFiles` and
 * `findOrphanedEngineFiles` both key on `appliedChecksums`, so the wiped
 * components' stale engine files become undetectable by apply AND by
 * `furnace validate`.
 */

import { join } from 'node:path';

import { FurnaceError } from '../errors/furnace.js';
import {
  type ApplyAllComponentsResult,
  computeComponentChecksums,
  prefixChecksums,
} from './furnace-apply.js';
import { type getFurnacePaths, updateFurnaceState } from './furnace-config.js';
import { countEntriesWithBlockingStepErrors } from './furnace-step-errors.js';

/**
 * Counts applied entries that carry at least one BLOCKING step error
 * (advisory step errors are warnings and never fail a run).
 */
export function getStepFailureCount(result: ApplyAllComponentsResult): number {
  return countEntriesWithBlockingStepErrors(result.applied);
}

/**
 * Decides whether a single-component apply/deploy completed cleanly enough
 * to persist its checksums into furnace-state.json.
 *
 * Named runs are atomic: if any apply step fails, the rollback journal
 * restores the engine to its pre-run state and this helper returns `false`
 * so state is not touched. The conditions must stay in lock-step with the
 * rollback trigger in `applyAllComponents` — both read step errors, so a
 * future refactor cannot drift them apart and accidentally persist partial
 * state.
 */
export function shouldPersistSingleComponentState(
  result: ApplyAllComponentsResult,
  isDryRun: boolean
): boolean {
  if (isDryRun) return false;
  if (result.errors.length > 0) return false;
  if (getStepFailureCount(result) > 0) return false;
  return result.applied.length > 0;
}

/**
 * Validates and narrows the applied entry a named run should persist.
 *
 * Guards against future refactors that might reorder or misroute the
 * applied[] array: a named run persists state under a single component
 * name, so the first applied entry MUST be that component. Persisting a
 * different component's checksums would cause the next status/apply run to
 * mis-report health for both components involved.
 *
 * @param commandLabel - Human label for error messages ("Deploy", "Apply")
 */
export function getPersistableAppliedEntry(
  commandLabel: string,
  name: string,
  appliedEntry: ApplyAllComponentsResult['applied'][number] | undefined
): { name: string; type: 'override' | 'custom' } {
  if (!appliedEntry) {
    throw new FurnaceError(
      `${commandLabel} for "${name}" finished without producing an applied component entry; ` +
        `furnace state was not modified. Run "fireforge doctor --repair-furnace" to ` +
        `reconcile state, then retry. If this persists, file a bug with the ` +
        `output of "fireforge doctor".`
    );
  }

  if (appliedEntry.type !== 'override' && appliedEntry.type !== 'custom') {
    throw new FurnaceError(
      `${commandLabel} for "${name}" returned an unsupported component type "${appliedEntry.type}"; ` +
        `furnace state was not modified. Run "fireforge doctor --repair-furnace" to reconcile, ` +
        `then verify the component with "fireforge furnace validate" before retrying.`
    );
  }

  if (appliedEntry.name !== name) {
    throw new FurnaceError(
      `${commandLabel} for "${name}" returned an applied entry for a different component ` +
        `("${appliedEntry.name}"); refusing to persist mismatched state. ` +
        `Run "fireforge doctor --repair-furnace" to reconcile, then retry.`
    );
  }

  return {
    name: appliedEntry.name,
    type: appliedEntry.type,
  };
}

/**
 * Persists checksum state for a successfully applied named component by
 * MERGING its `<type>/<name>/…` keys into the existing state — never
 * replacing the whole map.
 *
 * @param projectRoot - Root directory of the project
 * @param appliedEntry - Applied component descriptor
 * @param furnacePaths - Resolved Furnace workspace paths
 */
export async function persistSingleComponentState(
  projectRoot: string,
  appliedEntry: { name: string; type: 'override' | 'custom' },
  furnacePaths: ReturnType<typeof getFurnacePaths>
): Promise<void> {
  const componentDir =
    appliedEntry.type === 'override'
      ? join(furnacePaths.overridesDir, appliedEntry.name)
      : join(furnacePaths.customDir, appliedEntry.name);
  const checksums = await computeComponentChecksums(componentDir);
  const prefixed = prefixChecksums(checksums, appliedEntry.type, appliedEntry.name);
  const componentPrefix = `${appliedEntry.type}/${appliedEntry.name}/`;
  await updateFurnaceState(projectRoot, (current) => ({
    ...current,
    appliedChecksums: {
      ...Object.fromEntries(
        Object.entries(current.appliedChecksums ?? {}).filter(
          ([key]) => !key.startsWith(componentPrefix)
        )
      ),
      ...prefixed,
    },
    engineChecksums: {
      ...Object.fromEntries(
        Object.entries(current.engineChecksums ?? {}).filter(
          ([key]) => !key.startsWith(componentPrefix)
        )
      ),
      ...prefixed,
    },
    lastApply: new Date().toISOString(),
  }));
}
