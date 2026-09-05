// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { PatchError } from '../errors/patch.js';
import type { PatchMetadata } from '../types/commands/index.js';
import type { FireForgeConfig } from '../types/config.js';
import { toError } from '../utils/errors.js';
import { pathExists, readText, writeText } from '../utils/fs.js';
import { warn } from '../utils/logger.js';
import { withPatchDirectoryLock } from './patch-apply.js';
import type { PatchDirectoryLockOptions } from './patch-lock.js';
import { loadPatchesManifestForWrite, mutatePatchRowsInManifest } from './patch-manifest.js';
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

export interface UpdatePatchAndMetadataOptions {
  /** Patch directory holding the body and `patches.json`. */
  patchesDir: string;
  /** Patch file to rewrite. */
  filename: string;
  /** New patch body; an identical body skips the write. */
  newContent: string;
  /** Manifest-row fields to merge into the patch's metadata. */
  updates: Partial<PatchMetadata>;
  /** Hook run under the lock after the mutation succeeds. */
  onCommitted?: UpdatePatchCommittedHook | undefined;
  /** Policy gate run against the under-lock projected manifest. */
  policyGate?: UpdatePatchPolicyGate | undefined;
  /** Wait budget and command name for the patch directory lock. */
  lockOptions?: PatchDirectoryLockOptions | undefined;
}

/**
 * Updates a patch file body and its manifest row under the same patch
 * directory lock. Intended for commands like `re-export --files` where the
 * file body and `filesAffected` metadata must move together.
 *
 * The body write is skipped when the normalized new content is byte-identical
 * to what is already on disk. A bulk `re-export --all` refreshes every patch
 * in the queue, including ones the working tree never touched; rewriting an
 * unchanged body churns its mtime and reports "Re-exported" for a patch
 * nothing happened to, which is exactly the noise that hides a real
 * unexpected rewrite in `git status`. Metadata still moves either way — only
 * the redundant byte-for-byte write is elided.
 *
 * @param options - See {@link UpdatePatchAndMetadataOptions}
 * @returns True when the patch body on disk changed, false when it was
 *   already byte-identical to the new content.
 */
export async function updatePatchAndMetadata(
  options: UpdatePatchAndMetadataOptions
): Promise<boolean> {
  const {
    patchesDir,
    filename,
    newContent,
    updates,
    onCommitted,
    policyGate,
    lockOptions = {},
  } = options;
  return withPatchDirectoryLock(
    patchesDir,
    async () => {
      const manifest = await loadPatchesManifestForWrite(patchesDir);
      if (!manifest) {
        throw new PatchError('Cannot update patch metadata: patches.json is missing.', filename);
      }

      const patchIndex = manifest.patches.findIndex((p) => p.filename === filename);
      if (patchIndex === -1) {
        throw new PatchError(
          `Cannot update patch metadata: ${filename} not found in patches.json.`,
          filename
        );
      }

      const patchPath = join(patchesDir, filename);
      if (!(await pathExists(patchPath))) {
        throw new PatchError(
          `Cannot update patch: patch file is missing on disk: ${filename}`,
          filename
        );
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

      const normalized = newContent;
      const bodyChanged = normalized !== originalContent;

      let patchWritten = false;
      try {
        if (bodyChanged) {
          await writeText(patchPath, normalized);
          patchWritten = true;
        }
        await mutatePatchRowsInManifest(patchesDir, [filename], () => ({ set: updates }));
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

      return bodyChanged;
    },
    lockOptions
  );
}
