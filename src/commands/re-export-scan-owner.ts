// SPDX-License-Identifier: EUPL-1.2
/**
 * Per-file owners for `re-export --scan --scan-file <patch>:<path>`.
 *
 * One change often spans a patch that creates files and a patch that
 * registers or imports them. With `--scan-file` bound to a single target
 * patch, that change took two invocations, and the adopting one could not
 * carry the belts the other did. Naming the owner per file lets one call
 * adopt each file into its patch while every other selected patch
 * refreshes scan-less, all under the same `--refuse-foreign-drift` belt
 * and in a single engine-lock hold.
 */

import { formatPatchNotFoundError } from '../core/patch-identifier-suggest.js';
import { resolvePatchIdentifier } from '../core/patch-manifest.js';
import { InvalidArgumentError } from '../errors/base.js';
import type { PatchesManifest, PatchMetadata, ReExportOptions } from '../types/commands/index.js';

/** A `--scan-file` value split into its optional owner and its path. */
export interface ScanFileOwnerSpec {
  owner: string | undefined;
  path: string;
}

/**
 * Splits `<patch>:<path>` into owner and path. The owner is everything
 * before the first `:`, and only when that part holds no path separator, so
 * a plain path (even one with a later `:`) stays a path. A one-letter
 * prefix before `:/` or `:\` reads as a Windows drive, not a patch.
 */
export function splitScanFileOwner(raw: string): ScanFileOwnerSpec {
  const colon = raw.indexOf(':');
  if (colon <= 0) return { owner: undefined, path: raw };
  const owner = raw.slice(0, colon).trim();
  const path = raw.slice(colon + 1);
  if (owner.length === 0 || /[/\\]/.test(owner)) return { owner: undefined, path: raw };
  if (/^[A-Za-z]$/.test(owner) && /^[/\\]/.test(path)) return { owner: undefined, path: raw };
  return { owner, path };
}

/** Rejoins a split value, so normalization can rewrite the path half only. */
export function joinScanFileOwner(spec: ScanFileOwnerSpec): string {
  return spec.owner === undefined ? spec.path : `${spec.owner}:${spec.path}`;
}

/**
 * Argument-shape check, before any manifest is read: a multi-patch call has
 * to say which patch each file joins.
 */
export function validateScanFileOwners(
  patches: readonly string[],
  scanFiles: readonly string[]
): void {
  if (patches.length === 0) {
    throw new InvalidArgumentError(
      '--scan-file needs explicit target patch identifiers.',
      '--scan-file'
    );
  }
  if (patches.length === 1) return;
  const unowned = scanFiles.filter((file) => splitScanFileOwner(file).owner === undefined);
  if (unowned.length > 0) {
    throw new InvalidArgumentError(
      `--scan-file in a call with ${patches.length} patches must name each file's owning patch ` +
        `as <patch>:<path> (for example --scan-file ${patches[0] ?? '201'}:${unowned[0] ?? '<path>'}). ` +
        `Missing an owner: ${unowned.join(', ')}.`,
      '--scan-file'
    );
  }
}

/**
 * Resolves each `--scan-file` value to its owning selected patch. Returns
 * `undefined` when no `--scan-file` was given. An unprefixed path belongs
 * to the single selected patch (the historical form).
 */
export function assignScanFileOwners(
  scanFiles: readonly string[] | undefined,
  selectedPatches: readonly PatchMetadata[],
  manifest: PatchesManifest
): Map<string, string[]> | undefined {
  if (scanFiles === undefined) return undefined;
  const selected = new Set(selectedPatches.map((patch) => patch.filename));
  const byPatch = new Map<string, string[]>();
  const ownerByFile = new Map<string, string>();
  for (const raw of scanFiles) {
    const { owner, path } = splitScanFileOwner(raw);
    const filename = resolveOwner(owner, selectedPatches, manifest);
    if (!selected.has(filename)) {
      throw new InvalidArgumentError(
        `--scan-file ${raw}: ${filename} is not among the selected patches. ` +
          'Pass it as a positional patch too.',
        '--scan-file'
      );
    }
    const previous = ownerByFile.get(path);
    if (previous !== undefined && previous !== filename) {
      throw new InvalidArgumentError(
        `--scan-file path is assigned to more than one patch: ${path} (${previous}, ${filename})`,
        '--scan-file'
      );
    }
    ownerByFile.set(path, filename);
    const files = byPatch.get(filename) ?? [];
    if (!files.includes(path)) files.push(path);
    byPatch.set(filename, files);
  }
  for (const files of byPatch.values()) files.sort();
  return byPatch;
}

function resolveOwner(
  owner: string | undefined,
  selectedPatches: readonly PatchMetadata[],
  manifest: PatchesManifest
): string {
  if (owner === undefined) {
    const only = selectedPatches.length === 1 ? selectedPatches[0] : undefined;
    if (only === undefined) {
      throw new InvalidArgumentError(
        '--scan-file in a multi-patch call must name its owning patch as <patch>:<path>.',
        '--scan-file'
      );
    }
    return only.filename;
  }
  const match = resolvePatchIdentifier(owner, manifest.patches);
  if (!match) {
    throw new InvalidArgumentError(
      `--scan-file: ${formatPatchNotFoundError(owner, manifest.patches)}`,
      '--scan-file'
    );
  }
  return match.filename;
}

/**
 * The options one patch of the loop runs with. A patch with assigned files
 * adopts exactly those; a selected patch without any refreshes scan-less,
 * because `--scan` beside per-file owners scopes adoption to the named
 * files rather than arming a broad directory scan for every other patch.
 */
export function scanOptionsForPatch(
  options: ReExportOptions,
  patchFilename: string,
  assignments: ReadonlyMap<string, string[]> | undefined
): ReExportOptions {
  if (assignments === undefined) return options;
  const assigned = assignments.get(patchFilename);
  if (assigned !== undefined) return { ...options, scanFiles: assigned };
  const scanLess: ReExportOptions = { ...options, scan: false };
  delete scanLess.scanFiles;
  return scanLess;
}
