// SPDX-License-Identifier: EUPL-1.2
import { InvalidArgumentError } from '../errors/base.js';
import type { ReExportOptions } from '../types/commands/index.js';

/** Validates mutually exclusive `re-export` targeting and metadata options. */
export function validateReExportOptionCombinations(
  patches: readonly string[],
  options: ReExportOptions
): void {
  if (options.files !== undefined) {
    if (options.all || options.scan) {
      throw new InvalidArgumentError('--files cannot be combined with --scan or --all.', '--files');
    }
    if (options.scanFilesManifest !== undefined) {
      throw new InvalidArgumentError('--files cannot be combined with --scan-files.', '--files');
    }
    if (patches.length !== 1) {
      throw new InvalidArgumentError(
        '--files operates on exactly one target patch. Pass a single patch identifier.',
        '--files'
      );
    }
  }

  if (options.scanFiles !== undefined) {
    if (!options.scan)
      throw new InvalidArgumentError('--scan-file requires --scan.', '--scan-file');
    if (options.scanFilesManifest !== undefined) {
      throw new InvalidArgumentError(
        '--scan-file cannot be combined with --scan-files.',
        '--scan-file'
      );
    }
    if (options.all || patches.length !== 1) {
      throw new InvalidArgumentError(
        '--scan-file operates on exactly one target patch. Pass a single patch identifier.',
        '--scan-file'
      );
    }
  }

  if (options.scanFilesManifest !== undefined) {
    if (!options.scan)
      throw new InvalidArgumentError('--scan-files requires --scan.', '--scan-files');
    if (options.all || patches.length > 0) {
      throw new InvalidArgumentError(
        '--scan-files selects patches from its manifest and cannot be combined with positional patches or --all.',
        '--scan-files'
      );
    }
  }

  const usingTierFlag = options.tier !== undefined;
  const usingLintIgnoreFlag = options.lintIgnore !== undefined && options.lintIgnore.length > 0;
  if (options.all && (usingTierFlag || usingLintIgnoreFlag)) {
    throw new InvalidArgumentError(
      '--tier and --lint-ignore require explicit patch identifiers and cannot be combined with --all (different patches typically need different metadata).',
      '--all'
    );
  }
}
