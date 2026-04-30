// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { FurnaceError } from '../errors/furnace.js';
import type {
  ApplyResult,
  CustomComponentConfig,
  DryRunAction,
  OverrideComponentConfig,
} from '../types/furnace.js';
import { toError } from '../utils/errors.js';
import { pathExists } from '../utils/fs.js';
import { info } from '../utils/logger.js';
import { getProjectPaths, loadConfig } from './config.js';
import {
  applyCustomComponent,
  applyOverrideComponent,
  computeComponentChecksums,
  diffDeletedFiles,
  extractComponentChecksums,
  getOverrideEngineTargetPath,
  hasComponentChanged,
  hasCustomEngineDrift,
  hasOverrideEngineDrift,
  prefixChecksums,
  undeployCustomFiles,
  undeployOverrideFiles,
} from './furnace-apply-helpers.js';
import {
  getFurnacePaths,
  loadFurnaceConfig,
  loadFurnaceState,
  updateFurnaceState,
} from './furnace-config.js';
import { CUSTOM_ELEMENTS_JS, JAR_MN, resolveFtlDir } from './furnace-constants.js';
import { topologicalSortCustom } from './furnace-graph-utils.js';
import { resolveFurnaceMarkerComment } from './furnace-marker.js';
import { type FurnaceOperationContext, recordFurnaceRollbackFailure } from './furnace-operation.js';
import {
  addJarMnEntries,
  removeCustomElementRegistration,
  removeJarMnEntries,
} from './furnace-registration.js';
import {
  createRollbackJournal,
  restoreRollbackJournalOrThrow,
  type RollbackJournal,
  snapshotFile,
} from './furnace-rollback.js';
import { runPostApplyConsistencyChecks } from './furnace-validate-registration.js';

export {
  applyCustomComponent,
  applyOverrideComponent,
  computeComponentChecksums,
  extractComponentChecksums,
  hasComponentChanged,
  hasCustomEngineDrift,
  hasOverrideEngineDrift,
  prefixChecksums,
} from './furnace-apply-helpers.js';

type FurnaceConfigData = Awaited<ReturnType<typeof loadFurnaceConfig>>;
type FurnaceStateData = Awaited<ReturnType<typeof loadFurnaceState>>;
type ApplyAccumulator = ApplyResult & {
  actions?: DryRunAction[];
  rollbackJournal?: RollbackJournal;
};

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

function buildOverrideUndeployActions(
  name: string,
  config: OverrideComponentConfig,
  engineDir: string,
  deletedFiles: string[],
  ftlDir: string
): DryRunAction[] {
  return deletedFiles.map<DryRunAction>((fileName) => ({
    component: name,
    action: 'undeploy-restore',
    target: getOverrideEngineTargetPath(engineDir, config, fileName, ftlDir),
    description: `Restore engine/${
      fileName.endsWith('.ftl') ? `${ftlDir}/${fileName}` : `${config.basePath}/${fileName}`
    } to Firefox baseline`,
  }));
}

async function applyOverrideBatch(
  config: FurnaceConfigData,
  furnacePaths: ReturnType<typeof getFurnacePaths>,
  state: FurnaceStateData,
  engineDir: string,
  ftlDir: string,
  dryRun: boolean,
  result: ApplyAccumulator,
  allActions: DryRunAction[],
  newChecksums: Record<string, string>,
  rollbackJournal?: RollbackJournal,
  componentName?: string
): Promise<void> {
  const overrideEntries = Object.entries(config.overrides).filter(
    ([name]) => !componentName || name === componentName
  );
  const totalOverrides = overrideEntries.length;
  let overrideIndex = 0;
  for (const [name, overrideConfig] of overrideEntries) {
    overrideIndex++;
    if (!dryRun && totalOverrides > 1) {
      info(`Applying override ${name} (${overrideIndex}/${totalOverrides})...`);
    }
    const componentDir = join(furnacePaths.overridesDir, name);

    if (!(await pathExists(componentDir))) {
      addMissingComponentError(result, name, `components/overrides/${name}`);
      continue;
    }

    const previous = extractComponentChecksums(state.appliedChecksums, 'override', name);

    if (!dryRun) {
      const changed = await hasComponentChanged(componentDir, previous);

      if (!changed) {
        // Fast path holds only if the engine still reflects what we deployed.
        // reset/download/manual edits can silently erase engine files; the
        // checksum record alone cannot detect that.
        const cachedEngine = extractComponentChecksums(state.engineChecksums, 'override', name);
        const drifted = await hasOverrideEngineDrift(
          engineDir,
          componentDir,
          overrideConfig,
          ftlDir,
          cachedEngine
        );
        if (!drifted) {
          result.skipped.push({ name, reason: 'No changes since last apply' });
          Object.assign(newChecksums, prefixChecksums(previous, 'override', name));
          continue;
        }
      }
    }

    try {
      const filesAffectedTotal: string[] = [];

      // Compute which files (if any) were removed from the workspace since
      // the last apply. We do this for both dry-run and real runs so the
      // planned-actions output stays honest.
      const currentChecksums = await computeComponentChecksums(componentDir);
      const deletedFiles = diffDeletedFiles(previous, currentChecksums);

      if (dryRun) {
        if (deletedFiles.length > 0) {
          allActions.push(
            ...buildOverrideUndeployActions(name, overrideConfig, engineDir, deletedFiles, ftlDir)
          );
        }
      } else if (deletedFiles.length > 0) {
        const { restored, removed } = await undeployOverrideFiles(
          engineDir,
          overrideConfig,
          deletedFiles,
          ftlDir,
          rollbackJournal
        );
        filesAffectedTotal.push(...restored, ...removed);
      }

      const { affectedPaths: filesAffected, actions } = await applyOverrideComponent(
        engineDir,
        name,
        componentDir,
        overrideConfig,
        ftlDir,
        dryRun,
        rollbackJournal
      );
      if (dryRun && actions) {
        allActions.push(...actions);
      }
      filesAffectedTotal.push(...filesAffected);
      result.applied.push({ name, type: 'override', filesAffected: filesAffectedTotal });

      if (!dryRun) {
        Object.assign(newChecksums, prefixChecksums(currentChecksums, 'override', name));
      }
    } catch (error: unknown) {
      result.errors.push({
        name,
        error: toError(error).message,
      });
    }
  }
}

function buildCustomUndeployActions(
  name: string,
  config: CustomComponentConfig,
  engineDir: string,
  deletedFiles: string[],
  ftlDir: string
): DryRunAction[] {
  const actions: DryRunAction[] = [];
  for (const fileName of deletedFiles) {
    const enginePath = fileName.endsWith('.ftl')
      ? join(engineDir, ftlDir, fileName)
      : join(engineDir, config.targetPath, fileName);
    actions.push({
      component: name,
      action: 'undeploy-remove',
      target: enginePath,
      description: `Remove orphaned ${fileName} from engine`,
    });
  }
  // jar.mn re-sync planned for any custom-file deletion when registered.
  if (config.register && deletedFiles.some((f) => f.endsWith('.mjs') || f.endsWith('.css'))) {
    actions.push({
      component: name,
      action: 'unregister-jar',
      description: `Re-sync ${name} jar.mn entries to drop deleted files`,
    });
  }
  if (config.register && deletedFiles.some((f) => f === `${name}.mjs`)) {
    actions.push({
      component: name,
      action: 'unregister-ce',
      description: `Deregister ${name} from customElements.js (.mjs deleted)`,
    });
  }
  return actions;
}

/**
 * After undeploying deleted files, the in-engine jar.mn and
 * customElements.js still carry entries for the removed files. Re-sync them
 * by removing all of `name`'s jar.mn entries and re-adding only those that
 * still exist in the workspace; if the .mjs itself was deleted, also drop
 * the customElements.js registration. Snapshots are taken under the same
 * journal so the undo path is symmetric with apply.
 */
async function reconcileCustomRegistrationAfterUndeploy(
  engineDir: string,
  name: string,
  config: CustomComponentConfig,
  deletedFiles: string[],
  currentChecksums: Record<string, string>,
  rollbackJournal: RollbackJournal | undefined,
  filesAffected: string[]
): Promise<void> {
  if (!config.register || deletedFiles.length === 0) return;

  const deletedRegistrationFiles = deletedFiles.filter(
    (f) => f.endsWith('.mjs') || f.endsWith('.css')
  );
  if (deletedRegistrationFiles.length === 0) return;

  // jar.mn re-sync. addJarMnEntries is idempotent on duplicates but does not
  // drop stale entries, so we need a remove-then-add cycle. The journal
  // snapshot before each mutation gives us a clean rollback target.
  if (rollbackJournal) {
    await snapshotFile(rollbackJournal, join(engineDir, JAR_MN));
  }
  await removeJarMnEntries(engineDir, name);
  const liveJarFiles = Object.keys(currentChecksums).filter(
    (f) => f.endsWith('.mjs') || f.endsWith('.css')
  );
  if (liveJarFiles.length > 0) {
    // applyCustomComponent has already added live entries; the remove above
    // dropped them too, so re-add now to leave jar.mn in the correct state.
    await addJarMnEntries(engineDir, name, liveJarFiles);
  }
  filesAffected.push(JAR_MN);

  // If the .mjs file itself was deleted, the customElements registration
  // must go too — otherwise we leave a dangling import in the Pattern B
  // block that fails at runtime.
  if (deletedFiles.includes(`${name}.mjs`)) {
    if (rollbackJournal) {
      await snapshotFile(rollbackJournal, join(engineDir, CUSTOM_ELEMENTS_JS));
    }
    await removeCustomElementRegistration(engineDir, name);
    filesAffected.push(CUSTOM_ELEMENTS_JS);
  }
}

async function applyCustomBatch(
  root: string,
  config: FurnaceConfigData,
  furnacePaths: ReturnType<typeof getFurnacePaths>,
  state: FurnaceStateData,
  engineDir: string,
  ftlDir: string,
  dryRun: boolean,
  result: ApplyAccumulator,
  allActions: DryRunAction[],
  newChecksums: Record<string, string>,
  rollbackJournal?: RollbackJournal,
  componentName?: string,
  markerComment?: string
): Promise<void> {
  const allKnown = new Set([
    ...config.stock,
    ...Object.keys(config.overrides),
    ...Object.keys(config.custom),
  ]);

  // Build a set of component names that failed during the override batch so
  // custom components that compose them can be skipped. This includes both
  // hard errors and step-error failures.
  const failedDependencies = new Set<string>();
  for (const entry of result.errors) {
    failedDependencies.add(entry.name);
  }
  for (const entry of result.applied) {
    if (entry.stepErrors && entry.stepErrors.length > 0) {
      failedDependencies.add(entry.name);
    }
  }

  const sortedNames = topologicalSortCustom(config.custom).filter(
    (name) => !componentName || name === componentName
  );
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- names from Object.keys
  const customEntries = sortedNames.map((name) => [name, config.custom[name]!] as const);
  const totalCustom = customEntries.length;
  let customIndex = 0;
  for (const [name, customConfig] of customEntries) {
    customIndex++;
    if (!dryRun && totalCustom > 1) {
      info(`Applying custom component ${name} (${customIndex}/${totalCustom})...`);
    }
    if (customConfig.composes) {
      const missing = customConfig.composes.filter((ref) => !allKnown.has(ref));
      if (missing.length > 0) {
        result.errors.push({
          name,
          error: `Composes unknown component(s): ${missing.join(', ')}. Each reference must be registered as stock, override, or custom.`,
        });
        failedDependencies.add(name);
        continue;
      }

      // Skip this component if any of its composed dependencies failed.
      const failedRefs = customConfig.composes.filter((ref) => failedDependencies.has(ref));
      if (failedRefs.length > 0) {
        result.errors.push({
          name,
          error: `Skipped: composed dependency ${failedRefs.join(', ')} failed to apply.`,
        });
        failedDependencies.add(name);
        continue;
      }
    }

    const componentDir = join(furnacePaths.customDir, name);

    if (!(await pathExists(componentDir))) {
      addMissingComponentError(result, name, `components/custom/${name}`);
      continue;
    }

    const previous = extractComponentChecksums(state.appliedChecksums, 'custom', name);

    if (!dryRun) {
      const changed = await hasComponentChanged(componentDir, previous);

      if (!changed) {
        // As with overrides, the checksum record is not sufficient on its
        // own: a reset/download that cleared the engine must trigger a
        // re-apply even though the workspace is unchanged.
        const drifted = await hasCustomEngineDrift(root, name, componentDir, customConfig, ftlDir);
        if (!drifted) {
          result.skipped.push({ name, reason: 'No changes since last apply' });
          Object.assign(newChecksums, prefixChecksums(previous, 'custom', name));
          continue;
        }
      }
    }

    try {
      const filesAffectedTotal: string[] = [];

      // Diff against previous to find files the developer has deleted from
      // the workspace since last apply. Run for both dry-run and real apply
      // so plan output and execution stay aligned.
      const currentChecksums = await computeComponentChecksums(componentDir);
      const deletedFiles = diffDeletedFiles(previous, currentChecksums);

      if (dryRun) {
        if (deletedFiles.length > 0) {
          allActions.push(
            ...buildCustomUndeployActions(name, customConfig, engineDir, deletedFiles, ftlDir)
          );
        }
      } else if (deletedFiles.length > 0) {
        const removed = await undeployCustomFiles(
          engineDir,
          customConfig,
          deletedFiles,
          ftlDir,
          rollbackJournal
        );
        filesAffectedTotal.push(...removed);
      }

      const {
        affectedPaths: filesAffected,
        stepErrors,
        actions,
      } = await applyCustomComponent(
        engineDir,
        name,
        componentDir,
        customConfig,
        ftlDir,
        dryRun,
        rollbackJournal,
        markerComment !== undefined ? { markerComment } : {}
      );
      if (dryRun && actions) {
        allActions.push(...actions);
      }

      if (!dryRun && deletedFiles.length > 0 && stepErrors.length === 0) {
        await reconcileCustomRegistrationAfterUndeploy(
          engineDir,
          name,
          customConfig,
          deletedFiles,
          currentChecksums,
          rollbackJournal,
          filesAffectedTotal
        );
      }

      filesAffectedTotal.push(...filesAffected);
      result.applied.push({
        name,
        type: 'custom',
        filesAffected: filesAffectedTotal,
        ...(stepErrors.length > 0 ? { stepErrors } : {}),
      });

      // Only store checksums when the component applied without step errors,
      // so that partially failed components are re-applied on the next run.
      if (!dryRun && stepErrors.length === 0) {
        Object.assign(newChecksums, prefixChecksums(currentChecksums, 'custom', name));
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
 * When `options.persistState` is false, the furnace state file is left alone
 * on success and the rollback journal is returned on the result so the caller
 * can restore the engine later (used by `furnace preview` to stage workspace
 * files for Storybook and then roll them back on teardown).
 *
 * @param root - Root directory of the project
 * @param dryRun - If true, enumerate planned actions without writing
 * @param options - Optional behavior flags. `persistState` controls whether
 *   the furnace state file is updated on success (preview teardown sets this
 *   to false to keep ownership of the journal). `operationContext` is the
 *   lifecycle-wrapper hook used by `runFurnaceMutation` so a Ctrl+C mid-apply
 *   can find the in-flight rollback journal.
 * @returns Summary of applied, skipped, and errored components (with actions
 *          when dry-run, and with rollbackJournal when persistState=false)
 */
export async function applyAllComponents(
  root: string,
  dryRun = false,
  options?: {
    persistState?: boolean;
    operationContext?: FurnaceOperationContext;
    componentName?: string;
  }
): Promise<ApplyResult & { actions?: DryRunAction[]; rollbackJournal?: RollbackJournal }> {
  const persistState = options?.persistState ?? true;
  const operationContext = options?.operationContext;
  const config = await loadFurnaceConfig(root);
  const state = await loadFurnaceState(root);
  const { engine: engineDir } = getProjectPaths(root);
  const furnacePaths = getFurnacePaths(root);
  const ftlDir = resolveFtlDir(config.ftlBasePath);
  // 2026-04-26 eval Finding 6: when `markerComment` is unset in
  // fireforge.json, default it to `binaryName.toUpperCase()` so the
  // furnace-emitted edits to upstream files (e.g. customElements.js)
  // carry a marker that satisfies `lintModificationComments` — that
  // rule keys on `${binaryName.toUpperCase()}:` and was firing
  // `[missing-modification-comment]` on every furnace-applied
  // upstream edit because the implicit default was `undefined`. An
  // explicit `markerComment` in fireforge.json still wins.
  const forgeConfig = await loadConfig(root).catch(() => undefined);
  const markerComment = resolveFurnaceMarkerComment(forgeConfig);

  if (!(await pathExists(engineDir))) {
    throw new FurnaceError('Engine directory not found. Run "fireforge download" first.');
  }

  const rollbackJournal = dryRun ? undefined : createRollbackJournal();
  if (rollbackJournal && operationContext) {
    operationContext.registerJournal(rollbackJournal);
  }

  const result: ApplyAccumulator = {
    applied: [],
    skipped: [],
    errors: [],
  };
  const allActions: DryRunAction[] = [];
  const newChecksums: Record<string, string> = {};

  const componentName = options?.componentName;

  // When a single component is requested, validate it exists before running
  // the batch functions (which would silently skip an unknown name).
  if (componentName) {
    const isKnown = componentName in config.overrides || componentName in config.custom;
    if (!isKnown) {
      throw new FurnaceError(
        `Component "${componentName}" not found in furnace.json. Run "fireforge furnace list" to see registered components.`,
        componentName
      );
    }
  }

  await applyOverrideBatch(
    config,
    furnacePaths,
    state,
    engineDir,
    ftlDir,
    dryRun,
    result,
    allActions,
    newChecksums,
    rollbackJournal,
    componentName
  );
  await applyCustomBatch(
    root,
    config,
    furnacePaths,
    state,
    engineDir,
    ftlDir,
    dryRun,
    result,
    allActions,
    newChecksums,
    rollbackJournal,
    componentName,
    markerComment
  );

  // Check for any partial failures (step errors on applied components).
  const hasStepErrors = result.applied.some(
    (entry) => 'stepErrors' in entry && (entry.stepErrors as unknown[]).length > 0
  );

  // Orphaned components are implicitly cleaned up: newChecksums only
  // contains entries for components that still exist in furnace.json,
  // and it fully replaces state.appliedChecksums below.

  if (!dryRun && !hasStepErrors && result.errors.length === 0) {
    await runPostApplyConsistencyChecks(root, config, result, ftlDir);
  }

  // --- Rollback on failure, persist on success (skip for dry-run) ---
  if (!dryRun) {
    if (result.errors.length > 0 || hasStepErrors) {
      if (rollbackJournal) {
        try {
          await restoreRollbackJournalOrThrow(rollbackJournal, 'Furnace apply failed');
          result.rolledBack = true;
        } catch (rollbackError) {
          // Rollback itself failed: the engine is in a partially restored
          // state. Persist a pending-repair marker so the next `fireforge
          // doctor --repair-furnace` run knows to reconcile.
          const failedComponents = result.errors.map((e) => e.name).join(', ');
          await recordFurnaceRollbackFailure(
            root,
            'apply-rollback',
            `failed component(s): ${failedComponents || '(unknown)'}: ${toError(rollbackError).message}`
          );
          throw rollbackError;
        }
      }
    } else if (persistState) {
      // After a successful apply, workspace checksums equal the engine content
      // (we just copied workspace → engine). Store them as engineChecksums so
      // drift detection can compare engine files against the cached hash
      // instead of byte-comparing against workspace sources.
      await updateFurnaceState(root, {
        lastApply: new Date().toISOString(),
        appliedChecksums: newChecksums,
        engineChecksums: { ...newChecksums },
      });
    } else if (rollbackJournal) {
      // Caller owns the journal and will restore on teardown.
      result.rollbackJournal = rollbackJournal;
    }
  }

  if (dryRun) {
    result.actions = allActions;
  }

  return result;
}
