// SPDX-License-Identifier: EUPL-1.2
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { configureLog } from '../kernel/log.js';
import { useTempDir } from '../testing/temp.js';
import { type CachedFinding, cacheWarner, pruneCache, readCached, writeCached } from './cache.js';

const dir = useTempDir();

const FINDINGS: CachedFinding[] = [
  { path: 'browser/a.mjs', line: 2, severity: 'error', message: 'TS2322' },
];
const digests = (entries: Record<string, string>): Map<string, string> =>
  new Map(Object.entries(entries));

describe('the TypeScript result cache', () => {
  it('answers while every file the program read keeps its digest', async () => {
    const read = digests({ 'a.mjs': '1', 'b.mjs': '2' });
    await writeCached(dir(), 'key', {
      read: ['a.mjs', 'b.mjs'],
      digests: read,
      findings: FINDINGS,
    });
    expect(await readCached(dir(), 'key', read)).toEqual(FINDINGS);
    // A file the program never read may change freely.
    expect(await readCached(dir(), 'key', digests({ 'a.mjs': '1', 'b.mjs': '2', c: '9' }))).toEqual(
      FINDINGS
    );
    expect(await readCached(dir(), 'key', digests({ 'a.mjs': '1', 'b.mjs': '3' }))).toBeUndefined();
    expect(await readCached(dir(), 'key', digests({ 'a.mjs': '1' }))).toBeUndefined();
    expect(await readCached(dir(), 'other', read)).toBeUndefined();
  });

  it('treats an unreadable entry as a miss, and does nothing without a directory', async () => {
    await writeFile(join(dir(), 'broken.json'), '{ not json');
    await writeFile(join(dir(), 'shape.json'), JSON.stringify({ inputs: {}, findings: [{}] }));
    expect(await readCached(dir(), 'broken', new Map())).toBeUndefined();
    expect(await readCached(dir(), 'shape', new Map())).toBeUndefined();
    await writeCached(undefined, 'key', { read: [], digests: new Map(), findings: FINDINGS });
    expect(await readCached(undefined, 'key', new Map())).toBeUndefined();
  });

  it('survives a cache that cannot be read, written or pruned, telling the caller', async () => {
    // A directory where the entry file belongs: reading it fails with a real I/O error.
    await mkdir(join(dir(), 'key.json'));
    const failures: unknown[] = [];
    const onFailure = (error: unknown): void => void failures.push(error);
    expect(await readCached(dir(), 'key', new Map(), onFailure)).toBeUndefined();
    await writeCached(
      dir(),
      'key',
      { read: [], digests: new Map(), findings: FINDINGS },
      onFailure
    );
    expect(failures).toHaveLength(2);
    // The cache directory itself is a file.
    const file = join(dir(), 'file');
    await writeFile(file, '');
    await writeCached(file, 'key', { read: [], digests: new Map(), findings: FINDINGS }, onFailure);
    await pruneCache(file, new Set(), onFailure);
    expect(await readCached(file, 'key', new Map(), onFailure)).toBeUndefined();
    expect(failures.length).toBeGreaterThanOrEqual(3);
    // Without a handler the failures are still not thrown.
    await expect(
      writeCached(file, 'key', { read: [], digests: new Map(), findings: FINDINGS })
    ).resolves.toBeUndefined();
  });

  it('warns once however many operations fail', () => {
    const lines: string[] = [];
    const previous = configureLog({ write: (text) => lines.push(text) });
    try {
      const failed = cacheWarner('/cache');
      failed(new Error('first'));
      failed(new Error('second'));
    } finally {
      configureLog(previous);
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('first');
  });

  it('prunes every entry the run did not use, leaving other files', async () => {
    for (const key of ['kept', 'gone'])
      await writeCached(dir(), key, { read: [], digests: new Map(), findings: [] });
    await writeFile(join(dir(), 'notes.txt'), '');
    await pruneCache(dir(), new Set(['kept']));
    expect((await readdir(dir())).sort()).toEqual(['kept.json', 'notes.txt']);
  });
});
