// SPDX-License-Identifier: EUPL-1.2
/**
 * Patch-owned overwrite warnings for `furnace apply`.
 *
 * For Furnace-managed components, apply OVERWRITES the deployed engine
 * copies with the `components/` sources. A fix made directly in `engine/` and
 * exported into a patch — but never back-ported to the component source — is
 * silently undone by the next apply, and a plain drift line reads like
 * "someone's uncommitted work". This module detects that exact case BEFORE
 * the copy (deployed bytes differ from the component source AND the file is
 * patch-owned) and produces a per-file warning naming the file, the owning
 * patch, and the consequence.
 *
 * The per-file byte comparison already exists —
 * `checkRegistrationConsistency` for custom components (fragment- and
 * ftl-aware) and the copy-candidate walk for overrides — so this module only
 * surfaces what was previously computed and thrown away.
 */

import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

import type { CustomComponentConfig, OverrideComponentConfig } from '../types/furnace.js';
import { toError } from '../utils/errors.js';
import { pathExists, readText } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';
import { normalizePathSlashes } from '../utils/paths.js';
import { getProjectPaths } from './config.js';
import { getOverrideEngineTargetPath, isOverrideCopyCandidate } from './furnace-apply-helpers.js';
import { FTL_DIR } from './furnace-constants.js';
import { isRegularFile } from './furnace-dir-entry.js';
import { checkRegistrationConsistency } from './furnace-validate-registration.js';
import { loadPatchesManifest } from './patch-manifest.js';
import { buildPatchClaims } from './status-classify.js';

/** One deployed, patch-owned file about to be overwritten with different bytes. */
export interface PatchOwnedOverwriteWarning {
  component: string;
  /** Engine-relative path of the deployed file being replaced. */
  file: string;
  /** Patch filenames claiming the path in patches.json. */
  owners: string[];
}

/**
 * Loads the file → owning-patch map for the overwrite warning.
 * A missing or unreadable patches manifest degrades to an empty map — the
 * warning is advisory and must never block an apply.
 */
export async function loadPatchClaimsForApply(
  root: string
): Promise<ReadonlyMap<string, readonly string[]>> {
  try {
    const manifest = await loadPatchesManifest(getProjectPaths(root).patches);
    return manifest ? buildPatchClaims(manifest.patches) : new Map();
  } catch {
    return new Map();
  }
}

/** Appends formatted overwrite warnings onto the run's result. */
export function recordOverwriteWarnings(
  result: { warnings?: string[] },
  warnings: readonly PatchOwnedOverwriteWarning[]
): void {
  if (warnings.length === 0) return;
  result.warnings ??= [];
  result.warnings.push(...warnings.map(formatPatchOwnedOverwriteWarning));
}

/** Renders the operator-facing warning line for one overwrite. */
export function formatPatchOwnedOverwriteWarning(warning: PatchOwnedOverwriteWarning): string {
  const owners = warning.owners.join(', ');
  return (
    `${warning.component}: overwriting deployed ${warning.file} — its engine content differs ` +
    `from the components/ source, and the path is owned by patch ${owners}. If the engine ` +
    `edit was an intentional shipped fix, port it into the component source and re-export ` +
    `the patch — the deployed copy is being replaced now.`
  );
}

/** Custom components: reuse the validate oracle's drifted-file list. */
async function findCustomOverwrites(args: {
  root: string;
  name: string;
  config: CustomComponentConfig;
  ftlDir: string;
  patchClaims: ReadonlyMap<string, readonly string[]>;
}): Promise<PatchOwnedOverwriteWarning[]> {
  const { root, name, config, ftlDir, patchClaims } = args;
  const status = await checkRegistrationConsistency(root, name, config, ftlDir);
  const warnings: PatchOwnedOverwriteWarning[] = [];
  for (const entryName of status.driftedFiles) {
    const engineRel = entryName.endsWith('.ftl')
      ? `${ftlDir || FTL_DIR}/${entryName}`
      : `${config.targetPath}/${entryName}`;
    const owners = patchClaims.get(engineRel);
    if (owners !== undefined && owners.length > 0) {
      warnings.push({ component: name, file: engineRel, owners: [...owners] });
    }
  }
  return warnings;
}

/** Override components: byte-compare each copy candidate against its engine target. */
async function findOverrideOverwrites(args: {
  engineDir: string;
  name: string;
  componentDir: string;
  config: OverrideComponentConfig;
  ftlDir: string;
  patchClaims: ReadonlyMap<string, readonly string[]>;
}): Promise<PatchOwnedOverwriteWarning[]> {
  const { engineDir, name, componentDir, config, ftlDir, patchClaims } = args;
  const warnings: PatchOwnedOverwriteWarning[] = [];
  const entries = await readdir(componentDir, { withFileTypes: true, encoding: 'utf8' });
  for (const entry of entries) {
    if (!isRegularFile(entry)) continue;
    if (!isOverrideCopyCandidate(entry.name, config.type)) continue;
    const enginePath = getOverrideEngineTargetPath(engineDir, config, entry.name, ftlDir);
    // A missing target is a fresh deploy, not a lost engine edit.
    if (!(await pathExists(enginePath))) continue;
    const engineRel = normalizePathSlashes(relative(engineDir, enginePath));
    const owners = patchClaims.get(engineRel);
    if (owners === undefined || owners.length === 0) continue;
    const [engineContent, sourceContent] = await Promise.all([
      readText(enginePath),
      readText(join(componentDir, entry.name)),
    ]);
    if (engineContent !== sourceContent) {
      warnings.push({ component: name, file: engineRel, owners: [...owners] });
    }
  }
  return warnings;
}

/** Inputs for {@link findPatchOwnedOverwrites}, discriminated by component type. */
export type PatchOwnedOverwriteProbe =
  | {
      type: 'custom';
      root: string;
      name: string;
      config: CustomComponentConfig;
      ftlDir: string;
      patchClaims: ReadonlyMap<string, readonly string[]>;
    }
  | {
      type: 'override';
      engineDir: string;
      name: string;
      componentDir: string;
      config: OverrideComponentConfig;
      ftlDir: string;
      patchClaims: ReadonlyMap<string, readonly string[]>;
    };

/**
 * Finds deployed files this component's apply is about to overwrite whose
 * engine bytes differ from the component source AND that are patch-owned.
 * Probe failures degrade to a verbose line and an empty list — the apply
 * itself must not fail because the warning probe could not run.
 */
export async function findPatchOwnedOverwrites(
  args: PatchOwnedOverwriteProbe
): Promise<PatchOwnedOverwriteWarning[]> {
  if (args.patchClaims.size === 0) return [];
  try {
    if (args.type === 'custom') {
      return await findCustomOverwrites(args);
    }
    return await findOverrideOverwrites(args);
  } catch (error: unknown) {
    verbose(`Skipping patch-owned overwrite probe for ${args.name}: ${toError(error).message}`);
    return [];
  }
}
