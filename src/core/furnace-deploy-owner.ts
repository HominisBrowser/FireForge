// SPDX-License-Identifier: EUPL-1.2
/**
 * `furnace deploy --owner <patch>`: refuse a deploy that would overwrite a
 * deployed file another patch owns.
 *
 * Deploy copies a whole component folder. Two sessions editing different
 * files of one folder, owned by different patches, cannot deploy apart:
 * the first deploy ships the other's half-done edit into the engine copy
 * its patch owns. Naming the patch being exported lets deploy judge every
 * file it is about to replace before any is written, across every named
 * component, and refuse when one belongs to a patch other than the named
 * one. Without `--owner` the same overwrites stay advisory warnings.
 */

import { join } from 'node:path';

import { FurnaceError } from '../errors/furnace.js';
import type { FurnaceConfig } from '../types/furnace.js';
import { pathExists } from '../utils/fs.js';
import { getProjectPaths } from './config.js';
import {
  type PatchOwnedOverwriteWarning,
  probePatchOwnedOverwrites,
} from './furnace-apply-overwrite-warn.js';
import { getFurnacePaths } from './furnace-config.js';
import { resolveFtlDir } from './furnace-constants.js';
import { formatPatchNotFoundError } from './patch-identifier-suggest.js';
import { loadPatchesManifest, resolvePatchIdentifier } from './patch-manifest.js';
import { buildPatchClaims } from './status-classify.js';

/**
 * Resolves `--owner` to a patch filename in the queue, refusing an unknown
 * patch or a project with no queue.
 *
 * @param root - Project root
 * @param owner - The patch identifier as given (filename, order or name)
 * @returns The owner's filename and the queue's file claims
 */
async function resolveOwner(
  root: string,
  owner: string
): Promise<{ filename: string; claims: ReadonlyMap<string, readonly string[]> }> {
  const manifest = await loadPatchesManifest(getProjectPaths(root).patches);
  if (!manifest || manifest.patches.length === 0) {
    throw new FurnaceError(`--owner ${owner}: the patch queue is empty or missing.`, owner);
  }
  const match = resolvePatchIdentifier(owner, manifest.patches);
  if (!match) {
    throw new FurnaceError(`--owner: ${formatPatchNotFoundError(owner, manifest.patches)}`, owner);
  }
  return { filename: match.filename, claims: buildPatchClaims(manifest.patches) };
}

/** The overrides and custom components a deploy of `names` (all when empty) applies. */
function componentsInScope(config: FurnaceConfig, names: readonly string[]): string[] {
  const all = [...Object.keys(config.overrides), ...Object.keys(config.custom)];
  if (names.length === 0) return all;
  return [...new Set(names)].filter((name) => all.includes(name));
}

function formatForeignOverwrites(
  owner: string,
  foreign: readonly PatchOwnedOverwriteWarning[]
): string {
  const lines = foreign.map(
    (entry) => `  - ${entry.file} (${entry.component}): owned by ${entry.owners.join(', ')}`
  );
  const owners = [...new Set(foreign.flatMap((entry) => entry.owners))].join(', ');
  return [
    `Deploy refused (--owner ${owner}): it would overwrite ${foreign.length} deployed file(s) ` +
      `that differ from the components/ source and are owned by another patch:`,
    ...lines,
    `Nothing was written. Those component sources carry edits for ${owners}, not ${owner}. ` +
      'Park that work or export that patch first, then deploy again, or deploy without ' +
      '--owner to overwrite the files anyway.',
  ].join('\n');
}

/** The patch-owned files one component's apply would overwrite. */
async function probeComponent(
  root: string,
  config: FurnaceConfig,
  name: string,
  patchClaims: ReadonlyMap<string, readonly string[]>
): Promise<PatchOwnedOverwriteWarning[]> {
  const ftlDir = resolveFtlDir(config.ftlBasePath);
  const override = config.overrides[name];
  if (override !== undefined) {
    const componentDir = join(getFurnacePaths(root).overridesDir, name);
    // A missing override folder copies nothing; apply reports it.
    if (!(await pathExists(componentDir))) return [];
    return probePatchOwnedOverwrites({
      type: 'override',
      engineDir: getProjectPaths(root).engine,
      name,
      componentDir,
      config: override,
      ftlDir,
      patchClaims,
    });
  }
  const custom = config.custom[name];
  if (custom === undefined) return [];
  return probePatchOwnedOverwrites({
    type: 'custom',
    root,
    name,
    config: custom,
    ftlDir,
    patchClaims,
  });
}

/**
 * Refuses the deploy when a file it would overwrite is owned by a patch
 * other than `owner`. Runs before any component is applied. A file the
 * owner shares with another patch is the owner's to deploy.
 *
 * @param args.root - Project root
 * @param args.config - Furnace configuration
 * @param args.names - The named components (empty for a deploy of all)
 * @param args.owner - The `--owner` patch identifier
 */
export async function assertDeployOverwritesOwnedBy(args: {
  root: string;
  config: FurnaceConfig;
  names: readonly string[];
  owner: string;
}): Promise<void> {
  const { root, config, names } = args;
  const { filename, claims } = await resolveOwner(root, args.owner);
  const foreign: PatchOwnedOverwriteWarning[] = [];
  for (const name of componentsInScope(config, names)) {
    const found = await probeComponent(root, config, name, claims);
    foreign.push(...found.filter((entry) => !entry.owners.includes(filename)));
  }
  if (foreign.length > 0) {
    throw new FurnaceError(formatForeignOverwrites(filename, foreign), undefined, undefined, {
      omitValidateAdvice: true,
    });
  }
}
