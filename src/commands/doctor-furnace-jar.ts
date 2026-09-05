// SPDX-License-Identifier: EUPL-1.2
/**
 * `doctor` check for stale furnace jar.mn registrations: a component-file
 * rename can leave the old toolkit jar.mn line pointing at the deleted file,
 * failing every build at packaging. Split out of `doctor-furnace.ts` to keep
 * that file within the line budget.
 */

import { getFurnacePaths } from '../core/furnace-config.js';
import { findStaleJarMnEntries, pruneStaleJarMnEntries } from '../core/furnace-registration.js';
import { toError } from '../utils/errors.js';
import type { DoctorCheckDefinition } from './doctor-check-core.js';
import { failure, ok, warning } from './doctor-check-core.js';

/**
 * "Furnace jar.mn registrations" check: detect widget registration lines
 * pointing at component files that no longer exist in the workspace,
 * typically left by a rename. These break `mach build` at packaging.
 * `--repair-furnace` prunes them.
 */
export const furnaceStaleJarRegistrationCheck: DoctorCheckDefinition = {
  name: 'Furnace jar.mn registrations',
  dependsOn: ['Furnace configuration'],
  skipIf: (ctx) => !ctx.furnaceConfigExists || !ctx.furnaceConfig || !ctx.engineExists,
  run: async (ctx) => {
    const config = ctx.furnaceConfig;
    if (!config) return [];
    const furnacePaths = getFurnacePaths(ctx.projectRoot);
    const managedTags = Object.keys(config.custom);

    const stale = await findStaleJarMnEntries(
      ctx.paths.engine,
      furnacePaths.customDir,
      managedTags
    );
    if (stale.length === 0) {
      return ok('Furnace jar.mn registrations');
    }

    const staleList = stale.map((entry) => `${entry.tagName}/${entry.fileName}`).join(', ');
    if (!ctx.options.repairFurnace) {
      return warning(
        'Furnace jar.mn registrations',
        `jar.mn carries ${stale.length} registration line${stale.length === 1 ? '' : 's'} pointing at removed component file${stale.length === 1 ? '' : 's'} (${staleList}). mach build will fail at packaging ("File ... not found").`,
        'Run "fireforge doctor --repair-furnace" (or "fireforge furnace validate --fix") to prune the stale lines.'
      );
    }

    try {
      const pruned = await pruneStaleJarMnEntries(
        ctx.paths.engine,
        furnacePaths.customDir,
        managedTags
      );
      return warning(
        'Furnace jar.mn registrations',
        `Pruned ${pruned.length} stale jar.mn registration line${pruned.length === 1 ? '' : 's'} (${staleList}).`
      );
    } catch (err: unknown) {
      return failure(
        'Furnace jar.mn registrations',
        `Could not prune stale jar.mn lines: ${toError(err).message}`,
        'Remove the stale lines from toolkit/content/jar.mn manually and retry.'
      );
    }
  },
};
