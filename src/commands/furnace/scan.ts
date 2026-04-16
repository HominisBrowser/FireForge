// SPDX-License-Identifier: EUPL-1.2
import { confirm, multiselect, select } from '@clack/prompts';

import { getProjectPaths } from '../../core/config.js';
import {
  ensureFurnaceConfig,
  furnaceConfigExists,
  getFurnacePaths,
  loadFurnaceConfig,
  writeFurnaceConfig,
} from '../../core/furnace-config.js';
import { recordFurnaceRollbackFailure, runFurnaceMutation } from '../../core/furnace-operation.js';
import {
  createRollbackJournal,
  restoreRollbackJournalOrThrow,
  snapshotFile,
} from '../../core/furnace-rollback.js';
import { DEEP_SCAN_PATHS, scanWidgetsDirectory } from '../../core/furnace-scanner.js';
import { FurnaceError } from '../../errors/furnace.js';
import { toError } from '../../utils/errors.js';
import { pathExists } from '../../utils/fs.js';
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
    options: untrackedComponents.map((c) => {
      const features: string[] = [];
      if (c.hasCSS) features.push('CSS');
      if (c.hasFTL) features.push('FTL');
      if (c.isRegistered) features.push('registered');
      const label = features.length > 0 ? `${c.tagName} — ${features.join(', ')}` : c.tagName;
      return { value: c.tagName, label };
    }),
  });

  if (isCancel(selected)) {
    cancel('Cancelled');
    outro('Scan complete');
    return;
  }

  // Wrap the furnace.json mutation in the standard furnace lifecycle so the
  // write goes through the furnace-wide lock and is visible to the global
  // SIGINT/SIGTERM rollback pathway. The journal snapshots furnace.json
  // *before* `ensureFurnaceConfig` runs, so a failed run after the file is
  // auto-created cleans up after itself instead of leaving an unwanted
  // default config behind.
  await runFurnaceMutation(projectRoot, 'scan-rollback', async (ctx) => {
    const journal = createRollbackJournal();
    ctx.registerJournal(journal);

    const furnacePaths = getFurnacePaths(projectRoot);
    await snapshotFile(journal, furnacePaths.furnaceConfig);

    try {
      const config = await ensureFurnaceConfig(projectRoot);
      // Defensive: `selected` is already filtered to exclude components
      // currently in config.stock (see untrackedComponents above). This
      // re-filter catches the edge case where the config on disk changed
      // between the scan's read and the write (concurrent scan / manual
      // edit). Without it a duplicate scan would introduce duplicate
      // entries into stock; writeFurnaceConfig's validator would then
      // reject the write, but the error would be less actionable than
      // silently de-duplicating here.
      const toAdd = (selected as string[]).filter((s) => !config.stock.includes(s));
      config.stock.push(...toAdd);
      await writeFurnaceConfig(projectRoot, config);
    } catch (error: unknown) {
      try {
        await restoreRollbackJournalOrThrow(journal, 'Failed to update furnace.json during scan');
      } catch (rollbackError) {
        await recordFurnaceRollbackFailure(
          projectRoot,
          'scan-rollback',
          `furnace.json update during scan: ${toError(rollbackError).message}`
        );
        throw rollbackError;
      }
      throw error;
    }
  });

  const addedNames = selected as string[];
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

  await furnaceOverrideCommand(projectRoot, overrideTarget as string);
}

/**
 * Runs the furnace scan command to discover MozLitElement components.
 * @param projectRoot - Root directory of the project
 * @param options - Scan options
 */
export async function furnaceScanCommand(
  projectRoot: string,
  options: { deep?: boolean } = {}
): Promise<void> {
  intro(options.deep ? 'Furnace Scan (deep)' : 'Furnace Scan');

  const paths = getProjectPaths(projectRoot);

  if (!(await pathExists(paths.engine))) {
    throw new FurnaceError('Engine directory not found. Run "fireforge download" first.');
  }

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

  // Display each component
  for (const component of components) {
    const features: string[] = [];
    if (component.hasCSS) features.push('CSS');
    if (component.hasFTL) features.push('FTL');
    if (component.isRegistered) features.push('registered');

    let line = component.tagName;
    if (features.length > 0) {
      line += ` — ${features.join(', ')}`;
    }

    const type = tracked.get(component.tagName);
    if (type) {
      line += ` [${type}]`;
    }

    info(line);
  }

  // Summary
  let trackedCount = 0;
  for (const component of components) {
    if (tracked.has(component.tagName)) {
      trackedCount++;
    }
  }
  const untrackedCount = components.length - trackedCount;

  note(
    `Total: ${components.length}  Tracked: ${trackedCount}  Untracked: ${untrackedCount}`,
    'Summary'
  );

  const isInteractive = process.stdin.isTTY && process.stdout.isTTY;

  if (isInteractive && untrackedCount > 0) {
    await promptAddComponents(components, tracked, projectRoot);
    return;
  }

  outro('Scan complete');
}
