// SPDX-License-Identifier: EUPL-1.2
/**
 * Shared preamble for the patch subcommands: every mutation command starts
 * by loading the project paths and the patches manifest and (for the
 * single-patch commands) resolving the operator-supplied identifier. The
 * sequence and its error wording were previously copied into each command;
 * this module is the single source for both.
 */

import { getProjectPaths } from '../../core/config.js';
import { formatPatchNotFoundError } from '../../core/patch-identifier-suggest.js';
import { loadPatchesManifest, resolvePatchIdentifier } from '../../core/patch-manifest.js';
import { GeneralError, InvalidArgumentError } from '../../errors/base.js';
import type { PatchesManifest, PatchMetadata } from '../../types/commands/index.js';
import type { ProjectPaths } from '../../types/config.js';
import { pathExists } from '../../utils/fs.js';

/** Resolved project paths plus the non-empty patches manifest. */
export interface PatchQueueContext {
  /** Project paths resolved from the project root. */
  paths: ProjectPaths;
  /** The loaded manifest; guaranteed to contain at least one patch. */
  manifest: PatchesManifest;
}

/**
 * Loads the project paths and the patches manifest, throwing the shared
 * command-preamble errors when the patches directory is missing or the
 * manifest has no patches.
 *
 * @param projectRoot - Root directory of the project
 * @param options - Optional overrides for the preamble error wording
 * @param options.missingDirMessage - Replacement for the default
 *   "Patches directory not found." error (e.g. `patch delete` appends
 *   "No patches to delete.")
 * @returns The resolved paths and the non-empty manifest
 */
export async function requirePatchQueue(
  projectRoot: string,
  options: { missingDirMessage?: string } = {}
): Promise<PatchQueueContext> {
  const paths = getProjectPaths(projectRoot);
  if (!(await pathExists(paths.patches))) {
    throw new GeneralError(options.missingDirMessage ?? 'Patches directory not found.');
  }

  const manifest = await loadPatchesManifest(paths.patches);
  if (!manifest || manifest.patches.length === 0) {
    throw new GeneralError('No patches in manifest.');
  }

  return { paths, manifest };
}

/**
 * Resolves an operator-supplied patch identifier (order number, filename,
 * or unique name fragment) against the manifest, throwing the shared
 * not-found error with suggestions when no patch matches.
 *
 * @param identifier - Identifier as passed on the command line
 * @param patches - Manifest rows to resolve against
 * @returns The matching manifest row
 */
export function requirePatchTarget(identifier: string, patches: PatchMetadata[]): PatchMetadata {
  const target = resolvePatchIdentifier(identifier, patches);
  if (!target) {
    throw new InvalidArgumentError(formatPatchNotFoundError(identifier, patches), identifier);
  }
  return target;
}
