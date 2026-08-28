// SPDX-License-Identifier: EUPL-1.2
import { type FSWatcher, watch as fsWatch } from 'node:fs';

import { loadConfig } from '../../core/config.js';
import { applyAllComponents, computeComponentChecksums } from '../../core/furnace-apply.js';
import { logApplyResult } from '../../core/furnace-apply-output.js';
import { getFurnacePaths } from '../../core/furnace-config.js';
import { isComponentSourceFile } from '../../core/furnace-constants.js';
import { runFurnaceMutation, waitLockMutationOptions } from '../../core/furnace-operation.js';
import { assertFurnaceReady } from '../../core/furnace-precondition.js';
import {
  getPersistableAppliedEntry,
  persistSingleComponentState,
  shouldPersistSingleComponentState,
} from '../../core/furnace-state-persist.js';
import { countEntriesWithBlockingStepErrors } from '../../core/furnace-step-errors.js';
import {
  findOverrideBaseVersionDrift,
  formatOverrideBaseVersionDriftError,
  formatOverrideBaseVersionDriftWarning,
} from '../../core/furnace-version-drift.js';
import { FurnaceError } from '../../errors/furnace.js';
import type { FurnaceApplyOptions } from '../../types/commands/index.js';
import { getNodeErrorCode, toError } from '../../utils/errors.js';
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

/**
 * Builds a watch-loop apply-failure message tailored to the error class so
 * transient filesystem errors (EACCES, ENOSPC, lock timeout) look different
 * from genuine apply-level failures; the previous generic "Apply failed: ..."
 * collapsed all causes into one string and made diagnosis difficult.
 */
function classifyWatchApplyError(err: unknown): string {
  const message = toError(err).message;
  if (err instanceof FurnaceError) {
    return `Apply failed: ${message}`;
  }
  const code = getNodeErrorCode(err);
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return `Apply failed: permission denied — ${message}`;
    case 'ENOSPC':
      return `Apply failed: disk full — ${message}`;
    case 'EBUSY':
    case 'ETXTBSY':
      return `Apply failed: file is in use — ${message}`;
    case 'ENOENT':
      return `Apply failed: missing file — ${message}`;
    case 'ETIMEDOUT':
      return `Apply failed: operation timed out — ${message}`;
    default:
      return `Apply failed: ${message}`;
  }
}

async function runWatchLoop(projectRoot: string): Promise<void> {
  const furnacePaths = getFurnacePaths(projectRoot);
  // Both categories are eligible targets. The set is fixed; only existence
  // varies over time — a component dir created AFTER watch started (the user
  // running `furnace create` in another terminal) must be picked up without
  // restarting watch. A one-shot `pathExists` check at startup captures only
  // the dirs that existed then, leaving any later creation invisible.
  const candidateDirs = [furnacePaths.overridesDir, furnacePaths.customDir];
  const watchDirs: string[] = [];
  const watchers = new Map<string, FSWatcher>();

  if (process.platform === 'linux') {
    warn(
      'Watch mode uses fs.watch with recursive: true, which may miss changes ' +
        'in deeply nested directories on Linux. A periodic poll runs every 30s as a fallback.'
    );
  }

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let applyInFlight = false;
  // Coalesces changes that arrive while an apply is running. Without this
  // flag, a second edit during an in-flight apply is debounced, the timer
  // fires while applyInFlight is true, and the change is dropped entirely
  // because the post-apply checksum snapshot already reflects the edit so
  // the 30s poll also sees no diff.
  let pendingChange = false;
  let lastChecksums = new Map<string, string>();
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const runApplyCycle = async (): Promise<void> => {
    applyInFlight = true;
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
      warn(classifyWatchApplyError(err));
    } finally {
      applyInFlight = false;
      // Update checksums after apply so the next poll does not re-trigger
      // for changes that are already reflected in the engine.
      lastChecksums = await snapshotWatchedChecksums(watchDirs);
    }

    // Another change arrived while we were applying — run again so the edit
    // is not silently absorbed into the post-apply checksum bump.
    if (pendingChange) {
      pendingChange = false;
      await runApplyCycle();
    }
  };

  const triggerApply = (): void => {
    if (applyInFlight) {
      // An apply is already running; record the change so runApplyCycle
      // re-runs after it completes. Do not schedule a new debounce: the
      // in-flight apply will observe this flag when it finishes.
      pendingChange = true;
      return;
    }
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (applyInFlight) {
        // Race with a change that started its own apply between the debounce
        // scheduling and the timer firing. Record the pending change; the
        // in-flight apply will pick it up.
        pendingChange = true;
        return;
      }
      void runApplyCycle();
    }, 300);
  };

  const installWatcher = (dir: string): boolean => {
    if (watchers.has(dir)) return false;
    try {
      const watcher = fsWatch(dir, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        if (isComponentSourceFile(filename)) {
          triggerApply();
        }
      });
      watcher.on('error', (err) => {
        warn(`Watcher error on ${dir}: ${err.message}. Periodic poll will continue as fallback.`);
      });
      watchers.set(dir, watcher);
      watchDirs.push(dir);
      return true;
    } catch (err: unknown) {
      // Directory vanished between the pathExists check and fs.watch, or
      // fs.watch otherwise refused. refreshWatchers will retry on the next
      // poll tick.
      warn(`Could not start watcher on ${dir}: ${toError(err).message}`);
      return false;
    }
  };

  // Scans candidate dirs for ones we are not yet watching and installs a
  // watcher for each that now exists. Returns true when at least one new
  // watcher was installed so the caller can trigger an apply cycle for
  // the just-noticed content.
  const refreshWatchers = async (): Promise<boolean> => {
    let added = false;
    for (const dir of candidateDirs) {
      if (watchers.has(dir)) continue;
      if (await pathExists(dir)) {
        if (installWatcher(dir)) {
          info(`Now watching ${dir}`);
          added = true;
        }
      }
    }
    return added;
  };

  // Register signal-driven cleanup BEFORE creating watchers so there is no
  // race window where a SIGINT could arrive after watchers exist but before
  // cleanup handlers are registered.
  const cleanup = (): void => {
    for (const w of watchers.values()) w.close();
    if (debounceTimer) clearTimeout(debounceTimer);
    if (pollTimer) clearInterval(pollTimer);
  };
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);

  await refreshWatchers();
  lastChecksums = await snapshotWatchedChecksums(watchDirs);

  if (watchDirs.length === 0) {
    info(
      'No component directories exist yet — will retry every 30s. Create one with "fireforge furnace override" or "fireforge furnace create" in another terminal to begin watching.'
    );
  } else {
    info(`Watching ${watchDirs.length} directory(ies) for changes... (Ctrl+C to stop)`);
  }

  // Periodic checksum-based poll that also picks up newly-created component
  // dirs (fs.watch was not installed for them at startup because they did
  // not yet exist).
  pollTimer = setInterval(() => {
    if (applyInFlight) return;
    void (async () => {
      try {
        const added = await refreshWatchers();
        if (added) {
          lastChecksums = await snapshotWatchedChecksums(watchDirs);
          triggerApply();
          return;
        }
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

  const { config } = await assertFurnaceReady(projectRoot);

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
    async (ctx) => {
      // `persistState: false` for a NAMED apply is load-bearing: the batch
      // persist path replaces `appliedChecksums` wholesale with only this
      // run's entries, and the batch loops filter to the named component —
      // so routing a named apply through it persists a state file containing
      // ONLY that component, wiping every other component's checksums.
      // Orphan detection and deleted-file undeploy both key on that state,
      // so the wiped components' stale engine files become invisible to
      // apply AND to `furnace validate`. Named apply merges per-component
      // state below, exactly like `furnace deploy <name>`.
      const applyResult = await applyAllComponents(projectRoot, dryRun, {
        operationContext: ctx,
        ...(name !== undefined ? { componentName: name, persistState: false } : {}),
      });

      if (name !== undefined && shouldPersistSingleComponentState(applyResult, dryRun)) {
        await persistSingleComponentState(
          projectRoot,
          getPersistableAppliedEntry('Apply', name, applyResult.applied[0]),
          getFurnacePaths(projectRoot)
        );
      }

      return applyResult;
    },
    { dryRun, ...waitLockMutationOptions(options.waitLockSeconds) }
  );

  if (applySpinner) {
    applySpinner.stop('Components applied');
  }

  logApplyResult(result, dryRun);

  const appliedWithStepErrorsCount = dryRun
    ? 0
    : countEntriesWithBlockingStepErrors(result.applied);
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
