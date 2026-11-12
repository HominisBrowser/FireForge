// SPDX-License-Identifier: EUPL-1.2
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** Digest algorithms FireForge uses: content addresses, and Mozilla's published checksums. */
export type HashAlgorithm = 'sha256' | 'sha512' | 'sha1';

/**
 * Hexadecimal digest of a string (as UTF-8) or of bytes.
 *
 * @param input - The data
 * @param algorithm - Defaults to SHA-256
 */
export function hash(input: string | Uint8Array, algorithm: HashAlgorithm = 'sha256'): string {
  return createHash(algorithm).update(input).digest('hex');
}

/**
 * Hexadecimal digest of a file, streamed so an archive never sits in memory.
 *
 * @param path - The file
 * @param algorithm - Defaults to SHA-256
 */
export async function hashFile(path: string, algorithm: HashAlgorithm = 'sha256'): Promise<string> {
  const digest = createHash(algorithm);
  for await (const chunk of createReadStream(path)) digest.update(chunk as Uint8Array);
  return digest.digest('hex');
}

/** A random identifier (a version 4 UUID). */
export function randomId(): string {
  return randomUUID();
}
