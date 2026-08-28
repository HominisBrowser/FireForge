// SPDX-License-Identifier: EUPL-1.2
import { confirm, multiselect, select } from '@clack/prompts';

import { stdioIsInteractive } from '../../core/destructive.js';
import {
  ensureFurnaceConfig,
  furnaceConfigExists,
  getFurnacePaths,
  loadFurnaceConfig,
  writeFurnaceConfig,
} from '../../core/furnace-config.js';
import { completeJournalRollback, runFurnaceMutation } from '../../core/furnace-operation.js';
import { assertFurnaceEngineReady } from '../../core/furnace-precondition.js';
import { createRollbackJournal, snapshotFile } from '../../core/furnace-rollback.js';
import { DEEP_SCAN_PATHS, scanWidgetsDirectory } from '../../core/furnace-scanner.js';
import {
  cancel,
  info,
  intro,
  isCancel,
  note,
  outro,
  spinner,
  success,
} from '../../utils/logger.js';
import { furnaceOverrideCommand } from './override.js';

/**
 * Prompts the user to add newly discovered stock components to furnace.json.
 * @param components - Components discovered in the engine scan
 * @param tracked - Existing Furnace tracking map keyed by tag name
 * @param projectRoot - Root directory of the project
 */
async function promptAddComponents(
  components: Awaited<ReturnType<typeof scanWidgetsDirectory>>,
  tracked: Map<string, 'stock' | 'override' | 'custom'>,
  projectRoot: string
): Promise<void> {
  const untrackedComponents = components.filter((c) => !tracked.has(c.tagName));

  const shouldAdd = await confirm({ message: 'Add components to furnace.json?' });

  if (isCancel(shouldAdd) || !shouldAdd) {
    if (isCancel(shouldAdd)) {
      cancel('Cancelled');
    }
    outro('Scan complete');
    return;
  }

  const selected = await multiselect({
    message: 'Select components to add as stock',
    options: untrackedComponents.map((c) => ({
      value: c.tagName,
      label: `${c.tagName}${formatComponentFeatures(c)}`,
    })),
  });

  if (isCancel(selected)) {
    cancel('Cancelled');
    outro('Scan complete');
    return;
  }

  await persistStockComponents(projectRoot, selected);

  const addedNames = selected;
  success(
    `Added ${addedNames.length} component${addedNames.length === 1 ? '' : 's'} to furnace.json`
  );

  // Offer to immediately override one of the just-added stock components.
  const shouldOverride = await confirm({
    message: 'Override any of the newly added components?',
  });

  if (isCancel(shouldOverride) || !shouldOverride) {
    return;
  }

  const overrideTarget = await select({
    message: 'Select a component to override',
    options: addedNames.map((name) => ({ value: name, label: name })),
  });

  if (isCancel(overrideTarget)) {
    cancel('Cancelled');
    return;
  }

  await furnaceOverrideCommand(projectRoot, overrideTarget);
}

/**
 * Persists discovered component tag names into the `stock` section of
 * furnace.json. Shared by the interactive confirm flow and the
 * non-interactive `--track` flag — without it, scan prints a full inventory
 * but persists nothing and says nothing about where the inventory goes.
 *
 * Wraps the furnace.json mutation in the standard furnace lifecycle so the
 * write goes through the furnace-wide lock and is visible to the global
 * SIGINT/SIGTERM rollback pathway. The journal snapshots furnace.json
 * *before* `ensureFurnaceConfig` runs, so a failed run after the file is
 * auto-created cleans up after itself instead of leaving an unwanted default
 * config behind.
 */
async function persistStockComponents(projectRoot: string, names: string[]): Promise<void> {
  await runFurnaceMutation(projectRoot, 'scan-rollback', async (ctx) => {
    const journal = createRollbackJournal();
    ctx.registerJournal(journal);

    const furnacePaths = getFurnacePaths(projectRoot);
    await snapshotFile(journal, furnacePaths.furnaceConfig);

    try {
      const config = await ensureFurnaceConfig(projectRoot);
      // Defensive: callers already filter to untracked components. This
      // re-filter catches the edge case where the config on disk changed
      // between the scan's read and the write (concurrent scan / manual
      // edit). Without it a duplicate scan would introduce duplicate
      // entries into stock; writeFurnaceConfig's validator would then
      // reject the write, but the error would be less actionable than
      // silently de-duplicating here.
      const toAdd = names.filter((s) => !config.stock.includes(s));
      config.stock.push(...toAdd);
      await writeFurnaceConfig(projectRoot, config);
    } catch (error: unknown) {
      return await completeJournalRollback(ctx, journal, error, {
        projectRoot: projectRoot,
        operation: 'scan-rollback',
        failureMessage: 'Failed to update furnace.json during scan',
        subject: `furnace.json update during scan`,
      });
    }
  });
}

/**
 * Renders a component's discovered capabilities as a display suffix. Shared
 * by the interactive multiselect labels and the report rows.
 */
function formatComponentFeatures(component: {
  hasCSS: boolean;
  hasFTL: boolean;
  isRegistered: boolean;
}): string {
  const features: string[] = [];
  if (component.hasCSS) features.push('CSS');
  if (component.hasFTL) features.push('FTL');
  if (component.isRegistered) features.push('registered');
  return features.length > 0 ? ` — ${features.join(', ')}` : '';
}

/**
 * Runs the furnace scan command to discover MozLitElement components.
 * @param projectRoot - Root directory of the project
 * @param options - Scan options
 */
export async function furnaceScanCommand(
  projectRoot: string,
  options: { deep?: boolean; track?: boolean } = {}
): Promise<void> {
  intro(options.deep ? 'Furnace Scan (deep)' : 'Furnace Scan');

  const { paths } = await assertFurnaceEngineReady(projectRoot);

  // Load scan paths from config if available, merge with deep paths if requested
  const extraScanPaths: string[] = [];
  if (await furnaceConfigExists(projectRoot)) {
    const preConfig = await loadFurnaceConfig(projectRoot);
    if (preConfig.scanPaths) {
      extraScanPaths.push(...preConfig.scanPaths);
    }
  }
  if (options.deep) {
    for (const deepPath of DEEP_SCAN_PATHS) {
      if (!extraScanPaths.includes(deepPath)) {
        extraScanPaths.push(deepPath);
      }
    }
  }

  const s = spinner('Scanning engine for components...');
  const components = await scanWidgetsDirectory(
    paths.engine,
    undefined,
    extraScanPaths.length > 0 ? extraScanPaths : undefined
  );
  s.stop(`Found ${components.length} component${components.length === 1 ? '' : 's'}`);

  // Build tracking info from furnace.json if it exists
  const tracked = new Map<string, 'stock' | 'override' | 'custom'>();
  if (await furnaceConfigExists(projectRoot)) {
    const config = await loadFurnaceConfig(projectRoot);

    for (const name of config.stock) {
      tracked.set(name, 'stock');
    }
    for (const name of Object.keys(config.overrides)) {
      tracked.set(name, 'override');
    }
    for (const name of Object.keys(config.custom)) {
      tracked.set(name, 'custom');
    }
  }

  // Partition once and reuse across the report and the `--track` path.
  const untrackedComponentList = components.filter((c) => !tracked.has(c.tagName));
  const untrackedCount = untrackedComponentList.length;
  const trackedCount = components.length - untrackedCount;

  for (const component of components) {
    const type = tracked.get(component.tagName);
    info(`${component.tagName}${formatComponentFeatures(component)}${type ? ` [${type}]` : ''}`);
  }

  note(
    `Total: ${components.length}  Tracked: ${trackedCount}  Untracked: ${untrackedCount}`,
    'Summary'
  );

  // --track: persist the discovered untracked inventory into the `stock`
  // section without prompting (works non-interactively). Without it, scan
  // stays report-only; the interactive confirm flow below is the other
  // persistence path.
  if (options.track) {
    if (untrackedCount === 0) {
      info('Nothing to track: every discovered component is already in furnace.json.');
      outro('Scan complete');
      return;
    }
    const untrackedNames = untrackedComponentList.map((c) => c.tagName);
    await persistStockComponents(projectRoot, untrackedNames);
    success(
      `Tracked ${untrackedNames.length} component${untrackedNames.length === 1 ? '' : 's'} in the stock section of furnace.json`
    );
    outro('Scan complete');
    return;
  }

  const isInteractive = stdioIsInteractive();

  if (isInteractive && untrackedCount > 0) {
    await promptAddComponents(components, tracked, projectRoot);
    return;
  }

  if (untrackedCount > 0) {
    info(
      'Scan is report-only: re-run with --track to persist the untracked components into the ' +
        'stock section of furnace.json (deploy/validate consume them from there).'
    );
  }

  outro('Scan complete');
}
