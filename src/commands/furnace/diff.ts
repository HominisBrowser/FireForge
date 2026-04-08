// SPDX-License-Identifier: EUPL-1.2
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { getProjectPaths } from '../../core/config.js';
import { getFurnacePaths, loadFurnaceConfig } from '../../core/furnace-config.js';
import { FurnaceError } from '../../errors/furnace.js';
import { pathExists, readText } from '../../utils/fs.js';
import { formatErrorText, formatSuccessText, info, intro, outro } from '../../utils/logger.js';

/**
 * Computes a simplified line-level diff between two strings.
 * Note: Uses a prefix/suffix matching algorithm that may combine
 * multiple scattered changes into a single change region.
 * For complex diffs with interleaved changes, the output may not
 * be optimal.
 */
function lineDiff(original: string, modified: string): string[] {
  const oldLines = original.split('\n');
  const newLines = modified.split('\n');

  // Remove trailing empty element from trailing newline
  if (oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines[newLines.length - 1] === '') newLines.pop();

  const output: string[] = [];

  // Simple diff: find common prefix, common suffix, then show changed region
  let firstDiff = 0;
  while (firstDiff < oldLines.length && firstDiff < newLines.length) {
    if (oldLines[firstDiff] !== newLines[firstDiff]) break;
    firstDiff++;
  }

  let lastOldDiff = oldLines.length - 1;
  let lastNewDiff = newLines.length - 1;
  while (lastOldDiff > firstDiff && lastNewDiff > firstDiff) {
    if (oldLines[lastOldDiff] !== newLines[lastNewDiff]) break;
    lastOldDiff--;
    lastNewDiff--;
  }

  // Context lines before the change
  const contextLines = 3;
  const contextStart = Math.max(0, firstDiff - contextLines);
  const contextEndOld = Math.min(oldLines.length - 1, lastOldDiff + contextLines);
  const contextEndNew = Math.min(newLines.length - 1, lastNewDiff + contextLines);

  // Leading context
  for (let i = contextStart; i < firstDiff; i++) {
    output.push(`  ${oldLines[i]}`);
  }

  // Removed lines
  for (let i = firstDiff; i <= lastOldDiff; i++) {
    output.push(formatErrorText(`- ${oldLines[i]}`));
  }

  // Added lines
  for (let i = firstDiff; i <= lastNewDiff; i++) {
    output.push(formatSuccessText(`+ ${newLines[i]}`));
  }

  // Trailing context
  const trailingStart = Math.max(lastOldDiff + 1, lastNewDiff + 1);
  const trailingEnd = Math.max(contextEndOld, contextEndNew);
  // Use the new lines for trailing context (they should match old lines here)
  for (let i = trailingStart; i <= trailingEnd && i < newLines.length; i++) {
    output.push(`  ${newLines[i]}`);
  }

  return output;
}

/**
 * Runs the furnace diff command to show changes vs the Firefox original.
 * Only works for override components.
 * @param projectRoot - Root directory of the project
 * @param name - Component name to diff
 */
export async function furnaceDiffCommand(projectRoot: string, name: string): Promise<void> {
  intro('Furnace Diff');

  const config = await loadFurnaceConfig(projectRoot);
  const paths = getProjectPaths(projectRoot);
  const furnacePaths = getFurnacePaths(projectRoot);

  // Verify the component is an override
  const overrideConfig = config.overrides[name];
  if (!overrideConfig) {
    throw new FurnaceError(
      `"${name}" is not an override component. The diff command only works for overrides.`,
      name
    );
  }

  const overrideDir = join(furnacePaths.overridesDir, name);
  if (!(await pathExists(overrideDir))) {
    throw new FurnaceError(`Override directory not found: components/overrides/${name}`, name);
  }

  const entries = await readdir(overrideDir, { withFileTypes: true });
  let hasDifferences = false;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.mjs') && !entry.name.endsWith('.css')) continue;

    const originalPath = join(paths.engine, overrideConfig.basePath, entry.name);
    const modifiedPath = join(overrideDir, entry.name);

    if (!(await pathExists(originalPath))) {
      info(`${entry.name}: original not found in engine (new file)`);
      hasDifferences = true;
      continue;
    }

    const originalContent = await readText(originalPath);
    const modifiedContent = await readText(modifiedPath);

    if (originalContent === modifiedContent) {
      continue;
    }

    hasDifferences = true;
    info(`--- ${overrideConfig.basePath}/${entry.name}`);
    info(`+++ components/overrides/${name}/${entry.name}`);

    const diffLines = lineDiff(originalContent, modifiedContent);
    for (const line of diffLines) {
      info(line);
    }

    info('');
  }

  if (!hasDifferences) {
    info('No modifications found');
  }

  outro('Diff complete');
}
