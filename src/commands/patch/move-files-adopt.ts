// SPDX-License-Identifier: EUPL-1.2
/**
 * `patch move-files --scan-file <path>`: adopt new engine files into the
 * move's destination in the same transaction.
 *
 * Splitting a widget across patches moved existing files and adopted the
 * seam modules that appeared beside them. Adopting first (`re-export
 * --scan --scan-file`) grew the source past its own `large-patch-lines`
 * ceiling, which refused although the move that followed would have
 * shrunk it again. Adopting straight into the destination of the move
 * means no patch ever carries the intermediate body: both sides are linted
 * on what the transaction leaves behind.
 */

import { join } from 'node:path';

import { InvalidArgumentError } from '../../errors/base.js';
import type { PatchMetadata } from '../../types/commands/index.js';
import { pathExists } from '../../utils/fs.js';
import { normalizeEngineRelativeInput } from '../re-export-scan.js';

/**
 * Validates `--scan-file` paths: each must be engine-relative, exist in
 * `engine/`, be owned by no patch and not be one of the moved files.
 * Returns the sorted, de-duplicated list.
 *
 * @param rawFiles - The `--scan-file` values
 * @param patches - Manifest rows
 * @param enginePath - Engine directory
 * @param movedFiles - The `--file` paths of the same move
 */
export async function resolveAdoptedFiles(
  rawFiles: readonly string[] | undefined,
  patches: readonly PatchMetadata[],
  enginePath: string,
  movedFiles: readonly string[]
): Promise<string[]> {
  const files = [
    ...new Set((rawFiles ?? []).map((raw) => normalizeEngineRelativeInput(raw, '--scan-file'))),
  ].sort();
  const moved = new Set(movedFiles);
  for (const file of files) {
    if (moved.has(file)) {
      throw new InvalidArgumentError(
        `${file} is passed with both --file and --scan-file. --file moves a file the source owns; ` +
          '--scan-file adopts a file no patch owns yet.',
        '--scan-file'
      );
    }
    const owner = patches.find((patch) => patch.filesAffected.includes(file));
    if (owner !== undefined) {
      throw new InvalidArgumentError(
        `--scan-file path is already owned by ${owner.filename}: ${file}. ` +
          '--scan-file adopts files no patch owns; move an owned file with --file from its owner.',
        '--scan-file'
      );
    }
    if (!(await pathExists(join(enginePath, file)))) {
      throw new InvalidArgumentError(
        `--scan-file path not found in engine/: ${file}. --scan-file adopts a file the worktree ` +
          'already carries, so it needs content to diff.',
        '--scan-file'
      );
    }
  }
  return files;
}

/**
 * Re-checks under the patch-directory lock that no patch claimed an
 * adopted file while the move waited for confirmation.
 *
 * @param patches - Manifest rows read under the lock
 * @param adoptedFiles - Files the move adopts
 * @param command - Command name for the error
 */
export function assertAdoptedStillUnowned(
  patches: readonly PatchMetadata[],
  adoptedFiles: readonly string[] | undefined,
  command: string
): void {
  for (const file of adoptedFiles ?? []) {
    const owner = patches.find((patch) => patch.filesAffected.includes(file));
    if (owner !== undefined) {
      throw new InvalidArgumentError(
        `Patch queue changed while waiting for confirmation: ${owner.filename} now owns ${file}. Re-run the command.`,
        command
      );
    }
  }
}
