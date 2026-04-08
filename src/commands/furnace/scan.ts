// SPDX-License-Identifier: EUPL-1.2
import { confirm, multiselect } from '@clack/prompts';

import { getProjectPaths } from '../../core/config.js';
import {
  ensureFurnaceConfig,
  furnaceConfigExists,
  loadFurnaceConfig,
  writeFurnaceConfig,
} from '../../core/furnace-config.js';
import { scanWidgetsDirectory } from '../../core/furnace-scanner.js';
import { FurnaceError } from '../../errors/furnace.js';
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

  const config = await ensureFurnaceConfig(projectRoot);
  const toAdd = (selected as string[]).filter((s) => !config.stock.includes(s));
  config.stock.push(...toAdd);
  await writeFurnaceConfig(projectRoot, config);

  success(
    `Added ${(selected as string[]).length} component${(selected as string[]).length === 1 ? '' : 's'} to furnace.json`
  );
}

/**
 * Runs the furnace scan command to discover MozLitElement components.
 * @param projectRoot - Root directory of the project
 */
export async function furnaceScanCommand(projectRoot: string): Promise<void> {
  intro('Furnace Scan');

  const paths = getProjectPaths(projectRoot);

  if (!(await pathExists(paths.engine))) {
    throw new FurnaceError('Engine directory not found. Run "fireforge download" first.');
  }

  const s = spinner('Scanning engine for components...');
  const components = await scanWidgetsDirectory(paths.engine);
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
