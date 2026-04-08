// SPDX-License-Identifier: EUPL-1.2
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getDownloadUrl, getTarballFilename } from '../../core/firefox.js';
import {
  createTempProject,
  makeTarXzArchive,
  readText,
  removeTempProject,
  writeFiles,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import { step } from '../../utils/logger.js';
import { downloadCommand } from '../download.js';

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  step: vi.fn(),
  spinner: vi.fn(() => ({
    stop: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  })),
}));

describe('downloadCommand integration', () => {
  let projectRoot: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    projectRoot = await createTempProject();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await removeTempProject(projectRoot);
  });

  it('keeps stable and ESR cache entries separate', async () => {
    const stableArchive = await makeTarXzArchive(projectRoot, 'stable.tar.xz', 'firefox-140.0', {
      'browser/config/version.txt': '140.0\n',
    });
    const esrArchive = await makeTarXzArchive(projectRoot, 'esr.tar.xz', 'firefox-140.0esr', {
      'browser/config/version.txt': '140.0esr\n',
    });

    const stableBody = await readFile(stableArchive);
    const esrBody = await readFile(esrArchive);

    fetchMock
      .mockResolvedValueOnce(
        new Response(stableBody, {
          status: 200,
          headers: { 'content-length': String(stableBody.length) },
        })
      )
      .mockResolvedValueOnce(
        new Response(esrBody, {
          status: 200,
          headers: { 'content-length': String(esrBody.length) },
        })
      );

    await writeFireForgeConfig(projectRoot, {
      firefox: { version: '140.0', product: 'firefox' },
    });
    await downloadCommand(projectRoot, {});

    await writeFireForgeConfig(projectRoot, {
      firefox: { version: '140.0esr', product: 'firefox-esr' },
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
      getTarballFilename('140.0esr', 'firefox-esr')
    );

    await expect(readFile(stableCache)).resolves.toBeTruthy();
    await expect(readFile(esrCache)).resolves.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      getDownloadUrl('140.0', 'firefox'),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest asymmetric matcher
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      getDownloadUrl('140.0esr', 'firefox-esr'),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest asymmetric matcher
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('replaces stale partial downloads atomically', async () => {
    const archivePath = await makeTarXzArchive(projectRoot, 'esr.tar.xz', 'firefox-140.0esr', {
      'browser/config/version.txt': '140.0esr\n',
    });
    const archiveBody = await readFile(archivePath);

    fetchMock.mockResolvedValue(
      new Response(archiveBody, {
        status: 200,
        headers: { 'content-length': String(archiveBody.length) },
      })
    );

    await writeFireForgeConfig(projectRoot);

    const cacheFile = join(
      projectRoot,
      '.fireforge/cache',
      `${getTarballFilename('140.0esr', 'firefox-esr')}.part`
    );
    await writeFiles(projectRoot, {
      [join('.fireforge/cache', `${getTarballFilename('140.0esr', 'firefox-esr')}.part`)]:
        'partial',
    });

    await downloadCommand(projectRoot, {});

    await expect(readFile(cacheFile)).rejects.toThrow();
    await expect(
      readText(projectRoot, '.fireforge/cache/firefox-firefox-esr-140.0esr.source.tar.xz.json')
    ).resolves.toContain('"archiveVersion": "140.0esr"');
    expect(vi.mocked(step).mock.calls.some(([message]) => /git add -A/i.test(message))).toBe(true);
  });

  it('invalidates corrupted cached archives after extraction failure and recovers on retry', async () => {
    await writeFireForgeConfig(projectRoot);

    const tarballName = getTarballFilename('140.0esr', 'firefox-esr');
    await writeFiles(projectRoot, {
      [join('.fireforge/cache', tarballName)]: 'not a real tarball',
      [join('.fireforge/cache', `${tarballName}.json`)]: JSON.stringify(
        {
          requestedVersion: '140.0esr',
          product: 'firefox-esr',
          archiveVersion: '140.0esr',
          url: getDownloadUrl('140.0esr', 'firefox-esr'),
          contentLength: 'not a real tarball'.length,
          downloadedAt: new Date().toISOString(),
        },
        null,
        2
      ),
    });

    await expect(downloadCommand(projectRoot, {})).rejects.toThrow();
    await expect(readFile(join(projectRoot, '.fireforge/cache', tarballName))).rejects.toThrow();

    const archivePath = await makeTarXzArchive(projectRoot, 'retry.tar.xz', 'firefox-140.0esr', {
      'browser/config/version.txt': '140.0esr\n',
    });
    const archiveBody = await readFile(archivePath);
    fetchMock.mockResolvedValue(
      new Response(archiveBody, {
        status: 200,
        headers: { 'content-length': String(archiveBody.length) },
      })
    );

    await downloadCommand(projectRoot, {});

    const versionFile = await readText(projectRoot, 'engine/browser/config/version.txt');
    expect(versionFile).toBe('140.0esr\n');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
