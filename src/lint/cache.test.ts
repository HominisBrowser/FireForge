// SPDX-License-Identifier: EUPL-1.2
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { useTempDir } from '../testing/temp.js';
import { type CachedFinding, pruneCache, readCached, writeCached } from './cache.js';

const dir = useTempDir();

const FINDINGS: CachedFinding[] = [
  { path: 'browser/a.mjs', line: 2, severity: 'error', message: 'TS2322' },
];
const digests = (entries: Record<string, string>): Map<string, string> =>
  new Map(Object.entries(entries));

describe('the TypeScript result cache', () => {
  it('answers while every file the program read keeps its digest', async () => {
    const read = digests({ 'a.mjs': '1', 'b.mjs': '2' });
    await writeCached(dir(), 'key', ['a.mjs', 'b.mjs'], read, FINDINGS);
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
    await writeCached(undefined, 'key', [], new Map(), FINDINGS);
    expect(await readCached(undefined, 'key', new Map())).toBeUndefined();
  });

  it('prunes every entry the run did not use, leaving other files', async () => {
    for (const key of ['kept', 'gone']) await writeCached(dir(), key, [], new Map(), []);
    await writeFile(join(dir(), 'notes.txt'), '');
    await pruneCache(dir(), new Set(['kept']));
    expect((await readdir(dir())).sort()).toEqual(['kept.json', 'notes.txt']);
  });
});
