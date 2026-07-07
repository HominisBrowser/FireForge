// SPDX-License-Identifier: EUPL-1.2
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getDownloadUrl, getTarballFilename } from '../../core/firefox.js';
import {
  createTempProject,
  makeTarXzArchive,
  readProjectText,
  removeTempProject,
  writeFiles,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import { downloadCommand } from '../download.js';

// The spinner mock tracks `message(...)` calls so tests can assert that
// runGit-init progress flowed through the spinner — 0.16.0 removed the
// redundant `step(...)` call that the resume/init paths used to make
// alongside `spinner.message(...)`, because the non-TTY spinner fallback
// already emits `p.log.step(msg)` from `.message()`. Recording the
// per-handle `message` calls lets integration tests verify the contract
// without coupling to internal fallback wiring.
const spinnerMessageCalls: string[] = [];
vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  verbose: vi.fn(),
  step: vi.fn(),
  spinner: vi.fn(() => ({
    stop: vi.fn(),
    error: vi.fn(),
    message: vi.fn((msg: string) => {
      spinnerMessageCalls.push(msg);
    }),
  })),
}));

describe('downloadCommand integration', () => {
  let projectRoot: string;
  let fetchMock: ReturnType<typeof vi.fn<(url: unknown) => Promise<Response>>>;

  beforeEach(async () => {
    projectRoot = await createTempProject();
    fetchMock = vi.fn<(url: unknown) => Promise<Response>>();
    vi.stubGlobal('fetch', fetchMock);
    spinnerMessageCalls.length = 0;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await removeTempProject(projectRoot);
  });

  /**
   * Installs a URL-dispatching fetch: archive bodies are served per URL and
   * SHA256SUMS requests get a 404 (exercising the warn-and-continue path of
   * the default integrity check). Response objects are created per call —
   * a Response body is single-use, so serving a shared instance would fail
   * on the second read.
   */
  function installUrlFetch(bodies: Record<string, Buffer>, sha256sumsBody?: string): void {
    fetchMock.mockImplementation((url: unknown) => {
      const key = String(url);
      if (key.endsWith('/SHA256SUMS')) {
        return Promise.resolve(
          sha256sumsBody !== undefined
            ? new Response(sha256sumsBody, { status: 200 })
            : new Response('not found', { status: 404 })
        );
      }
      const body = bodies[key];
      if (!body) {
        return Promise.reject(new Error(`Unexpected fetch in test: ${key}`));
      }
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { 'content-length': String(body.length) },
        })
      );
    });
  }

  /** Counts fetch calls that requested actual archives (not SHA256SUMS). */
  function archiveFetchCount(): number {
    return fetchMock.mock.calls.filter((call) => !String(call[0]).endsWith('/SHA256SUMS')).length;
  }

  it('keeps stable and ESR cache entries separate', async () => {
    const stableArchive = await makeTarXzArchive(projectRoot, 'stable.tar.xz', 'firefox-140.0', {
      'browser/config/version.txt': '140.0\n',
    });
    const esrArchive = await makeTarXzArchive(projectRoot, 'esr.tar.xz', 'firefox-140.9.0esr', {
      'browser/config/version.txt': '140.9.0esr\n',
    });

    const stableBody = await readFile(stableArchive);
    const esrBody = await readFile(esrArchive);

    installUrlFetch({
      [getDownloadUrl('140.0', 'firefox')]: stableBody,
      [getDownloadUrl('140.9.0esr', 'firefox-esr')]: esrBody,
    });

    await writeFireForgeConfig(projectRoot, {
      firefox: { version: '140.0', product: 'firefox' },
    });
    await downloadCommand(projectRoot, {});

    await writeFireForgeConfig(projectRoot, {
      firefox: { version: '140.9.0esr', product: 'firefox-esr' },
    });
    await downloadCommand(projectRoot, { force: true });

    const stableCache = join(
      projectRoot,
      '.fireforge/cache',
      getTarballFilename('140.0', 'firefox')
    );
    const esrCache = join(
      projectRoot,
      '.fireforge/cache',
      getTarballFilename('140.9.0esr', 'firefox-esr')
    );

    await expect(readFile(stableCache)).resolves.toBeTruthy();
    await expect(readFile(esrCache)).resolves.toBeTruthy();
    expect(archiveFetchCount()).toBe(2);
    expect(fetchMock).toHaveBeenCalledWith(
      getDownloadUrl('140.0', 'firefox'),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest asymmetric matcher
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      getDownloadUrl('140.9.0esr', 'firefox-esr'),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest asymmetric matcher
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('downloads Developer Edition source from the devedition archive with a pinned checksum', async () => {
    const archivePath = await makeTarXzArchive(
      projectRoot,
      'devedition.tar.xz',
      'firefox-152.0b6',
      {
        'browser/config/version.txt': '152.0b6\n',
      }
    );
    const archiveBody = await readFile(archivePath);
    const sha256 = createHash('sha256').update(archiveBody).digest('hex');

    fetchMock.mockResolvedValueOnce(
      new Response(archiveBody, {
        status: 200,
        headers: { 'content-length': String(archiveBody.length) },
      })
    );

    await writeFireForgeConfig(projectRoot, {
      firefox: { version: '152.0b6', product: 'firefox-devedition', sha256 },
    });
    await downloadCommand(projectRoot, {});

    expect(fetchMock).toHaveBeenCalledWith(
      'https://archive.mozilla.org/pub/devedition/releases/152.0b6/source/firefox-152.0b6.source.tar.xz',
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest asymmetric matcher
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    await expect(readProjectText(projectRoot, 'engine/browser/config/version.txt')).resolves.toBe(
      '152.0b6\n'
    );
    await expect(
      readFile(
        join(projectRoot, '.fireforge/cache', 'firefox-firefox-devedition-152.0b6.source.tar.xz')
      )
    ).resolves.toBeTruthy();
  });

  it('keeps the previous engine when forced replacement fails checksum validation', async () => {
    const oldArchivePath = await makeTarXzArchive(projectRoot, 'old.tar.xz', 'firefox-140.9.0esr', {
      'browser/config/version.txt': '140.9.0esr\n',
    });
    const oldBody = await readFile(oldArchivePath);
    installUrlFetch({
      [getDownloadUrl('140.9.0esr', 'firefox-esr')]: oldBody,
    });

    await writeFireForgeConfig(projectRoot);
    await downloadCommand(projectRoot, {});

    const newArchivePath = await makeTarXzArchive(
      projectRoot,
      'bad-devedition.tar.xz',
      'firefox-152.0b6',
      {
        'browser/config/version.txt': '152.0b6\n',
      }
    );
    const newBody = await readFile(newArchivePath);
    installUrlFetch({
      'https://archive.mozilla.org/pub/devedition/releases/152.0b6/source/firefox-152.0b6.source.tar.xz':
        newBody,
    });

    await writeFireForgeConfig(projectRoot, {
      firefox: {
        version: '152.0b6',
        product: 'firefox-devedition',
        sha256: '0'.repeat(64),
      },
    });
    await expect(downloadCommand(projectRoot, { force: true })).rejects.toThrow(/SHA-256 mismatch/);

    await expect(readProjectText(projectRoot, 'engine/browser/config/version.txt')).resolves.toBe(
      '140.9.0esr\n'
    );
  });

  it('replaces stale partial downloads atomically', async () => {
    const archivePath = await makeTarXzArchive(projectRoot, 'esr.tar.xz', 'firefox-140.9.0esr', {
      'browser/config/version.txt': '140.9.0esr\n',
    });
    const archiveBody = await readFile(archivePath);

    installUrlFetch({
      [getDownloadUrl('140.9.0esr', 'firefox-esr')]: archiveBody,
    });

    await writeFireForgeConfig(projectRoot);

    const cacheFile = join(
      projectRoot,
      '.fireforge/cache',
      `${getTarballFilename('140.9.0esr', 'firefox-esr')}.part`
    );
    await writeFiles(projectRoot, {
      [join('.fireforge/cache', `${getTarballFilename('140.9.0esr', 'firefox-esr')}.part`)]:
        'partial',
    });

    await downloadCommand(projectRoot, {});

    await expect(readFile(cacheFile)).rejects.toThrow();
    await expect(
      readProjectText(
        projectRoot,
        '.fireforge/cache/firefox-firefox-esr-140.9.0esr.source.tar.xz.json'
      )
    ).resolves.toContain('"archiveVersion": "140.9.0esr"');
    expect(spinnerMessageCalls.some((message) => /git add -A/i.test(message))).toBe(true);
  });

  it('invalidates corrupted cached archives after extraction failure and recovers on retry', async () => {
    await writeFireForgeConfig(projectRoot);

    const tarballName = getTarballFilename('140.9.0esr', 'firefox-esr');
    await writeFiles(projectRoot, {
      [join('.fireforge/cache', tarballName)]: 'not a real tarball',
      [join('.fireforge/cache', `${tarballName}.json`)]: JSON.stringify(
        {
          requestedVersion: '140.9.0esr',
          product: 'firefox-esr',
          archiveVersion: '140.9.0esr',
          url: getDownloadUrl('140.9.0esr', 'firefox-esr'),
          contentLength: 'not a real tarball'.length,
          downloadedAt: new Date().toISOString(),
        },
        null,
        2
      ),
    });

    await expect(downloadCommand(projectRoot, {})).rejects.toThrow();
    await expect(readFile(join(projectRoot, '.fireforge/cache', tarballName))).rejects.toThrow();

    const archivePath = await makeTarXzArchive(projectRoot, 'retry.tar.xz', 'firefox-140.9.0esr', {
      'browser/config/version.txt': '140.9.0esr\n',
    });
    const archiveBody = await readFile(archivePath);
    installUrlFetch({
      [getDownloadUrl('140.9.0esr', 'firefox-esr')]: archiveBody,
    });

    await downloadCommand(projectRoot, {});

    const versionFile = await readProjectText(projectRoot, 'engine/browser/config/version.txt');
    expect(versionFile).toBe('140.9.0esr\n');
    expect(archiveFetchCount()).toBe(1);
  });

  it('verifies downloads against the published SHA256SUMS by default', async () => {
    const archivePath = await makeTarXzArchive(projectRoot, 'esr.tar.xz', 'firefox-140.9.0esr', {
      'browser/config/version.txt': '140.9.0esr\n',
    });
    const archiveBody = await readFile(archivePath);
    const digest = createHash('sha256').update(archiveBody).digest('hex');

    installUrlFetch(
      { [getDownloadUrl('140.9.0esr', 'firefox-esr')]: archiveBody },
      `${digest}  source/firefox-140.9.0esr.source.tar.xz\n`
    );

    await writeFireForgeConfig(projectRoot);
    await downloadCommand(projectRoot, {});

    await expect(readProjectText(projectRoot, 'engine/browser/config/version.txt')).resolves.toBe(
      '140.9.0esr\n'
    );
  });

  it('fails closed when the download does not match the published SHA256SUMS', async () => {
    // The whole model is "trusted baseline + patches" — a CDN response that
    // disagrees with Mozilla's published digest must never become the git
    // baseline, and the artifact must not stay in the cache.
    const archivePath = await makeTarXzArchive(projectRoot, 'esr.tar.xz', 'firefox-140.9.0esr', {
      'browser/config/version.txt': '140.9.0esr\n',
    });
    const archiveBody = await readFile(archivePath);

    installUrlFetch(
      { [getDownloadUrl('140.9.0esr', 'firefox-esr')]: archiveBody },
      `${'0'.repeat(64)}  source/firefox-140.9.0esr.source.tar.xz\n`
    );

    await writeFireForgeConfig(projectRoot);
    await expect(downloadCommand(projectRoot, {})).rejects.toThrow(/SHA-256 mismatch/);

    const tarballName = getTarballFilename('140.9.0esr', 'firefox-esr');
    await expect(readFile(join(projectRoot, '.fireforge/cache', tarballName))).rejects.toThrow();
  });
});
