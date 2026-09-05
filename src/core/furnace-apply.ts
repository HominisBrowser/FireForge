// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { FurnaceError } from '../errors/furnace.js';
import type {
  ApplyResult,
  CustomComponentConfig,
  DryRunAction,
  FurnaceConfig,
  FurnaceState,
} from '../types/furnace.js';
import { assert } from '../utils/assert.js';
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
  hasComponentChanged,
  hasCustomEngineDrift,
  hasOverrideEngineDrift,
  prefixChecksums,
  undeployCustomFiles,
  undeployOverrideFiles,
} from './furnace-apply-helpers.js';
import {
  findPatchOwnedOverwrites,
  loadPatchClaimsForApply,
  recordOverwriteWarnings,
} from './furnace-apply-overwrite-warn.js';
import {
  buildCustomUndeployActions,
  buildOverrideUndeployActions,
} from './furnace-apply-undeploy-actions.js';
import type { FurnacePaths } from './furnace-config.js';
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
import { assertFurnaceEngineDirReady } from './furnace-precondition.js';
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
import { blockingStepErrors, hasBlockingStepErrors } from './furnace-step-errors.js';
import { runPostApplyConsistencyChecks } from './furnace-validate-registration.js';

export { computeComponentChecksums, prefixChecksums } from './furnace-apply-helpers.js';

/**
 * Records one component's checksums into the run-wide accumulator, under the
 * flattened `type/name/file` keys the state file stores. A Map keeps the
 * accumulation explicit — the previous `Object.assign` merges read as if they
 * replaced the accumulator rather than adding to it.
 */
function recordComponentChecksums(
  accumulator: Map<string, string>,
  checksums: Record<string, string>,
  type: string,
  name: string
): void {
  for (const [key, value] of Object.entries(prefixChecksums(checksums, type, name))) {
    accumulator.set(key, value);
  }
}

type FurnaceConfigData = FurnaceConfig;
type FurnaceStateData = FurnaceState;
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

async function applyOverrideBatch(ctx: ApplyBatchContext): Promise<void> {
  const { config, furnacePaths, state, engineDir, ftlDir, dryRun } = ctx;
  const { result, allActions, newChecksums, rollbackJournal, componentName } = ctx;
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
    const currentChecksums = await computeComponentChecksums(componentDir);

    if (!dryRun) {
      const changed = await hasComponentChanged(componentDir, previous, currentChecksums);

      if (!changed) {
        // Fast path holds only if the engine still reflects what we deployed.
        // reset/download/manual edits can silently erase engine files; the
        // checksum record alone cannot detect that.
        const cachedEngine = extractComponentChecksums(state.engineChecksums, 'override', name);
        const drifted = await hasOverrideEngineDrift(
          { engineDir, componentDir, ftlDir },
          overrideConfig,
          cachedEngine
        );
        if (!drifted) {
          result.skipped.push({ name, reason: 'No changes since last apply' });
          recordComponentChecksums(newChecksums, previous, 'override', name);
          continue;
        }
      }
    }

    try {
      const filesAffectedTotal: string[] = [];

      // Compute which files (if any) were removed from the workspace since
      // the last apply. We do this for both dry-run and real runs so the
      // planned-actions output stays honest.
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

      if (!dryRun) {
        // Runs unconditionally — including when the component source
        // changed — because the lost-work case is precisely a deployed
        // engine edit that the incoming copy is about to replace.
        recordOverwriteWarnings(
          result,
          await findPatchOwnedOverwrites({
            type: 'override',
            engineDir,
            name,
            componentDir,
            config: overrideConfig,
            ftlDir,
            patchClaims: ctx.patchClaims,
          })
        );
      }

      const { affectedPaths: filesAffected, actions } = await applyOverrideComponent(
        { engineDir, name, componentDir, ftlDir },
        overrideConfig,
        dryRun,
        rollbackJournal
      );
      if (dryRun && actions) {
        allActions.push(...actions);
      }
      filesAffectedTotal.push(...filesAffected);
      result.applied.push({ name, type: 'override', filesAffected: filesAffectedTotal });

      if (!dryRun) {
        recordComponentChecksums(newChecksums, currentChecksums, 'override', name);
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
 * After undeploying deleted files, the in-engine jar.mn and
 * customElements.js still carry entries for the removed files. Re-sync them
 * by removing all of `name`'s jar.mn entries and re-adding only those that
 * still exist in the workspace; if the .mjs itself was deleted, also drop
 * the customElements.js registration. Snapshots are taken under the same
 * journal so the undo path is symmetric with apply.
 */
async function reconcileCustomRegistrationAfterUndeploy(args: {
  engineDir: string;
  name: string;
  config: CustomComponentConfig;
  deletedFiles: string[];
  currentChecksums: Record<string, string>;
  rollbackJournal: RollbackJournal | undefined;
  /** Mutated: receives every engine path this reconciliation touched. */
  filesAffected: string[];
}): Promise<void> {
  const {
    engineDir,
    name,
    config,
    deletedFiles,
    currentChecksums,
    rollbackJournal,
    filesAffected,
  } = args;
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
  ctx: ApplyBatchContext,
  root: string,
  markerComment?: string
): Promise<void> {
  const { config, furnacePaths, state, engineDir, ftlDir, dryRun } = ctx;
  const { result, allActions, newChecksums, rollbackJournal, componentName } = ctx;
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
    const currentChecksums = await computeComponentChecksums(componentDir);

    if (!dryRun) {
      const changed = await hasComponentChanged(componentDir, previous, currentChecksums);

      if (!changed) {
        // As with overrides, the checksum record is not sufficient on its
        // own: a reset/download that cleared the engine must trigger a
        // re-apply even though the workspace is unchanged.
        const drifted = await hasCustomEngineDrift(
          { root, name, componentDir, ftlDir },
          customConfig
        );
        if (!drifted) {
          result.skipped.push({ name, reason: 'No changes since last apply' });
          recordComponentChecksums(newChecksums, previous, 'custom', name);
          continue;
        }
      }
    }

    try {
      const filesAffectedTotal: string[] = [];

      // Diff against previous to find files the developer has deleted from
      // the workspace since last apply. Run for both dry-run and real apply
      // so plan output and execution stay aligned.
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

      if (!dryRun) {
        // Runs unconditionally — the `changed === true` path used to skip
        // drift detection entirely, which is exactly when a deployed
        // engine-only fix gets silently replaced (J6).
        recordOverwriteWarnings(
          result,
          await findPatchOwnedOverwrites({
            type: 'custom',
            root,
            name,
            config: customConfig,
            ftlDir,
            patchClaims: ctx.patchClaims,
          })
        );
      }

      const {
        affectedPaths: filesAffected,
        stepErrors,
        actions,
      } = await applyCustomComponent(
        { engineDir, name, componentDir, ftlDir },
        customConfig,
        dryRun,
        rollbackJournal,
        markerComment !== undefined ? { markerComment } : {}
      );
      if (dryRun && actions) {
        allActions.push(...actions);
      }

      if (!dryRun && deletedFiles.length > 0 && blockingStepErrors(stepErrors).length === 0) {
        await reconcileCustomRegistrationAfterUndeploy({
          engineDir,
          name,
          config: customConfig,
          deletedFiles,
          currentChecksums,
          rollbackJournal,
          filesAffected: filesAffectedTotal,
        });
      }

      filesAffectedTotal.push(...filesAffected);
      result.applied.push({
        name,
        type: 'custom',
        filesAffected: filesAffectedTotal,
        ...(stepErrors.length > 0 ? { stepErrors } : {}),
      });

      // Only store checksums when the component applied without BLOCKING
      // step errors, so that partially failed components are re-applied on
      // the next run. Advisory errors (FTL degradation) still persist —
      // re-applying cannot fix a fork that has no locale jar.mn.
      if (!dryRun && blockingStepErrors(stepErrors).length === 0) {
        recordComponentChecksums(newChecksums, currentChecksums, 'custom', name);
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
 * Result of {@link applyAllComponents}.
 *
 * Named so consumers can refer to the shape directly instead of going
 * through `Awaited<ReturnType<typeof applyAllComponents>>`.
 *
 * `actions` is populated only on a dry run; `rollbackJournal` only when
 * `persistState: false` hands journal ownership back to the caller.
 */
export type ApplyAllComponentsResult = ApplyResult & {
  actions?: DryRunAction[];
  rollbackJournal?: RollbackJournal;
};

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
): Promise<ApplyAllComponentsResult> {
  const persistState = options?.persistState ?? true;
  const operationContext = options?.operationContext;
  const config = await loadFurnaceConfig(root);
  const state = await loadFurnaceState(root);
  const { engine: engineDir } = getProjectPaths(root);
  const furnacePaths = getFurnacePaths(root);
  const ftlDir = resolveFtlDir(config.ftlBasePath);
  // When `markerComment` is unset in fireforge.json, default it to
  // `binaryName.toUpperCase()` so the furnace-emitted edits to upstream
  // files (e.g. customElements.js) carry a marker that satisfies
  // `lintModificationComments` — that rule keys on
  // `${binaryName.toUpperCase()}:`. An explicit `markerComment` still wins.
  const forgeConfig = await loadConfig(root).catch(() => undefined);
  const markerComment = resolveFurnaceMarkerComment(forgeConfig);

  await assertFurnaceEngineDirReady(engineDir);

  const rollbackJournal = dryRun ? undefined : createRollbackJournal();
  if (rollbackJournal && operationContext) {
    operationContext.registerJournal(rollbackJournal);
  }

  // Everything below this line can write to the engine. A real apply that
  // reached it without a journal would have no way back — neither the
  // lifecycle wrapper's throw path nor the signal handler can restore what
  // was never captured. `operationContext` is legitimately absent for the
  // few callers that drive apply outside the wrapper, so the invariant is on
  // the journal itself.
  assert(dryRun || rollbackJournal !== undefined, 'rollback journal created before a real apply');

  const result: ApplyAccumulator = {
    applied: [],
    skipped: [],
    errors: [],
  };
  const allActions: DryRunAction[] = [];
  const newChecksums = new Map<string, string>();

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

  // Patch-claim map for the overwrite warning: loaded once per
  // apply. A missing/unreadable manifest degrades to an empty map — the
  // warning is advisory and must never block the apply.
  const patchClaims = await loadPatchClaimsForApply(root);

  const batchContext: ApplyBatchContext = {
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
    patchClaims,
  };
  await applyOverrideBatch(batchContext);
  await applyCustomBatch(batchContext, root, markerComment);

  // Check for any partial failures (blocking step errors on applied
  // components). Advisory step errors (e.g. FTL degradation) are warnings
  // and never gate rollback.
  const hasApplyStepErrors = result.applied.some((entry) => hasBlockingStepErrors(entry));

  // Orphaned components are implicitly cleaned up: newChecksums only
  // contains entries for components that still exist in furnace.json,
  // and it fully replaces state.appliedChecksums below.

  if (!dryRun && !hasApplyStepErrors && result.errors.length === 0) {
    await runPostApplyConsistencyChecks(root, config, result, ftlDir);
  }

  // Recompute AFTER the consistency checks: they MUTATE entry.stepErrors
  // when the applied output is inconsistent (e.g. a jar.mn entry that
  // silently mis-landed). Reading the pre-check snapshot lets those failures
  // skip rollback and persist checksums for a component known to be
  // inconsistent, while the CLI simultaneously reports "failed to apply
  // cleanly".
  const hasStepErrors = result.applied.some((entry) => hasBlockingStepErrors(entry));

  // --- Rollback on failure, persist on success (skip for dry-run) ---
  if (!dryRun) {
    if (result.errors.length > 0 || hasStepErrors) {
      if (rollbackJournal) {
        // This branch owns the rollback for the collected-errors case, so the
        // lifecycle wrapper must not restore the same journal again if the
        // restore below throws on its way out.
        operationContext?.markRolledBack();
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
        appliedChecksums: Object.fromEntries(newChecksums),
        engineChecksums: Object.fromEntries(newChecksums),
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
} /**
 * Shared context threaded through the batch apply loops. Bundles the state
 * both loops mutate (result/actions/checksums) with the immutable run
 * parameters; the 12–13 positional parameters this replaced let call sites
 * drift and made every new parameter a two-signature change.
 */
interface ApplyBatchContext {
  config: FurnaceConfigData;
  furnacePaths: FurnacePaths;
  state: FurnaceStateData;
  engineDir: string;
  ftlDir: string;
  dryRun: boolean;
  /** Mutated by both loops: results, dry-run actions, run checksums. */
  result: ApplyAccumulator;
  allActions: DryRunAction[];
  newChecksums: Map<string, string>;
  rollbackJournal?: RollbackJournal | undefined;
  componentName?: string | undefined;
  /** File → owning patch filenames, for the overwrite warning. */
  patchClaims: ReadonlyMap<string, readonly string[]>;
}
