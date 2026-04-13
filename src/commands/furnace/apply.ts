// SPDX-License-Identifier: EUPL-1.2
import { type FSWatcher, watch as fsWatch } from 'node:fs';

import { getProjectPaths, loadConfig } from '../../core/config.js';
import { applyAllComponents, computeComponentChecksums } from '../../core/furnace-apply.js';
import { logApplyResult } from '../../core/furnace-apply-output.js';
import {
  furnaceConfigExists,
  getFurnacePaths,
  loadFurnaceConfig,
} from '../../core/furnace-config.js';
import { isComponentSourceFile } from '../../core/furnace-constants.js';
import { runFurnaceMutation } from '../../core/furnace-operation.js';
import {
  findOverrideBaseVersionDrift,
  formatOverrideBaseVersionDriftError,
  formatOverrideBaseVersionDriftWarning,
} from '../../core/furnace-version-drift.js';
import { FurnaceError } from '../../errors/furnace.js';
import type { FurnaceApplyOptions } from '../../types/commands/index.js';
import { pathExists } from '../../utils/fs.js';
import { info, intro, outro, spinner, warn } from '../../utils/logger.js';

/** Interval (ms) for the periodic checksum poll that catches events missed by fs.watch. */
const WATCH_POLL_INTERVAL_MS = 30_000;

/**
 * Collects a combined checksum snapshot across all watched directories.
 */
async function snapshotWatchedChecksums(watchDirs: string[]): Promise<Map<string, string>> {
  const combined = new Map<string, string>();
  for (const dir of watchDirs) {
    try {
      const checksums = await computeComponentChecksums(dir);
      for (const [file, hash] of Object.entries(checksums)) {
        combined.set(`${dir}/${file}`, hash);
      }
    } catch {
      // Directory may have been removed between iterations — ignore.
    }
  }
  return combined;
}

function checksumMapsEqual(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
}

async function runWatchLoop(projectRoot: string): Promise<void> {
  const furnacePaths = getFurnacePaths(projectRoot);
  const watchDirs: string[] = [];
  if (await pathExists(furnacePaths.overridesDir)) watchDirs.push(furnacePaths.overridesDir);
  if (await pathExists(furnacePaths.customDir)) watchDirs.push(furnacePaths.customDir);

  if (watchDirs.length === 0) {
    info('No component directories to watch.');
    return;
  }

  if (process.platform === 'linux') {
    warn(
      'Watch mode uses fs.watch with recursive: true, which may miss changes ' +
        'in deeply nested directories on Linux. A periodic poll runs every 30s as a fallback.'
    );
  }

  info(`Watching ${watchDirs.length} directory(ies) for changes... (Ctrl+C to stop)`);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let applyInFlight = false;
  let lastChecksums = await snapshotWatchedChecksums(watchDirs);

  const triggerApply = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (applyInFlight) return;
      applyInFlight = true;
      void (async () => {
        try {
          info('\nChange detected — re-applying...');
          const result = await runFurnaceMutation(projectRoot, 'apply-rollback', (ctx) =>
            applyAllComponents(projectRoot, false, { operationContext: ctx })
          );
          logApplyResult(result, false);
          const applied = result.applied.length;
          const skipped = result.skipped.length;
          info(`Re-applied: ${applied} applied, ${skipped} skipped`);
        } catch (err: unknown) {
          warn(`Apply failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          applyInFlight = false;
          // Update checksums after apply so the next poll does not re-trigger.
          lastChecksums = await snapshotWatchedChecksums(watchDirs);
        }
      })();
    }, 300);
  };

  // Register signal-driven cleanup BEFORE creating watchers so there is no
  // race window where a SIGINT could arrive after watchers exist but before
  // cleanup handlers are registered.
  const watchers: FSWatcher[] = [];
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  const cleanup = (): void => {
    for (const w of watchers) w.close();
    if (debounceTimer) clearTimeout(debounceTimer);
    if (pollTimer) clearInterval(pollTimer);
  };
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);

  for (const dir of watchDirs) {
    const watcher = fsWatch(dir, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      if (isComponentSourceFile(filename)) {
        triggerApply();
      }
    });
    watcher.on('error', (err) => {
      warn(`Watcher error on ${dir}: ${err.message}. Periodic poll will continue as fallback.`);
    });
    watchers.push(watcher);
  }

  // Periodic checksum-based poll to catch events missed by fs.watch (known
  // issue on Linux with recursive: true and certain filesystems).
  pollTimer = setInterval(() => {
    if (applyInFlight) return;
    void (async () => {
      try {
        const current = await snapshotWatchedChecksums(watchDirs);
        if (!checksumMapsEqual(current, lastChecksums)) {
          triggerApply();
        }
      } catch {
        // Best effort — errors here are transient filesystem issues.
      }
    })();
  }, WATCH_POLL_INTERVAL_MS);

  // Block until signal. The cleanup function registered above closes all
  // watchers when SIGINT/SIGTERM arrives. The finally block is a safety net
  // in case the Promise settles through some other path.
  try {
    await new Promise<void>(() => {});
  } finally {
    cleanup();
    process.removeListener('SIGINT', cleanup);
    process.removeListener('SIGTERM', cleanup);
  }
}

/**
 * Runs the furnace apply command to apply components to the engine.
 * @param projectRoot - Root directory of the project
 * @param name - Optional component name to apply a single component
 * @param options - Apply options
 */
export async function furnaceApplyCommand(
  projectRoot: string,
  name?: string,
  options: FurnaceApplyOptions = {}
): Promise<void> {
  intro(name ? `Furnace Apply (${name})` : 'Furnace Apply');

  // Verify engine exists
  const paths = getProjectPaths(projectRoot);
  if (!(await pathExists(paths.engine))) {
    throw new FurnaceError('Engine directory not found. Run "fireforge download" first.');
  }

  // Load furnace config
  if (!(await furnaceConfigExists(projectRoot))) {
    throw new FurnaceError(
      'No furnace.json found. Run "fireforge furnace create" or "fireforge furnace override" to get started.'
    );
  }

  const config = await loadFurnaceConfig(projectRoot);

  const overrideCount = Object.keys(config.overrides).length;
  const customCount = Object.keys(config.custom).length;

  if (overrideCount === 0 && customCount === 0) {
    info('No components to apply.');
    outro('Done');
    return;
  }

  // Warn on baseVersion drift before mutating the engine. This is advisory
  // only: apply continues, because a silent divergence is worse than a
  // noisy one and the operator is the only authority on whether the
  // upstream component has actually changed shape.
  const forgeConfig = await loadConfig(projectRoot);
  const driftEntries = findOverrideBaseVersionDrift(config, forgeConfig.firefox.version);
  for (const entry of driftEntries) {
    warn(formatOverrideBaseVersionDriftWarning(entry));
  }

  const dryRun = options.dryRun ?? false;
  const force = options.force ?? false;
  if (!force && driftEntries.length > 0) {
    throw new FurnaceError(formatOverrideBaseVersionDriftError(driftEntries));
  }

  const applySpinner = dryRun ? undefined : spinner('Applying components to engine...');

  const result = await runFurnaceMutation(
    projectRoot,
    'apply-rollback',
    (ctx) =>
      applyAllComponents(projectRoot, dryRun, {
        operationContext: ctx,
        ...(name !== undefined ? { componentName: name } : {}),
      }),
    { dryRun }
  );

  if (applySpinner) {
    applySpinner.stop('Components applied');
  }

  logApplyResult(result, dryRun);

  const appliedWithStepErrorsCount = dryRun
    ? 0
    : result.applied.filter((entry) => (entry.stepErrors?.length ?? 0) > 0).length;
  const totalApplyFailures = result.errors.length + appliedWithStepErrorsCount;

  if (totalApplyFailures > 0) {
    throw new FurnaceError(
      `${totalApplyFailures} component${totalApplyFailures === 1 ? '' : 's'} failed to apply cleanly`
    );
  }

  const appliedCount = result.applied.length;
  const skippedCount = result.skipped.length;

  if (dryRun) {
    outro(`Dry run complete — would apply ${appliedCount}, skip ${skippedCount}`);
  } else {
    outro(`Applied ${appliedCount}, skipped ${skippedCount}`);
  }

  // Watch mode: re-apply on file changes in component directories
  if (options.watch && !dryRun) {
    await runWatchLoop(projectRoot);
  }
}
