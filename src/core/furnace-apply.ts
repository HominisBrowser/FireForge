// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { FurnaceError } from '../errors/furnace.js';
import type { ApplyResult, DryRunAction } from '../types/furnace.js';
import { toError } from '../utils/errors.js';
import { pathExists } from '../utils/fs.js';
import { getProjectPaths } from './config.js';
import {
  applyCustomComponent,
  applyOverrideComponent,
  computeComponentChecksums,
  extractComponentChecksums,
  hasComponentChanged,
  prefixChecksums,
} from './furnace-apply-helpers.js';
import {
  getFurnacePaths,
  loadFurnaceConfig,
  loadFurnaceState,
  updateFurnaceState,
} from './furnace-config.js';
import {
  createRollbackJournal,
  restoreRollbackJournalOrThrow,
  type RollbackJournal,
} from './furnace-rollback.js';

export {
  applyCustomComponent,
  applyOverrideComponent,
  computeComponentChecksums,
  extractComponentChecksums,
  hasComponentChanged,
  prefixChecksums,
} from './furnace-apply-helpers.js';

type FurnaceConfigData = Awaited<ReturnType<typeof loadFurnaceConfig>>;
type FurnaceStateData = Awaited<ReturnType<typeof loadFurnaceState>>;
type ApplyAccumulator = ApplyResult & { actions?: DryRunAction[] };

function addMissingComponentError(
  result: ApplyAccumulator,
  name: string,
  directoryPath: string
): void {
  result.errors.push({
    name,
    error: `Component directory not found: ${directoryPath}`,
  });
}

async function applyOverrideBatch(
  config: FurnaceConfigData,
  furnacePaths: ReturnType<typeof getFurnacePaths>,
  state: FurnaceStateData,
  engineDir: string,
  dryRun: boolean,
  result: ApplyAccumulator,
  allActions: DryRunAction[],
  newChecksums: Record<string, string>,
  rollbackJournal?: RollbackJournal
): Promise<void> {
  for (const [name, overrideConfig] of Object.entries(config.overrides)) {
    const componentDir = join(furnacePaths.overridesDir, name);

    if (!(await pathExists(componentDir))) {
      addMissingComponentError(result, name, `components/overrides/${name}`);
      continue;
    }

    if (!dryRun) {
      const previous = extractComponentChecksums(state.appliedChecksums, 'override', name);
      const changed = await hasComponentChanged(componentDir, previous);

      if (!changed) {
        result.skipped.push({ name, reason: 'No changes since last apply' });
        Object.assign(newChecksums, prefixChecksums(previous, 'override', name));
        continue;
      }
    }

    try {
      const { affectedPaths: filesAffected, actions } = await applyOverrideComponent(
        engineDir,
        name,
        componentDir,
        overrideConfig,
        dryRun,
        rollbackJournal
      );
      if (dryRun && actions) {
        allActions.push(...actions);
      }
      result.applied.push({ name, type: 'override', filesAffected });

      if (!dryRun) {
        const checksums = await computeComponentChecksums(componentDir);
        Object.assign(newChecksums, prefixChecksums(checksums, 'override', name));
      }
    } catch (error: unknown) {
      result.errors.push({
        name,
        error: toError(error).message,
      });
    }
  }
}

async function applyCustomBatch(
  config: FurnaceConfigData,
  furnacePaths: ReturnType<typeof getFurnacePaths>,
  state: FurnaceStateData,
  engineDir: string,
  dryRun: boolean,
  result: ApplyAccumulator,
  allActions: DryRunAction[],
  newChecksums: Record<string, string>,
  rollbackJournal?: RollbackJournal
): Promise<void> {
  for (const [name, customConfig] of Object.entries(config.custom)) {
    const componentDir = join(furnacePaths.customDir, name);

    if (!(await pathExists(componentDir))) {
      addMissingComponentError(result, name, `components/custom/${name}`);
      continue;
    }

    if (!dryRun) {
      const previous = extractComponentChecksums(state.appliedChecksums, 'custom', name);
      const changed = await hasComponentChanged(componentDir, previous);

      if (!changed) {
        result.skipped.push({ name, reason: 'No changes since last apply' });
        Object.assign(newChecksums, prefixChecksums(previous, 'custom', name));
        continue;
      }
    }

    try {
      const {
        affectedPaths: filesAffected,
        stepErrors,
        actions,
      } = await applyCustomComponent(
        engineDir,
        name,
        componentDir,
        customConfig,
        dryRun,
        rollbackJournal
      );
      if (dryRun && actions) {
        allActions.push(...actions);
      }
      result.applied.push({
        name,
        type: 'custom',
        filesAffected,
        ...(stepErrors.length > 0 ? { stepErrors } : {}),
      });

      // Only store checksums when the component applied without step errors,
      // so that partially failed components are re-applied on the next run.
      if (!dryRun && stepErrors.length === 0) {
        const checksums = await computeComponentChecksums(componentDir);
        Object.assign(newChecksums, prefixChecksums(checksums, 'custom', name));
      }
    } catch (error: unknown) {
      result.errors.push({
        name,
        error: toError(error).message,
      });
    }
  }
}

/**
 * Applies all override and custom components to the engine source tree.
 *
 * Unchanged components (matching checksums) are skipped. If any component
 * fails, FireForge restores only the engine files touched during this apply
 * attempt and leaves the state file unchanged.
 *
 * @param root - Root directory of the project
 * @param dryRun - If true, enumerate planned actions without writing
 * @returns Summary of applied, skipped, and errored components (with actions when dry-run)
 */
export async function applyAllComponents(
  root: string,
  dryRun = false
): Promise<ApplyResult & { actions?: DryRunAction[] }> {
  const config = await loadFurnaceConfig(root);
  const state = await loadFurnaceState(root);
  const { engine: engineDir } = getProjectPaths(root);
  const furnacePaths = getFurnacePaths(root);

  if (!(await pathExists(engineDir))) {
    throw new FurnaceError('Engine directory not found. Run "fireforge download" first.');
  }

  const rollbackJournal = dryRun ? undefined : createRollbackJournal();

  const result: ApplyAccumulator = {
    applied: [],
    skipped: [],
    errors: [],
  };
  const allActions: DryRunAction[] = [];
  const newChecksums: Record<string, string> = {};

  await applyOverrideBatch(
    config,
    furnacePaths,
    state,
    engineDir,
    dryRun,
    result,
    allActions,
    newChecksums,
    rollbackJournal
  );
  await applyCustomBatch(
    config,
    furnacePaths,
    state,
    engineDir,
    dryRun,
    result,
    allActions,
    newChecksums,
    rollbackJournal
  );

  // Check for any partial failures (step errors on applied components).
  const hasStepErrors = result.applied.some(
    (entry) => 'stepErrors' in entry && (entry.stepErrors as unknown[]).length > 0
  );

  // Orphaned components are implicitly cleaned up: newChecksums only
  // contains entries for components that still exist in furnace.json,
  // and it fully replaces state.appliedChecksums below.

  // --- Rollback on failure, persist on success (skip for dry-run) ---
  if (!dryRun) {
    if (result.errors.length > 0 || hasStepErrors) {
      if (rollbackJournal) {
        await restoreRollbackJournalOrThrow(rollbackJournal, 'Furnace apply failed');
      }
    } else {
      await updateFurnaceState(root, {
        lastApply: new Date().toISOString(),
        appliedChecksums: newChecksums,
      });
    }
  }

  if (dryRun) {
    result.actions = allActions;
  }

  return result;
}
