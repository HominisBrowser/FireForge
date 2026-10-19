// SPDX-License-Identifier: EUPL-1.2
/**
 * The one key order every `patches.json` writer uses for a patch row and
 * for the manifest itself. Writers used to disagree: `export` spread
 * `sourceProduct` before `sourceVersion` while a full-manifest save put it
 * after `filesAffected`, so a no-op rewrite left a key-order-only hunk in
 * the manifest.
 */

/** Patch-row keys in the order of the `PatchMetadata` interface. */
const PATCH_ROW_KEY_ORDER = [
  'filename',
  'order',
  'category',
  'name',
  'description',
  'createdAt',
  'sourceEsrVersion',
  'sourceProduct',
  'sourceVersion',
  'filesAffected',
  'lintIgnore',
  'tier',
  'stagedDependencies',
] as const;

/** Manifest keys in the order of the `PatchesManifest` interface. */
const MANIFEST_KEY_ORDER = ['version', 'patches', 'retired', 'reserved'] as const;

function reorder<T extends object>(value: T, order: readonly string[]): T {
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of order) {
    if (Object.hasOwn(source, key)) out[key] = source[key];
  }
  // Keys this build does not know keep their relative order after the
  // known ones, so a newer writer's fields survive an older rewrite.
  for (const key of Object.keys(source)) {
    if (!Object.hasOwn(out, key)) out[key] = source[key];
  }
  return out as T;
}

/**
 * Returns a copy of a patch row with its keys in canonical order.
 *
 * @param row - A `PatchMetadata` row, typed or raw
 * @returns The same fields in canonical key order
 */
export function canonicalizePatchRow<T extends object>(row: T): T {
  return reorder(row, PATCH_ROW_KEY_ORDER);
}

/**
 * Returns a copy of a manifest with its top-level keys and every row in
 * canonical order.
 *
 * @param manifest - A `PatchesManifest`, typed or raw
 * @returns The manifest in canonical key order
 */
export function canonicalizeManifest<T extends { patches: readonly object[] }>(manifest: T): T {
  const ordered = reorder(manifest, MANIFEST_KEY_ORDER);
  return { ...ordered, patches: manifest.patches.map((row) => canonicalizePatchRow(row)) };
}
