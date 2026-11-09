// SPDX-License-Identifier: EUPL-1.2
/** What lets a long-lived supervisor ask about the same tools for every job without reading them again. */
import { createHash } from 'node:crypto';
import { link, lstat, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fileDigest, forgetFileDigests } from '../tool-files.js';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
/** Past the window in which a just-changed file's stamp is not yet trusted. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 100));

describe('fileDigest', () => {
  let directory: string;
  let file: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'fireforge-file-digest-'));
    file = join(directory, 'tool');
    await writeFile(file, 'first');
    forgetFileDigests();
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('is the bytes, and does not read a file whose stamp has not moved', async () => {
    await settle();
    const info = await lstat(file);
    expect(await fileDigest(file, info)).toBe(sha256('first'));
    await rm(file);
    // Gone, so only the record can be answering.
    expect(await fileDigest(file, info)).toBe(sha256('first'));
  });

  it('reads every file again once forgotten, which is what a final gate asks', async () => {
    const info = await lstat(file);
    await fileDigest(file, info);
    await rm(file);
    forgetFileDigests();
    await expect(fileDigest(file, info)).rejects.toThrow(/ENOENT/);
  });

  it('sees new bytes of the same size', async () => {
    expect(await fileDigest(file)).toBe(sha256('first'));
    await writeFile(file, 'other');
    expect(await fileDigest(file)).toBe(sha256('other'));
  });

  it('sees a rewrite that put its size and modification time back', async () => {
    // A whole second, so nothing below what utimes can set tells the two writes apart.
    const moment = new Date('2026-01-01T00:00:00Z');
    await utimes(file, moment, moment);
    expect(await fileDigest(file)).toBe(sha256('first'));
    await writeFile(file, 'other');
    await utimes(file, moment, moment);
    expect(await fileDigest(file)).toBe(sha256('other'));
  });

  it('reads a hard link once, however many names it has', async () => {
    const other = join(directory, 'alias');
    await link(file, other);
    await settle();
    const info = await lstat(file);
    await fileDigest(file, info);
    await rm(file);
    // The one surviving name is the inode already read, under a stamp that only the link count moved.
    expect((await lstat(other)).ino).toBe(info.ino);
    expect(await fileDigest(other, info)).toBe(sha256('first'));
  });
});
