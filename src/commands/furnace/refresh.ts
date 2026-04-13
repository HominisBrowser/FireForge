// SPDX-License-Identifier: EUPL-1.2
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { getProjectPaths, loadConfig, loadState } from '../../core/config.js';
import { getOverrideEngineTargetPath } from '../../core/furnace-apply-helpers.js';
import {
  getFurnacePaths,
  loadFurnaceConfig,
  writeFurnaceConfig,
} from '../../core/furnace-config.js';
import { resolveFtlDir } from '../../core/furnace-constants.js';
import { isComponentSourceFile } from '../../core/furnace-constants.js';
import { recordFurnaceRollbackFailure, runFurnaceMutation } from '../../core/furnace-operation.js';
import { type RefreshFileResult, refreshOverrideFile } from '../../core/furnace-refresh.js';
import {
  createRollbackJournal,
  restoreRollbackJournal,
  restoreRollbackJournalOrThrow,
  snapshotDir,
  snapshotFile,
} from '../../core/furnace-rollback.js';
import { getHead } from '../../core/git.js';
import { FurnaceError } from '../../errors/furnace.js';
import type { FurnaceRefreshOptions } from '../../types/commands/index.js';
import { toError } from '../../utils/errors.js';
import { pathExists } from '../../utils/fs.js';
import {
  formatErrorText,
  formatSuccessText,
  info,
  intro,
  note,
  outro,
  warn,
} from '../../utils/logger.js';

function displayRefreshResults(
  results: RefreshFileResult[],
  name: string,
  currentVersion: string,
  dryRun: boolean
): void {
  const merged = results.filter((r) => r.status === 'merged');
  const conflicts = results.filter((r) => r.status === 'conflict');
  const unchanged = results.filter((r) => r.status === 'unchanged');
  const newFiles = results.filter((r) => r.status === 'new-file');

  for (const r of merged) {
    info(formatSuccessText(`  merged: ${r.fileName}`));
  }
  for (const r of unchanged) {
    info(`  unchanged: ${r.fileName}`);
  }
  for (const r of newFiles) {
    info(`  new file: ${r.fileName}`);
  }

  if (conflicts.length > 0) {
    for (const r of conflicts) {
      info(formatErrorText(`  CONFLICT: ${r.fileName} (${r.conflictMarkers} marker(s))`));
    }
    warn(
      'Conflict markers have been left in the affected files. ' +
        `Resolve them manually, then re-run "fireforge furnace refresh ${name}" to update baseVersion.`
    );
  }

  const summary =
    `${merged.length} merged, ${unchanged.length} unchanged, ` +
    `${newFiles.length} new, ${conflicts.length} conflicts`;

  if (dryRun) {
    note(summary, 'Dry Run Summary');
    outro('Dry run complete (no files modified)');
  } else if (conflicts.length > 0) {
    note(summary, 'Refresh Summary');
    outro('Refresh complete with conflicts — resolve before applying');
  } else {
    note(`${summary}\nbaseVersion updated to ${currentVersion} in furnace.json`, 'Refresh Summary');
    outro('Refresh complete');
  }
}

/**
 * Refreshes a single override component against the current Firefox source.
 * Returns the per-file merge results.
 */
async function refreshSingleOverride(
  projectRoot: string,
  name: string,
  options: FurnaceRefreshOptions = {}
): Promise<{ results: RefreshFileResult[]; currentVersion: string }> {
  const config = await loadFurnaceConfig(projectRoot);
  const paths = getProjectPaths(projectRoot);
  const furnacePaths = getFurnacePaths(projectRoot);
  const ftlDir = resolveFtlDir(config.ftlBasePath);

  // Only overrides can be refreshed
  const overrideConfig = config.overrides[name];
  if (!overrideConfig) {
    throw new FurnaceError(
      `"${name}" is not an override component. Only overrides can be refreshed against upstream.`,
      name
    );
  }

  const overrideDir = join(furnacePaths.overridesDir, name);
  if (!(await pathExists(overrideDir))) {
    throw new FurnaceError(`Override directory not found: components/overrides/${name}`, name);
  }

  const forgeConfig = await loadConfig(projectRoot);
  const currentVersion = forgeConfig.firefox.version;
  const state = await loadState(projectRoot);

  // --reset-base: skip three-way merge and re-snapshot the current engine
  // state as the new baseline. This recovers from unreachable baseCommits
  // (e.g. after history rewrite or re-clone).
  if (options.resetBase) {
    const headCommit = await getHead(paths.engine);
    info(
      `Resetting "${name}" baseline to Firefox ${currentVersion} (${headCommit.slice(0, 8)}). ` +
        'Three-way merge skipped — current workspace content is preserved as-is.'
    );
    if (!options.dryRun) {
      const freshConfig = await loadFurnaceConfig(projectRoot);
      freshConfig.overrides[name] = {
        ...overrideConfig,
        baseVersion: currentVersion,
        baseCommit: headCommit,
      };
      await writeFurnaceConfig(projectRoot, freshConfig);
    }
    return { results: [], currentVersion };
  }

  // Prefer the per-override baseCommit (survives download --force); fall back
  // to the project-wide value for overrides created before this field existed.
  const baseCommit = overrideConfig.baseCommit ?? state.baseCommit;
  if (!baseCommit) {
    throw new FurnaceError(
      'Cannot refresh: baseCommit not found. Re-run "fireforge download" to establish a baseline, ' +
        'or use --reset-base to snapshot the current engine as the new baseline.',
      name
    );
  }

  // If there's no version drift, refreshing is a no-op
  if (overrideConfig.baseVersion === currentVersion) {
    info(`Override "${name}" is already at Firefox ${currentVersion}. Nothing to refresh.`);
    return { results: [], currentVersion };
  }

  info(`Refreshing "${name}": Firefox ${overrideConfig.baseVersion} → ${currentVersion}`);

  // Collect override files
  const entries = await readdir(overrideDir, { withFileTypes: true });
  const overrideFiles = entries.filter((e) => e.isFile() && isComponentSourceFile(e.name));

  if (overrideFiles.length === 0) {
    info('No source files to refresh.');
    return { results: [], currentVersion };
  }

  const dryRun = options.dryRun ?? false;
  const strategy = options.strategy;

  // Run all merges within a transactional mutation so failures can be rolled back
  const results: RefreshFileResult[] = await runFurnaceMutation(
    projectRoot,
    'refresh-rollback',
    async (ctx) => {
      const journal = createRollbackJournal();
      ctx.registerJournal(journal);

      try {
        const fileResults: RefreshFileResult[] = [];

        if (!dryRun) {
          // Snapshot all override files before mutation
          await snapshotDir(journal, overrideDir);
          await snapshotFile(journal, furnacePaths.furnaceConfig);
        }

        for (const entry of overrideFiles) {
          const overridePath = join(overrideDir, entry.name);
          const engineRelPath = getOverrideEngineTargetPath(
            paths.engine,
            overrideConfig,
            entry.name,
            ftlDir
          ).slice(paths.engine.length + 1);

          const result = await refreshOverrideFile(
            paths.engine,
            overridePath,
            engineRelPath,
            baseCommit,
            entry.name,
            dryRun,
            strategy
          );
          fileResults.push(result);
        }

        // Update baseVersion and baseCommit on clean merge (not dry-run, no conflicts)
        const hasConflicts = fileResults.some((r) => r.status === 'conflict');
        if (!dryRun && !hasConflicts) {
          // Re-load config to pick up any concurrent changes from a prior override
          // in a batch refresh.
          const freshConfig = await loadFurnaceConfig(projectRoot);
          freshConfig.overrides[name] = {
            ...overrideConfig,
            baseVersion: currentVersion,
            baseCommit: await getHead(paths.engine),
          };
          await writeFurnaceConfig(projectRoot, freshConfig);
        }

        return fileResults;
      } catch (error: unknown) {
        if (!dryRun) {
          try {
            await restoreRollbackJournalOrThrow(journal, `Failed to refresh override "${name}"`);
          } catch (rollbackError) {
            await recordFurnaceRollbackFailure(
              projectRoot,
              'refresh-rollback',
              toError(rollbackError).message
            );
            throw rollbackError;
          }
        }
        throw error;
      }
    },
    { dryRun }
  );

  return { results, currentVersion };
}

/**
 * Runs the furnace refresh command to merge upstream Firefox changes into
 * an override component using three-way merge.
 *
 * @param projectRoot - Root directory of the project
 * @param name - Component tag name to refresh (omit when using --all)
 * @param options - Command options
 */
export async function furnaceRefreshCommand(
  projectRoot: string,
  name: string | undefined,
  options: FurnaceRefreshOptions = {}
): Promise<void> {
  const refreshAll = options.all ?? false;

  if (!name && !refreshAll) {
    throw new FurnaceError('Specify a component name or use --all to refresh every override.');
  }

  if (name && refreshAll) {
    throw new FurnaceError('Cannot specify both a component name and --all. Use one or the other.');
  }

  // Verify engine exists — refresh reads engine files for three-way merge
  // and --reset-base reads engine HEAD. Without this check, the user gets
  // an obscure git error instead of a clear precondition message.
  const paths = getProjectPaths(projectRoot);
  if (!(await pathExists(paths.engine))) {
    throw new FurnaceError('Engine directory not found. Run "fireforge download" first.');
  }

  const dryRun = options.dryRun ?? false;

  if (name) {
    intro('Furnace Refresh');
    if (dryRun) {
      info('Dry run — showing what would change without modifying files.');
    }
    const { results, currentVersion } = await refreshSingleOverride(projectRoot, name, options);
    if (results.length > 0) {
      displayRefreshResults(results, name, currentVersion, dryRun);
    } else {
      outro('Done');
    }
    return;
  }

  // --all mode: refresh every override sequentially
  intro('Furnace Refresh (all overrides)');
  if (dryRun) {
    info('Dry run — showing what would change without modifying files.');
  }

  const config = await loadFurnaceConfig(projectRoot);
  const overrideNames = Object.keys(config.overrides);

  if (overrideNames.length === 0) {
    info('No overrides to refresh.');
    outro('Done');
    return;
  }

  let totalMerged = 0;
  let totalConflicts = 0;
  let totalUnchanged = 0;
  let totalSkipped = 0;
  const conflictComponents: string[] = [];

  // Snapshot furnace.json before the batch loop so an unexpected failure
  // (process crash, unhandled error) can be recovered from. Per-component
  // errors caught below are expected and do not trigger a restore — only
  // an error that escapes the loop entirely warrants rolling back.
  const batchJournal = dryRun ? undefined : createRollbackJournal();
  if (batchJournal) {
    const furnacePaths = getFurnacePaths(projectRoot);
    await snapshotFile(batchJournal, furnacePaths.furnaceConfig);
  }

  try {
    for (const overrideName of overrideNames) {
      try {
        const { results } = await refreshSingleOverride(projectRoot, overrideName, options);
        if (results.length === 0) {
          totalSkipped++;
          continue;
        }
        for (const r of results) {
          if (r.status === 'merged') totalMerged++;
          else if (r.status === 'conflict') {
            totalConflicts++;
            if (!conflictComponents.includes(overrideName)) {
              conflictComponents.push(overrideName);
            }
          } else if (r.status === 'unchanged') totalUnchanged++;
        }
      } catch (error: unknown) {
        warn(`${overrideName}: ${toError(error).message}`);
      }
    }
  } catch (error: unknown) {
    // Unexpected batch-level failure: restore furnace.json to its
    // pre-batch state so the config is not left partially updated.
    if (batchJournal) {
      await restoreRollbackJournal(batchJournal);
    }
    throw error;
  }

  const summary =
    `${overrideNames.length} override(s) processed, ${totalSkipped} already up-to-date\n` +
    `${totalMerged} file(s) merged, ${totalUnchanged} unchanged, ${totalConflicts} conflict(s)`;

  if (conflictComponents.length > 0) {
    warn(
      `Conflicts in: ${conflictComponents.join(', ')}. ` +
        'Resolve conflict markers, then re-run refresh for those components to update baseVersion.'
    );
  }

  note(summary, dryRun ? 'Dry Run Summary' : 'Refresh Summary');
  outro(dryRun ? 'Dry run complete' : 'Refresh complete');
}
