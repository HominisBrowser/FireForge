// SPDX-License-Identifier: EUPL-1.2
import { InvalidArgumentError } from '../errors/base.js';
import type { ReExportOptions } from '../types/commands/index.js';
import { info } from '../utils/logger.js';
import { validateScanFileOwners } from './re-export-scan-owner.js';

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
 * `re-export <patch> --files`. Commander's `--files <paths>` consumes one
 * comma-separated value, so `re-export 006-x --files a/b.js c/d.js` parks
 * `c/d.js` in the positional patches and fails with "--files operates on
 * exactly one target patch", pointing at the wrong argument. When every
 * positional beyond the first looks like a file path, fold them into the
 * file list.
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

/**
 * Each carve-out flag is inert without the refusal it modifies, and a
 * silently-inert whitelist is the worst shape: the operator believes an
 * exception is in force while the refusal it was meant to relax was never
 * armed. Refuse the combination instead of ignoring it.
 */
function validateWhitelistFlagDependencies(options: ReExportOptions): void {
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

  if (
    options.expectUnmanaged !== undefined &&
    options.expectUnmanaged.length > 0 &&
    options.refuseAdjacentUnmanaged !== true
  ) {
    throw new InvalidArgumentError(
      '--expect-unmanaged names approved exceptions to --refuse-adjacent-unmanaged and has no effect without it. Pass --refuse-adjacent-unmanaged, or drop --expect-unmanaged.',
      '--expect-unmanaged'
    );
  }

  for (const [flag, values] of [
    ['--expect-new', options.expectNew],
    ['--adjacent-ignore', options.adjacentIgnore],
  ] as const) {
    if (values !== undefined && values.length > 0 && options.refuseAdjacentUnmanaged !== true) {
      throw new InvalidArgumentError(
        `${flag} relaxes --refuse-adjacent-unmanaged and has no effect without it. Pass --refuse-adjacent-unmanaged, or drop ${flag}.`,
        flag
      );
    }
  }
  if (options.adjacentIgnore?.some((entry) => entry.includes('**'))) {
    throw new InvalidArgumentError(
      '--adjacent-ignore takes a path or a glob whose * stays within one path segment; ** is refused, because a subtree carve-out is how a reviewed exception becomes a blanket one.',
      '--adjacent-ignore'
    );
  }
}

/**
 * Refuses a path-valued flag whose value starts with `-`. Commander hands a
 * required option value whatever follows it, so a list that ended early
 * (`--expect-unmanaged --dry-run`) silently turned the next flag into a path
 * and the dry run into a write. No engine path starts with a dash.
 */
function validatePathFlagValues(options: ReExportOptions): void {
  for (const [flag, values] of [
    ['--expect', options.expect],
    ['--expect-unmanaged', options.expectUnmanaged],
    ['--expect-new', options.expectNew],
    ['--expect-removed', options.expectRemoved],
    ['--adjacent-ignore', options.adjacentIgnore],
    ['--scan-file', options.scanFiles],
  ] as const) {
    const swallowed = (values ?? []).filter((value) => value.trim().startsWith('-'));
    if (swallowed.length > 0) {
      throw new InvalidArgumentError(
        `${flag} was given ${swallowed.map((value) => `"${value}"`).join(', ')}, which is a flag, not an engine path: ` +
          `the ${flag} before it had no value, so it took the next argument. Give every ${flag} a path.`,
        flag
      );
    }
  }
}

/**
 * A retirement names its owner among explicitly selected patches. It
 * combines with `--scan`: the retired path leaves the scan's base first,
 * and the scan cannot adopt it back, since a retired created file is absent
 * and a retired upstream file is clean at HEAD.
 */
function validateExpectedRemovalUsage(patches: readonly string[], options: ReExportOptions): void {
  if (
    options.expectRemoved?.length &&
    (options.all || options.files !== undefined || patches.length === 0)
  ) {
    throw new InvalidArgumentError(
      '--expect-removed requires explicit selected patches and cannot combine with --files or --all.',
      '--expect-removed'
    );
  }
}

/**
 * `--hunks-from` and `--exclude-hunks` rebuild one patch's files from named
 * hunks, so they take exactly one explicit patch and no flag that sets the
 * file list another way.
 */
function validateHunkSelectionUsage(patches: readonly string[], options: ReExportOptions): void {
  if (options.hunksFrom !== undefined && options.excludeHunks !== undefined) {
    throw new InvalidArgumentError(
      '--hunks-from and --exclude-hunks are alternatives; pass one.',
      '--hunks-from'
    );
  }
  const flag =
    options.hunksFrom !== undefined
      ? '--hunks-from'
      : options.excludeHunks !== undefined
        ? '--exclude-hunks'
        : undefined;
  if (flag === undefined) return;
  if (
    patches.length !== 1 ||
    options.all ||
    options.scan ||
    options.files !== undefined ||
    options.scanFilesManifest !== undefined
  ) {
    throw new InvalidArgumentError(
      `${flag} rebuilds one patch's files from named hunks: pass exactly one patch, without --scan, --files or --all.`,
      flag
    );
  }
}

/** Validates mutually exclusive `re-export` targeting and metadata options. */
export function validateReExportOptionCombinations(
  patches: readonly string[],
  options: ReExportOptions
): void {
  // First: a swallowed flag would otherwise surface as whichever
  // combination error it happens to trip, naming the wrong problem.
  validatePathFlagValues(options);
  validateExpectedRemovalUsage(patches, options);
  validateHunkSelectionUsage(patches, options);
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
    if (options.all) {
      throw new InvalidArgumentError(
        '--scan-file cannot be combined with --all. Pass the target patch identifiers.',
        '--scan-file'
      );
    }
    validateScanFileOwners(patches, options.scanFiles);
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

  // Beside --scan the belt judges the neighbours the scan did not adopt;
  // --files replaces the file list outright, so there is nothing to judge.
  if (options.refuseAdjacentUnmanaged === true && options.files !== undefined) {
    throw new InvalidArgumentError(
      '--refuse-adjacent-unmanaged cannot be combined with --files (it sets filesAffected explicitly).',
      '--refuse-adjacent-unmanaged'
    );
  }

  // Beside --scan the belt covers the files each patch already owns; the
  // files a scan adopts are the run's stated intent. --files replaces the
  // file list outright, so there is no owned set left to guard.
  if (options.refuseForeignDrift === true && options.files !== undefined) {
    throw new InvalidArgumentError(
      '--refuse-foreign-drift cannot be combined with --files (it sets filesAffected explicitly and captures the current engine state).',
      '--refuse-foreign-drift'
    );
  }

  validateWhitelistFlagDependencies(options);

  const usingTierFlag = options.tier !== undefined;
  const usingLintIgnoreFlag = options.lintIgnore !== undefined && options.lintIgnore.length > 0;
  if (options.all && (usingTierFlag || usingLintIgnoreFlag)) {
    throw new InvalidArgumentError(
      '--tier and --lint-ignore require explicit patch identifiers and cannot be combined with --all (different patches typically need different metadata).',
      '--all'
    );
  }
}
