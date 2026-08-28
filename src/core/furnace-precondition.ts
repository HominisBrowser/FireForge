// SPDX-License-Identifier: EUPL-1.2
/**
 * Shared precondition ladder for the Furnace command family: engine exists,
 * `furnace.json` exists.
 *
 * Kept separate from the `GeneralError` ladder in `engine-precondition.ts`
 * because the error CLASS is load-bearing here, not cosmetic: `FurnaceError`
 * carries its own `userMessage` and exit code 9, so a helper raising
 * `GeneralError` would silently change both.
 *
 * Deliberately NOT routed through this helper — each informs rather than
 * refuses, and each says so at its own site: `furnace list`,
 * `furnace status`, `furnace init`, and `verify`. `furnace validate`
 * refusing is the intended line between inspecting and validating.
 */

import { FurnaceError } from '../errors/furnace.js';
import type { FurnaceConfig } from '../types/furnace.js';
import type { ProjectPaths } from '../types/index.js';
import { pathExists } from '../utils/fs.js';
import { getProjectPaths } from './config-paths.js';
import { furnaceConfigExists, loadFurnaceConfig } from './furnace-config.js';

/** Options shared by the Furnace precondition assertions. */
export interface FurnacePreconditionOptions {
  /**
   * Appended to the engine-missing refusal, e.g.
   * `' to scaffold a chrome-doc.'`. The base message ends WITHOUT
   * punctuation so the suffix reads as one sentence; callers passing nothing
   * get a plain full stop.
   */
  engineMissingSuffix?: string;
}

/**
 * Asserts that a specific engine directory exists, raising a `FurnaceError`.
 *
 * The path-taking form, for core helpers that already hold `engineDir` and
 * have no project root to derive it from.
 *
 * @param engineDir - Absolute path to the engine checkout
 * @param options - Optional message tailoring
 */
export async function assertFurnaceEngineDirReady(
  engineDir: string,
  options: FurnacePreconditionOptions = {}
): Promise<void> {
  if (!(await pathExists(engineDir))) {
    throw new FurnaceError(
      `Engine directory not found. Run "fireforge download" first${options.engineMissingSuffix ?? '.'}`
    );
  }
}

/**
 * Asserts that the engine checkout exists, raising a `FurnaceError`.
 *
 * The engine rung on its own, for the Furnace commands that scaffold or
 * mutate component sources without needing `furnace.json` to exist yet.
 *
 * @param projectRoot - Project root directory
 * @param options - Optional message tailoring
 * @returns Resolved project paths, so callers do not re-derive them
 */
export async function assertFurnaceEngineReady(
  projectRoot: string,
  options: FurnacePreconditionOptions = {}
): Promise<{ paths: ProjectPaths }> {
  const paths = getProjectPaths(projectRoot);
  await assertFurnaceEngineDirReady(paths.engine, options);
  return { paths };
}

/**
 * Asserts the full Furnace ladder — engine checkout, then `furnace.json` —
 * and returns the loaded config so callers do not read it a second time.
 *
 * @param projectRoot - Project root directory
 * @param options - Optional message tailoring
 * @returns Resolved project paths and the loaded furnace config
 */
export async function assertFurnaceReady(
  projectRoot: string,
  options: FurnacePreconditionOptions = {}
): Promise<{ paths: ProjectPaths; config: FurnaceConfig }> {
  const { paths } = await assertFurnaceEngineReady(projectRoot, options);

  // `loadFurnaceConfig` refuses on its own with a fuller message, but the
  // probe stays: it produces the shorter, action-first refusal the command
  // layer has always shown for "you have not set Furnace up yet", which is a
  // different situation from "your furnace.json is unreadable".
  if (!(await furnaceConfigExists(projectRoot))) {
    throw new FurnaceError(
      'No furnace.json found. Run "fireforge furnace create" or "fireforge furnace override" to get started.'
    );
  }

  return { paths, config: await loadFurnaceConfig(projectRoot) };
}
