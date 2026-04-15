// SPDX-License-Identifier: EUPL-1.2
import type { PatchMetadata } from '../types/commands/index.js';

/**
 * Resolves a patch identifier (ordinal number or filename) to its manifest entry.
 */
export function resolvePatchIdentifier(
  identifier: string,
  patches: PatchMetadata[]
): PatchMetadata | null {
  if (/^\d+$/.test(identifier)) {
    const order = parseInt(identifier, 10);
    return patches.find((p) => p.order === order) ?? null;
  }
  const normalized = identifier.endsWith('.patch') ? identifier : `${identifier}.patch`;
  return patches.find((p) => p.filename === normalized) ?? null;
}
