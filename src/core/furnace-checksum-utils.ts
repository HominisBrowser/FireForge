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
