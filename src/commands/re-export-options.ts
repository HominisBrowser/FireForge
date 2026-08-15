// SPDX-License-Identifier: EUPL-1.2
import { InvalidArgumentError } from '../errors/base.js';
import type { ReExportOptions } from '../types/commands/index.js';
import { info } from '../utils/logger.js';

/**
 * Heuristic for `--files` positional folding: an extra positional that
 * contains a path separator and is not a `.patch` filename is an engine
 * file path, not a patch identifier.
 */
function looksLikeFilePath(value: string): boolean {
  return value.includes('/') && !value.endsWith('.patch');
}

/** Result of {@link normalizeReExportFilesPositionals}. */
export interface NormalizedReExportArguments {
  patches: string[];
  options: ReExportOptions;
  /** Extra positionals that were folded into the `--files` list. */
  foldedPaths: string[];
}

/**
 * Accepts the `export`-style space-separated path shape for
 * `re-export <patch> --files` (0.34.0 field report): commander's
 * `--files <paths>` consumes one comma-separated value, so
 * `re-export 006-x --files a/b.js c/d.js` used to park `c/d.js` in the
 * positional patches and fail with "--files operates on exactly one
 * target patch" — pointing at the wrong argument. When every positional
 * beyond the first looks like a file path, fold them into the file list.
 */
export function normalizeReExportFilesPositionals(
  patches: readonly string[],
  options: ReExportOptions
): NormalizedReExportArguments {
  if (options.files === undefined || patches.length <= 1) {
    return { patches: [...patches], options, foldedPaths: [] };
  }
  const [first, ...rest] = patches;
  if (first !== undefined && rest.every(looksLikeFilePath)) {
    return {
      patches: [first],
      options: { ...options, files: [...options.files, ...rest] },
      foldedPaths: rest,
    };
  }
  return { patches: [...patches], options, foldedPaths: [] };
}

/**
 * Folding wrapper used by the command layer: applies
 * {@link normalizeReExportFilesPositionals} and logs the folded paths so
 * the operator sees exactly which positionals became file-list entries.
 */
export function applyReExportFilesPositionalFolding(
  patches: string[],
  options: ReExportOptions
): { patches: string[]; options: ReExportOptions } {
  const normalized = normalizeReExportFilesPositionals(patches, options);
  if (normalized.foldedPaths.length > 0) {
    info(
      `--files: treating ${normalized.foldedPaths.length} extra positional path(s) as part ` +
        `of the file list: ${normalized.foldedPaths.join(', ')}`
    );
  }
  return { patches: normalized.patches, options: normalized.options };
}

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
        '--files operates on exactly one target patch. Pass a single patch identifier. ' +
          'File paths can be passed space-separated after --files (path-shaped extras are folded ' +
          'into the file list automatically) or as one comma-separated --files value.',
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

  if (options.refuseAdjacentUnmanaged === true && (options.scan || options.files !== undefined)) {
    throw new InvalidArgumentError(
      '--refuse-adjacent-unmanaged applies to the scan-less path only and cannot be combined with --scan or --files (those set filesAffected explicitly).',
      '--refuse-adjacent-unmanaged'
    );
  }

  if (options.refuseForeignDrift === true && (options.scan || options.files !== undefined)) {
    throw new InvalidArgumentError(
      '--refuse-foreign-drift applies to the scan-less path only and cannot be combined with --scan or --files (those explicitly capture the current engine state).',
      '--refuse-foreign-drift'
    );
  }

  if (
    options.expect !== undefined &&
    options.expect.length > 0 &&
    options.refuseForeignDrift !== true
  ) {
    throw new InvalidArgumentError(
      '--expect names files whose drift is expected under --refuse-foreign-drift and has no effect without it. Pass --refuse-foreign-drift, or drop --expect.',
      '--expect'
    );
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
