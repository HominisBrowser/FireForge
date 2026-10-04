// SPDX-License-Identifier: EUPL-1.2
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { FurnaceConfig } from '../types/furnace.js';
import { getNodeErrorCode } from '../utils/errors.js';
import { sha256Hex } from '../utils/hash.js';
import type { FurnacePaths } from './furnace-config.js';

/** Records authored bytes without following directory aliases or writing to source directories. */
export async function snapshotComponentSources(
  roots: readonly string[]
): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error: unknown) {
      if (getNodeErrorCode(error) === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.set(path, sha256Hex(await readFile(path)));
    }
  }
  for (const root of roots) await visit(root);
  return files;
}

/** Detects reverted, removed or added source files before deployment can be committed. */
export async function changedComponentSources(
  roots: readonly string[],
  before: ReadonlyMap<string, string>
): Promise<string[]> {
  const after = await snapshotComponentSources(roots);
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .sort();
}

interface ComponentSourceSnapshot {
  roots: string[];
  files: Map<string, string>;
}

/** Captures only configured inputs for a real deploy, plus shared CSS fragments. */
export async function captureComponentSources(
  paths: FurnacePaths,
  config: FurnaceConfig,
  dryRun: boolean,
  options?: { componentName?: string }
): Promise<ComponentSourceSnapshot | undefined> {
  if (dryRun) return undefined;
  const componentName = options?.componentName;
  const selected = (name: string): boolean => componentName === undefined || name === componentName;
  const roots = [
    ...Object.keys(config.custom)
      .filter(selected)
      .map((name) => join(paths.customDir, name)),
    ...Object.keys(config.overrides)
      .filter(selected)
      .map((name) => join(paths.overridesDir, name)),
    paths.sharedDir,
  ];
  return { roots, files: await snapshotComponentSources(roots) };
}

/** Produces a blocking apply error before the journal or ownership state is committed. */
export async function componentSourceErrors(
  snapshot: ComponentSourceSnapshot | undefined
): Promise<Array<{ name: string; error: string }>> {
  if (!snapshot) return [];
  const changed = await changedComponentSources(snapshot.roots, snapshot.files);
  return changed.length === 0
    ? []
    : [
        {
          name: 'component-sources',
          error: `Component sources changed during deployment: ${changed.join(', ')}. Refusing this build/proof; inspect the source edits before retrying.`,
        },
      ];
}
