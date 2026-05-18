// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import type { PatchMetadata } from '../types/commands/index.js';
import type { FireForgeConfig } from '../types/config.js';
import { toError } from '../utils/errors.js';
import { pathExists, readText, writeText } from '../utils/fs.js';
import { warn } from '../utils/logger.js';
import { withPatchDirectoryLock } from './patch-apply.js';
import { loadPatchesManifest, savePatchesManifest } from './patch-manifest.js';
import { buildProjectedManifest, enforcePatchPolicy } from './patch-policy.js';

/**
 * Optional post-commit hook for {@link updatePatchAndMetadata}. Runs inside
 * the patch directory lock after the mutation has succeeded but before the
 * lock is released.
 */
export type UpdatePatchCommittedHook = () => Promise<void>;

/** Optional policy gate run against the under-lock projected manifest. */
export interface UpdatePatchPolicyGate {
  config: FireForgeConfig;
  command: string;
  forceUnsafe?: boolean;
}

/**
 * Updates a patch file body and its manifest row under the same patch
 * directory lock. Intended for commands like `re-export --files` where the
 * file body and `filesAffected` metadata must move together.
 */
export async function updatePatchAndMetadata(
  patchesDir: string,
  filename: string,
  newContent: string,
  updates: Partial<PatchMetadata>,
  onCommitted?: UpdatePatchCommittedHook,
  policyGate?: UpdatePatchPolicyGate
): Promise<void> {
  await withPatchDirectoryLock(patchesDir, async () => {
    const manifest = await loadPatchesManifest(patchesDir);
    if (!manifest) {
      throw new Error('Cannot update patch metadata: patches.json is missing.');
    }

    const patchIndex = manifest.patches.findIndex((p) => p.filename === filename);
    if (patchIndex === -1) {
      throw new Error(`Cannot update patch metadata: ${filename} not found in patches.json.`);
    }

    const patchPath = join(patchesDir, filename);
    if (!(await pathExists(patchPath))) {
      throw new Error(`Cannot update patch: patch file is missing on disk: ${filename}`);
    }

    const originalContent = await readText(patchPath);
    const existingPatch = manifest.patches[patchIndex] as PatchMetadata;
    manifest.patches[patchIndex] = { ...existingPatch, ...updates };

    if (policyGate !== undefined) {
      enforcePatchPolicy({
        config: policyGate.config,
        manifest: buildProjectedManifest(manifest, manifest.patches),
        command: policyGate.command,
        forceUnsafe: policyGate.forceUnsafe === true,
      });
    }

    let patchWritten = false;
    try {
      await writeText(patchPath, newContent);
      patchWritten = true;
      await savePatchesManifest(patchesDir, manifest);
    } catch (error: unknown) {
      if (patchWritten) {
        try {
          await writeText(patchPath, originalContent);
        } catch (rollbackError: unknown) {
          warn(
            `Rollback warning: could not restore ${filename} after metadata write failed: ${toError(rollbackError).message}`
          );
        }
      }
      throw error;
    }

    if (onCommitted) {
      try {
        await onCommitted();
      } catch (hookError: unknown) {
        warn(
          `History log append failed after updatePatchAndMetadata committed (${filename}): ` +
            toError(hookError).message
        );
      }
    }
  });
}
