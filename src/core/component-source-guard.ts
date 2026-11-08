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
  /** Source directory per captured component, to attribute a change to its owner. */
  componentRoots: Array<{ name: string; root: string }>;
  sharedRoot: string;
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
  const componentRoots = [
    ...Object.keys(config.custom)
      .filter(selected)
      .map((name) => ({ name, root: join(paths.customDir, name) })),
    ...Object.keys(config.overrides)
      .filter(selected)
      .map((name) => ({ name, root: join(paths.overridesDir, name) })),
  ];
  const roots = [...componentRoots.map((entry) => entry.root), paths.sharedDir];
  return {
    roots,
    componentRoots,
    sharedRoot: paths.sharedDir,
    files: await snapshotComponentSources(roots),
  };
}

/** What changed under a run's captured sources, split by whether the run deployed it. */
export interface ComponentSourceChanges {
  /** Blocking: a component this run applied changed while it was being copied. */
  errors: Array<{ name: string; error: string }>;
  /** Components this run did not apply whose sources changed (typically a peer's edit). */
  foreign: string[];
}

/**
 * Judges source changes since the snapshot. A change under a component the
 * run applied is a blocking error, because the engine copy may be torn
 * between versions. A change under a component the run left alone (skipped
 * as current, or not selected) cannot reach the build through this run, so
 * it is reported in `foreign` instead of failing a peer's work. A shared
 * fragment change is blocking only when the run applied something that can
 * include it.
 *
 * @param snapshot - Capture from {@link captureComponentSources}
 * @param appliedNames - Names of the components the run applied
 */
export async function componentSourceChanges(
  snapshot: ComponentSourceSnapshot | undefined,
  appliedNames: ReadonlySet<string>
): Promise<ComponentSourceChanges> {
  if (!snapshot) return { errors: [], foreign: [] };
  const changed = await changedComponentSources(snapshot.roots, snapshot.files);
  const blocking: string[] = [];
  const foreign = new Set<string>();
  for (const path of changed) {
    const owner = snapshot.componentRoots.find((entry) => path.startsWith(`${entry.root}/`));
    if (owner === undefined) {
      if (appliedNames.size > 0) blocking.push(path);
    } else if (appliedNames.has(owner.name)) {
      blocking.push(path);
    } else {
      foreign.add(owner.name);
    }
  }
  return {
    errors:
      blocking.length === 0
        ? []
        : [
            {
              name: 'component-sources',
              error: `Component sources changed during deployment: ${blocking.join(', ')}. Refusing this build/proof; inspect the source edits before retrying.`,
            },
          ],
    foreign: [...foreign].sort(),
  };
}
