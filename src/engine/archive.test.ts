// SPDX-License-Identifier: EUPL-1.2
import { execFile } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { hash } from '../kernel/hash.js';
import { makeSyntheticFirefoxArchive } from '../testing/firefox.js';
import { useTempDir, writeTree } from '../testing/temp.js';
import {
  ensureArchive,
  extractArchive,
  fetchWithRetry,
  sourceArchive,
  unsafeArchiveLink,
  unsafeArchiveMember,
} from './archive.js';
import type { FirefoxPin } from './pin.js';

const run = promisify(execFile);
const dir = useTempDir();

const pin: FirefoxPin = {
  version: '140.9.0esr',
  product: 'firefox-esr',
  allowUnverifiedDownload: false,
};
const archive = sourceArchive(pin);
const bytes = 'small synthetic source archive';
const digest = hash(bytes);

/** A network that serves the archive and whatever `sums` answers for SHA256SUMS. */
function network(sums: () => Response): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const serve = (input: string | URL | Request): Promise<Response> => {
    const url = input as string;
    calls.push(url);
    if (url === archive.url) return Promise.resolve(new Response(bytes));
    return Promise.resolve(
      url === archive.checksumsUrl ? sums() : new Response('', { status: 404 })
    );
  };
  return Object.assign(serve, { calls });
}
const unavailable = (): Response => new Response('', { status: 404 });
const published = (sha256: string) => (): Response =>
  new Response(`${sha256}  ${archive.pathInChecksums}\n`);

async function record(cache: string): Promise<Record<string, unknown>> {
  const text = await readFile(join(cache, `${archive.filename}.json`), 'utf8');
  return JSON.parse(text) as Record<string, unknown>;
}

describe('sourceArchive', () => {
  it.each([
    [
      { version: '147.0', product: 'firefox' },
      'https://archive.mozilla.org/pub/firefox/releases/147.0/source/firefox-147.0.source.tar.xz',
      'firefox-firefox-147.0.source.tar.xz',
    ],
    [
      { version: '140.9.0esr', product: 'firefox-esr' },
      'https://archive.mozilla.org/pub/firefox/releases/140.9.0esr/source/firefox-140.9.0esr.source.tar.xz',
      'firefox-firefox-esr-140.9.0esr.source.tar.xz',
    ],
    [
      { version: '147.0b1', product: 'firefox-devedition' },
      'https://archive.mozilla.org/pub/devedition/releases/147.0b1/source/firefox-147.0b1.source.tar.xz',
      'firefox-firefox-devedition-147.0b1.source.tar.xz',
    ],
    [
      { version: '153.7.0esr', product: 'firefox-esr', candidate: 'build2' },
      'https://archive.mozilla.org/pub/firefox/candidates/153.7.0esr-candidates/build2/source/firefox-153.7.0esr.source.tar.xz',
      'firefox-firefox-esr-153.7.0esr-build2.source.tar.xz',
    ],
  ] as const)('resolves %o', (fields, url, filename) => {
    const resolved = sourceArchive({ ...fields, allowUnverifiedDownload: false });
    expect(resolved.url).toBe(url);
    expect(resolved.filename).toBe(filename);
    expect(resolved.checksumsUrl).toBe(url.replace(/source\/[^/]+$/, 'SHA256SUMS'));
    expect(url.endsWith(resolved.pathInChecksums)).toBe(true);
  });
});

describe('fetchWithRetry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('bounds and retries a response whose body never finishes, even if it ignores the abort', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const request = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return Promise.resolve(new Response(new ReadableStream({ start: () => undefined })));
    });
    const result = fetchWithRetry('https://fixture.invalid/SHA256SUMS', (reply) => reply.text(), {
      fetch: request,
    }).then(
      () => 'unexpected success',
      (error: unknown) => error
    );
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ code: 'download-failed', exitCode: 3 });
    expect(String(await result)).toContain('response body timed out');
    expect(request).toHaveBeenCalledTimes(3);
    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it('retries a failing body and a 503, and keeps the first complete response', async () => {
    const consume = vi
      .fn<(reply: Response) => Promise<string>>()
      .mockRejectedValueOnce(new Error('body reset'))
      .mockResolvedValueOnce('verified sums');
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockImplementation(() => Promise.resolve(new Response('sums')));
    expect(
      await fetchWithRetry('https://fixture.invalid/SHA256SUMS', consume, {
        fetch: request,
        retryDelayMs: 1,
      })
    ).toBe('verified sums');
    expect(request).toHaveBeenCalledTimes(3);
    expect(consume).toHaveBeenCalledTimes(2);
  });

  it('hands a 404 to the caller on the first attempt', async () => {
    const request = vi.fn<typeof fetch>(() => Promise.resolve(new Response('', { status: 404 })));
    expect(
      await fetchWithRetry('https://fixture.invalid/x', (reply) => Promise.resolve(reply.status), {
        fetch: request,
      })
    ).toBe(404);
    expect(request).toHaveBeenCalledOnce();
  });
});

describe('ensureArchive', () => {
  const host = (): { cache: string } => ({ cache: join(dir(), 'cache') });

  it('downloads once, verifies against the published digest, and then uses the cache offline', async () => {
    const online = network(published(digest));
    const path = await ensureArchive(host(), pin, { fetch: online });
    expect(await readFile(path, 'utf8')).toBe(bytes);
    expect(await record(host().cache)).toMatchObject({
      url: archive.url,
      sha256: digest,
      size: bytes.length,
      verification: 'published',
    });
    const offline = network(unavailable);
    expect(await ensureArchive(host(), pin, { fetch: offline })).toBe(path);
    expect(offline.calls).toEqual([]);
  });

  it('refuses a download whose digest differs from the published or the pinned one, and keeps nothing', async () => {
    await expect(
      ensureArchive(host(), pin, { fetch: network(published('0'.repeat(64))) })
    ).rejects.toMatchObject({ code: 'checksum-mismatch', exitCode: 3 });
    await expect(
      ensureArchive(host(), { ...pin, sha256: '1'.repeat(64) }, { fetch: network(unavailable) })
    ).rejects.toMatchObject({ code: 'checksum-mismatch' });
    await expect(readFile(join(host().cache, archive.filename))).rejects.toThrow();
  });

  it('fails closed when the published digest cannot be fetched, unless the project opted out', async () => {
    await expect(ensureArchive(host(), pin, { fetch: network(unavailable) })).rejects.toMatchObject(
      { code: 'checksum-unavailable', exitCode: 3 }
    );
    const html = network(() => new Response('<html>sign in to the hotel network</html>'));
    await expect(ensureArchive(host(), pin, { fetch: html })).rejects.toMatchObject({
      code: 'checksum-unavailable',
    });
    await ensureArchive(
      host(),
      { ...pin, allowUnverifiedDownload: true },
      { fetch: network(unavailable) }
    );
    expect((await record(host().cache))['verification']).toBe('unverified');
  });

  it('does not silently accept an unverified cache after its opt-in is removed', async () => {
    const lenient = { ...pin, allowUnverifiedDownload: true };
    await ensureArchive(host(), lenient, { fetch: network(unavailable) });
    const later = network(unavailable);
    await expect(ensureArchive(host(), pin, { fetch: later })).rejects.toThrow('SHA256SUMS');
    expect(later.calls).not.toContain(archive.url);
    expect(await readFile(join(host().cache, archive.filename), 'utf8')).toBe(bytes);
  });

  it('re-verifies an unverified entry without downloading again, and only once', async () => {
    const lenient = { ...pin, allowUnverifiedDownload: true };
    await ensureArchive(host(), lenient, { fetch: network(unavailable) });
    const online = network(published(digest));
    await ensureArchive(host(), pin, { fetch: online });
    expect(online.calls).toEqual([archive.checksumsUrl]);
    expect((await record(host().cache))['verification']).toBe('published');
    const again = network(published(digest));
    await ensureArchive(host(), pin, { fetch: again });
    expect(again.calls).toEqual([]);
  });

  it('accepts a matching pinned digest offline and still refuses a later published mismatch', async () => {
    const lenient = { ...pin, allowUnverifiedDownload: true };
    await ensureArchive(host(), lenient, { fetch: network(unavailable) });
    const offline = network(unavailable);
    await ensureArchive(host(), { ...pin, sha256: digest }, { fetch: offline });
    expect(offline.calls).toEqual([]);
    await expect(
      ensureArchive(host(), pin, { fetch: network(published('0'.repeat(64))) })
    ).rejects.toMatchObject({ code: 'checksum-mismatch' });
  });

  it('downloads again when the cached file is not the one its record describes', async () => {
    await ensureArchive(host(), pin, { fetch: network(published(digest)) });
    await writeFile(join(host().cache, archive.filename), 'tampered with, same record');
    const online = network(published(digest));
    const path = await ensureArchive(host(), pin, { fetch: online });
    expect(online.calls).toContain(archive.url);
    expect(await readFile(path, 'utf8')).toBe(bytes);
  });

  it('reports a release Mozilla does not publish', async () => {
    const missing: typeof fetch = () => Promise.resolve(new Response('', { status: 404 }));
    await expect(ensureArchive(host(), pin, { fetch: missing })).rejects.toMatchObject({
      code: 'version-not-found',
      exitCode: 3,
    });
  });
});

describe('archive member checks', () => {
  it.each([
    ['firefox-140.0/browser/app.js', false],
    ['firefox-140.0/.gitignore', false],
    ['firefox-140.0/.gitmodules', false],
    ['/etc/passwd', true],
    ['firefox-140.0/../../outside', true],
    ['C:\\Windows\\system.ini', true],
    ['firefox-140.0/.git/config', true],
    ['firefox-140.0/sub/.GIT/hooks/pre-commit', true],
    ['', false],
  ])('member %j is unsafe: %s', (name, unsafe) => {
    expect(unsafeArchiveMember(name) !== undefined).toBe(unsafe);
  });

  it.each([
    ['lrwxr-xr-x  0 user group 0 Jan  1 00:00 firefox/link -> ../sibling/file', true],
    ['lrwxr-xr-x  0 user group 0 Jan  1 00:00 firefox/link -> target/file', false],
    ['lrwxr-xr-x  0 user group 0 Jan  1 00:00 firefox/a -> b -> /etc/passwd', true],
    ['hrw-r--r--  0 user group 0 Jan  1 00:00 firefox/hard link to /etc/shadow', true],
    ['hrw-r--r--  0 user group 0 Jan  1 00:00 firefox/hard link to firefox/other', false],
    ['-rw-r--r--  0 user group 9 Jan  1 00:00 firefox/notes -> not a link.txt', false],
  ])('link line %j is unsafe: %s', (line, unsafe) => {
    expect(unsafeArchiveLink(line) !== undefined).toBe(unsafe);
  });
});

// The archive is packed and extracted by a `tar` that handles xz.
describe.skipIf(process.platform === 'win32')('extractArchive', () => {
  it('makes the destination the source tree itself', async () => {
    const packed = await makeSyntheticFirefoxArchive(dir(), '140.9.0esr', {
      'browser/config/version.txt': '140.9.0\n',
    });
    const tree = join(dir(), 'out', 'tree');
    await extractArchive(packed, tree);
    expect(await readFile(join(tree, 'browser/config/version.txt'), 'utf8')).toBe('140.9.0\n');
    expect(await readFile(join(tree, 'mach'), 'utf8')).toContain('python3');
    expect(await readdir(join(dir(), 'out'))).toEqual(['tree']);
  });

  it('refuses an archive that would plant a .git directory, and drops it from the cache', async () => {
    await writeTree(join(dir(), 'evil'), {
      'firefox-1.0/mach': '#!/bin/sh\n',
      'firefox-1.0/.git/config': '[core]\n\tfsmonitor = /tmp/payload\n',
    });
    const packed = join(dir(), 'evil.tar.xz');
    await run('tar', ['-cJf', packed, '-C', join(dir(), 'evil'), 'firefox-1.0']);
    await writeFile(`${packed}.json`, '{}');
    const tree = join(dir(), 'tree');
    await expect(extractArchive(packed, tree)).rejects.toMatchObject({
      code: 'extract-failed',
      exitCode: 3,
      message: expect.stringContaining('.git') as string,
    });
    await expect(readFile(join(tree, 'mach'))).rejects.toThrow();
    await expect(readFile(packed)).rejects.toThrow();
    await expect(readFile(`${packed}.json`)).rejects.toThrow();
  });

  it('refuses a file that is not an archive', async () => {
    const bogus = join(dir(), 'bogus.tar.xz');
    await writeFile(bogus, 'not an archive');
    await expect(extractArchive(bogus, join(dir(), 'tree'))).rejects.toMatchObject({
      code: 'extract-failed',
    });
  });
});
