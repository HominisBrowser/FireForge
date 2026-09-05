// SPDX-License-Identifier: EUPL-1.2

/** Extracts per-component checksums from the flattened state-file checksum map. */
export function extractComponentChecksums(
  allChecksums: Record<string, string> | undefined,
  type: string,
  name: string
): Record<string, string> {
  if (!allChecksums) return {};

  const prefix = `${type}/${name}/`;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(allChecksums)) {
    if (key.startsWith(prefix)) {
      result[key.slice(prefix.length)] = value;
    }
  }

  return result;
}

/** Prefixes component checksums so they can be stored in the flattened state format. */
export function prefixChecksums(
  checksums: Record<string, string>,
  type: string,
  name: string
): Record<string, string> {
  const prefix = `${type}/${name}/`;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(checksums)) {
    result[`${prefix}${key}`] = value;
  }

  return result;
}

/**
 * Returns the filenames present in `previous` that are absent from
 * `current`, i.e. files we know we deployed last time but the workspace has
 * since deleted. The order of returned names is stable (sorted
 * alphabetically) so test snapshots and CLI output are deterministic.
 */
export function diffDeletedFiles(
  previous: Record<string, string>,
  current: Record<string, string>
): string[] {
  const deleted: string[] = [];
  for (const key of Object.keys(previous)) {
    if (!(key in current)) {
      deleted.push(key);
    }
  }
  return deleted.sort();
}

/**
 * Canonical content normalization for every FireForge component checksum.
 *
 * Strips a leading BOM and folds CRLF to LF, so a file that differs from its
 * deployed copy only by line endings or a byte-order mark is not reported as
 * drift. Every comparison that decides "has this component changed?" must
 * use it. Otherwise `furnace status` and `furnace validate` can disagree
 * with `apply`'s skip fast-path about the same pair of files on a CRLF
 * checkout.
 *
 * @param content - Raw file content
 * @returns Content with the BOM removed and CRLF folded to LF
 */
export function normalizeForChecksum(content: string): string {
  return content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}
