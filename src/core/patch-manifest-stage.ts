// SPDX-License-Identifier: EUPL-1.2
/**
 * The manifest `patch stage` writes into the git index: HEAD's
 * `patches.json` with only the named patches' rows (and their retired and
 * reserved slots) taken from the working copy.
 *
 * Sessions sharing one checkout each touch their own rows of the shared
 * manifest. Staging the whole file commits every session's rows under one
 * message; staging hunks with `git apply --cached --unidiff-zero` lands a
 * kept insertion at its new-side line number once a dropped hunk above it
 * shifted the file, and committed invalid JSON. Merging rows from the
 * parsed manifests has neither failure: the result is built from structure,
 * then validated before anything is staged.
 */

import type { PatchesManifest, PatchMetadata } from '../types/commands/index.js';
import { toError } from '../utils/errors.js';
import { canonicalizeManifest } from './patch-manifest-key-order.js';
import { validatePatchesManifest } from './patch-manifest-validate.js';
import { carryReservedSlots, carryRetiredSlots } from './patch-retired.js';

/** What staging does to one named patch's row. */
export type StagedRowChange = 'added' | 'updated' | 'removed' | 'unchanged';

/** The staged manifest and the per-patch row changes it carries. */
export interface StagedManifest {
  manifest: PatchesManifest;
  changes: Array<{ filename: string; change: StagedRowChange }>;
}

/**
 * Merges the named rows of `working` into `head`.
 *
 * Rows: every unnamed row comes from HEAD; a named row comes from the
 * working copy, or leaves when the working copy no longer has it.
 * Retired slots: a slot whose `filename` is named follows the working
 * copy, the rest follow HEAD. Reserved slots follow HEAD. A slot whose
 * order a staged row now fills is dropped, as every manifest write does.
 *
 * @param head - HEAD's manifest, or null when HEAD has none
 * @param working - The working-copy manifest
 * @param filenames - Patch filenames whose rows to take from the working copy
 * @returns The validated manifest and the row changes
 * @throws Error when two rows would hold one order, or the merge does not
 *   validate
 */
export function mergeStagedManifest(
  head: PatchesManifest | null,
  working: PatchesManifest,
  filenames: ReadonlySet<string>
): StagedManifest {
  const headRows = head?.patches ?? [];
  const changes: StagedManifest['changes'] = [...filenames].sort().map((filename) => {
    const before = headRows.find((row) => row.filename === filename);
    const after = working.patches.find((row) => row.filename === filename);
    const change: StagedRowChange =
      before === undefined
        ? 'added'
        : after === undefined
          ? 'removed'
          : JSON.stringify(canonicalRow(before)) === JSON.stringify(canonicalRow(after))
            ? 'unchanged'
            : 'updated';
    return { filename, change };
  });

  const rows: PatchMetadata[] = [
    ...headRows.filter((row) => !filenames.has(row.filename)),
    ...working.patches.filter((row) => filenames.has(row.filename)),
  ].sort((a, b) => a.order - b.order || a.filename.localeCompare(b.filename));
  assertNoCollision(rows);

  const retiredSource = [
    ...(head?.retired ?? []).filter((slot) => !filenames.has(slot.filename)),
    ...(working.retired ?? []).filter((slot) => filenames.has(slot.filename)),
  ];
  const retired = carryRetiredSlots({ retired: retiredSource }, rows);
  const reserved = carryReservedSlots(head, rows);
  const merged: PatchesManifest = {
    version: 1,
    patches: rows,
    ...(retired !== undefined ? { retired } : {}),
    ...(reserved !== undefined ? { reserved } : {}),
  };
  try {
    validatePatchesManifest(JSON.parse(JSON.stringify(merged)));
  } catch (error: unknown) {
    throw new Error(`the staged manifest would not validate: ${toError(error).message}`, {
      cause: error,
    });
  }
  return { manifest: canonicalizeManifest(merged), changes };
}

function canonicalRow(row: PatchMetadata): PatchMetadata {
  return canonicalizeManifest({ patches: [row] }).patches[0] as PatchMetadata;
}

function assertNoCollision(rows: readonly PatchMetadata[]): void {
  const seen = new Map<number, string>();
  for (const row of rows) {
    const holder = seen.get(row.order);
    if (holder !== undefined) {
      throw new Error(
        `order ${String(row.order)} would be held by both ${holder} and ${row.filename}; ` +
          'stage the patch that moved off that order as well'
      );
    }
    seen.set(row.order, row.filename);
  }
}

/**
 * Serializes a staged manifest exactly as the manifest writers do, so the
 * staged blob and a later full save of the same content are byte-identical.
 */
export function serializeStagedManifest(manifest: PatchesManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
