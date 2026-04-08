// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { getProjectPaths } from '../../core/config.js';
import { furnaceConfigExists, loadFurnaceConfig } from '../../core/furnace-config.js';
import { cleanStories, syncStories } from '../../core/furnace-stories.js';
import { runMach, runMachCapture } from '../../core/mach.js';
import { FurnaceError } from '../../errors/furnace.js';
import type { FurnacePreviewOptions } from '../../types/commands/index.js';
import { pathExists } from '../../utils/fs.js';
import { info, intro, outro, spinner } from '../../utils/logger.js';

/**
 * Builds a targeted Storybook failure message from captured mach output.
 * @param output - Combined stdout and stderr from the Storybook command
 * @param installRequested - Whether the caller requested a dependency reinstall first
 * @returns User-facing guidance for the specific failure mode
 */
function buildStorybookFailureMessage(output: string, installRequested: boolean): string {
  const installHint = installRequested
    ? 'Try running "python3 ./mach storybook upgrade" manually in the engine directory.'
    : 'Run "fireforge furnace preview --install" to bootstrap Storybook dependencies, or run "python3 ./mach storybook upgrade" manually in engine/.';

  if (/(ENOENT|No such file or directory)/i.test(output) && /storybook|backend/i.test(output)) {
    return (
      'Storybook failed because the Firefox checkout appears to be missing Storybook workspace files or backend dependencies.\n\n' +
      installHint
    );
  }

  return (
    'Storybook failed to start. Check the output above for the specific Firefox-side error.\n\n' +
    installHint
  );
}

/**
 * Runs the furnace preview command to start Storybook for component preview.
 * @param projectRoot - Root directory of the project
 * @param options - Command options
 */
export async function furnacePreviewCommand(
  projectRoot: string,
  options: FurnacePreviewOptions = {}
): Promise<void> {
  intro('Furnace Preview (Storybook)');

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

  const stockCount = config.stock.length;
  const overrideCount = Object.keys(config.overrides).length;
  const customCount = Object.keys(config.custom).length;
  const totalCount = stockCount + overrideCount + customCount;

  if (totalCount === 0) {
    info('No components to preview.');
    outro('Done');
    return;
  }

  const storybookRoot = join(paths.engine, 'browser', 'components', 'storybook');
  if (!(await pathExists(storybookRoot))) {
    throw new FurnaceError(
      'This Firefox checkout does not contain browser/components/storybook. Furnace preview requires the upstream Storybook workspace to exist before stories can be synced.'
    );
  }

  let previewResult:
    | {
        stdout: string;
        stderr: string;
        exitCode: number;
      }
    | undefined;
  let storiesSynced = false;

  try {
    // Sync story files
    const syncSpinner = spinner('Syncing component stories...');
    const result = await syncStories(projectRoot);
    storiesSynced = true;
    const created = result.created.length;
    const updated = result.updated.length;
    const total = created + updated;
    syncSpinner.stop(`Synced ${total} stories (${created} new, ${updated} updated)`);

    // Force-reinstall Storybook dependencies if requested
    if (options.install) {
      const installSpinner = spinner('Reinstalling Storybook dependencies...');
      const installCode = await runMach(['storybook', 'upgrade'], paths.engine);
      if (installCode !== 0) {
        installSpinner.stop('Failed to reinstall Storybook dependencies');
        throw new FurnaceError(
          'Storybook dependency reinstallation failed. Try running "python3 ./mach storybook upgrade" manually in the engine directory.'
        );
      }
      installSpinner.stop('Storybook dependencies reinstalled');
    }

    // Start Storybook
    info('Starting Storybook...');
    info('Press Ctrl+C to stop\n');

    previewResult = await runMachCapture(['storybook'], paths.engine);
  } finally {
    if (storiesSynced) {
      await cleanStories(paths.engine);
    }
  }

  if (
    previewResult.exitCode !== 0 &&
    previewResult.exitCode !== 130 &&
    previewResult.exitCode !== 143
  ) {
    const combinedOutput = `${previewResult.stdout}\n${previewResult.stderr}`;
    throw new FurnaceError(buildStorybookFailureMessage(combinedOutput, options.install ?? false));
  }

  outro('Storybook stopped');
}
