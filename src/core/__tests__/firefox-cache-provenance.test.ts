// SPDX-License-Identifier: EUPL-1.2
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveArchive } from '../firefox-archive.js';
import { ensureCachedArchive } from '../firefox-cache.js';
import { downloadFile } from '../firefox-download.js';

vi.mock('../firefox-download.js', async (original) => ({
  ...(await original<typeof import('../firefox-download.js')>()),
  downloadFile: vi.fn(),
}));
let root: string;
const bytes = 'small synthetic source archive';
const digest = createHash('sha256').update(bytes).digest('hex');
const archive = resolveArchive('140.9.0esr', 'firefox-esr');
const unavailable = (): Promise<Response> => Promise.resolve(new Response('', { status: 404 }));
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ff-cache-provenance-'));
  vi.mocked(downloadFile).mockImplementation(async (_url, path) => {
    await writeFile(path, bytes);
    return Buffer.byteLength(bytes);
  });
  vi.clearAllMocks();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});
async function metadata(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, archive.metadataFilename), 'utf8')) as Record<
    string,
    unknown
  >;
}

describe('source archive verification provenance', () => {
  it('does not silently accept an unverified cache after disabling its opt-in', async () => {
    vi.stubGlobal('fetch', unavailable);
    await ensureCachedArchive(archive, root, undefined, undefined, undefined, {
      allowUnverifiedDownload: true,
    });
    expect((await metadata())['verification']).toBe('unverified');
    vi.mocked(downloadFile).mockClear();
    await expect(ensureCachedArchive(archive, root)).rejects.toThrow('SHA256');
    expect(downloadFile).not.toHaveBeenCalled();
    expect(await readFile(join(root, archive.filename), 'utf8')).toBe(bytes);
  });

  it('reverifies and upgrades previously unverified or legacy entries without downloading again', async () => {
    vi.stubGlobal('fetch', unavailable);
    await ensureCachedArchive(archive, root, undefined, undefined, undefined, {
      allowUnverifiedDownload: true,
    });
    const old = await metadata();
    delete old['verification'];
    await writeFile(join(root, archive.metadataFilename), JSON.stringify(old));
    vi.mocked(downloadFile).mockClear();
    const fetch = vi.fn(() =>
      Promise.resolve(new Response(`${digest}  ${archive.pathInChecksums}\n`))
    );
    vi.stubGlobal('fetch', fetch);
    await ensureCachedArchive(archive, root);
    expect((await metadata())['verification']).toBe('published');
    expect(downloadFile).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
    fetch.mockClear();
    await ensureCachedArchive(archive, root);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('accepts an explicit matching operator pin and still refuses a later published mismatch', async () => {
    vi.stubGlobal('fetch', unavailable);
    await ensureCachedArchive(archive, root, undefined, undefined, undefined, {
      allowUnverifiedDownload: true,
    });
    const fetch = vi.fn(unavailable);
    vi.stubGlobal('fetch', fetch);
    await ensureCachedArchive(archive, root, undefined, digest);
    expect(fetch).not.toHaveBeenCalled();
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response(`${'0'.repeat(64)}  ${archive.pathInChecksums}\n`))
    );
    await expect(ensureCachedArchive(archive, root)).rejects.toThrow();
  });
});
