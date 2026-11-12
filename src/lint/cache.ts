// SPDX-License-Identifier: EUPL-1.2
/**
 * The TypeScript result cache. An entry is keyed by everything that shapes
 * a program except file content (compiler version and options, roots, shim,
 * the set of resolvable modules), and records the digest of every file the
 * program read. It answers only while each of those files still has that
 * digest, so a hit is exactly the result a rebuild would give. Entries are
 * disposable: an unreadable one is a miss and is overwritten.
 */
import { join } from 'node:path';

import { listDir, readTextIfExists, remove, writeFile } from '../kernel/fs.js';
import { parseJson, stringifyJson } from '../kernel/json.js';
import { s } from '../kernel/schema.js';

/** A finding as the cache stores it. */
export interface CachedFinding {
  readonly path: string;
  readonly line: number;
  readonly severity: 'error' | 'warning';
  readonly message: string;
}

const entrySchema = s.object({
  inputs: s.record(s.string()),
  findings: s.array(
    s.object({
      path: s.string(),
      line: s.int({ min: 1 }),
      severity: s.enum(['error', 'warning']),
      message: s.string(),
    })
  ),
});

const fileOf = (cacheDir: string, key: string): string => join(cacheDir, `${key}.json`);

/**
 * The cached findings of a program, when every file it read is unchanged.
 *
 * @param cacheDir - The cache directory, or undefined for no cache
 * @param key - The program's key
 * @param digests - Current content digest per path
 */
export async function readCached(
  cacheDir: string | undefined,
  key: string,
  digests: ReadonlyMap<string, string>
): Promise<CachedFinding[] | undefined> {
  if (cacheDir === undefined) return undefined;
  const text = await readTextIfExists(fileOf(cacheDir, key));
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    value = parseJson(text);
  } catch {
    return undefined;
  }
  const result = entrySchema.validate(value);
  if (!result.ok) return undefined;
  const fresh = Object.entries(result.value.inputs).every(
    ([path, digest]) => digests.get(path) === digest
  );
  return fresh ? result.value.findings : undefined;
}

/**
 * Records a program's findings with the digests of the files it read.
 *
 * @param cacheDir - The cache directory, or undefined for no cache
 * @param key - The program's key
 * @param read - The paths the program read
 * @param digests - Current content digest per path
 * @param findings - The program's findings
 */
export async function writeCached(
  cacheDir: string | undefined,
  key: string,
  read: readonly string[],
  digests: ReadonlyMap<string, string>,
  findings: readonly CachedFinding[]
): Promise<void> {
  if (cacheDir === undefined) return;
  const inputs = Object.fromEntries(read.map((path) => [path, digests.get(path) ?? '']));
  await writeFile(fileOf(cacheDir, key), stringifyJson({ inputs, findings }), { durable: false });
}

/**
 * Removes every entry but the given keys: after a run over every owned
 * file, what it did not use describes programs that no longer exist.
 *
 * @param cacheDir - The cache directory
 * @param keep - Keys the run used
 */
export async function pruneCache(cacheDir: string, keep: ReadonlySet<string>): Promise<void> {
  const entries = await listDir(cacheDir);
  await Promise.all(
    entries
      .filter(
        (entry) => entry.name.endsWith('.json') && !keep.has(entry.name.slice(0, -'.json'.length))
      )
      .map((entry) => remove(join(cacheDir, entry.name)))
  );
}
