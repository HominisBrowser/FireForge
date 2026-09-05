// SPDX-License-Identifier: EUPL-1.2

import { createHash } from 'node:crypto';

/**
 * Computes the hexadecimal SHA-256 digest of a string or buffer.
 *
 * Eleven sites across `src/core/` inlined the same
 * `createHash('sha256').update(input).digest('hex')` chain for cache keys,
 * fingerprints and content addresses. They all share this helper instead, so
 * the digest algorithm and encoding are decided in exactly one place.
 *
 * @param input - Data to digest, as a UTF-8 string or a raw buffer.
 * @returns The 64-character lowercase hexadecimal digest.
 */
export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}
