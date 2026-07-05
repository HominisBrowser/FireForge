// SPDX-License-Identifier: EUPL-1.2
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../utils/process.js', () => ({
  exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
  // Streaming tar listings (archive-safety preflight): exit 0, no output.
  execStream: vi.fn().mockResolvedValue(0),
  executableExists: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../utils/fs.js', () => {
  // Shared instance: the cache probes moved to pathExistsStrict, and the
  // tests toggle existence via pathExists — keep both names in lockstep.
  const pathExists = vi.fn().mockResolvedValue(false);
  return {
    pathExists,
    pathExistsStrict: pathExists,
    ensureDir: vi.fn().mockResolvedValue(undefined),
    removeDir: vi.fn().mockResolvedValue(undefined),
    removeFile: vi.fn().mockResolvedValue(undefined),
    readJson: vi.fn().mockResolvedValue({}),
    readText: vi.fn().mockResolvedValue(''),
    writeJson: vi.fn().mockResolvedValue(undefined),
  };
});

const mockWithFileLock = vi.hoisted(() =>
  vi.fn((_lockPath: string, operation: () => Promise<unknown>) => operation())
);

vi.mock('../file-lock.js', () => ({
  createSiblingLockPath: (filePath: string, suffix = '.fireforge.lock') => `${filePath}${suffix}`,
  withFileLock: mockWithFileLock,
}));

const mockCreateWriteStream = vi.hoisted(() => vi.fn());
const mockCreateReadStream = vi.hoisted(() => vi.fn());

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    createWriteStream: mockCreateWriteStream,
    createReadStream: mockCreateReadStream,
  };
});

const mockRename = vi.hoisted(() => vi.fn<() => Promise<void>>().mockResolvedValue(undefined));
const mockStat = vi.hoisted(() => vi.fn());
const mockReaddir = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: mockRename,
    stat: mockStat,
    readdir: mockReaddir,
  };
});

const mockFetch = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  mockFetch.mockReset();
  mockWithFileLock.mockClear();
  mockCreateWriteStream.mockReset();
  mockCreateReadStream.mockReset();
  mockRename.mockReset().mockResolvedValue(undefined);
  mockStat.mockReset();
  mockReaddir.mockReset();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

import { Readable, Writable } from 'node:stream';

import {
  ChecksumMismatchError,
  DownloadError,
  ExtractionError,
  VersionNotFoundError,
} from '../../errors/download.js';
import {
  downloadFirefoxSource,
  formatBytes,
  getDownloadUrl,
  getFirefoxVersion,
  getTarballFilename,
  resolveArchive,
} from '../firefox.js';

// Helper: create a mock writable stream that swallows data
function makeMockWriteStream(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback): void {
      callback();
    },
  });
}

// Helper: stub filesystem for a successful download pipeline
function stubDownloadFs(): void {
  mockCreateWriteStream.mockReturnValue(makeMockWriteStream());
  mockCreateReadStream.mockReturnValue(Readable.from([Buffer.from('data')]));
  mockReaddir.mockResolvedValue([{ name: 'firefox-140.9.0', isDirectory: () => true }]);
}

// ---------------------------------------------------------------------------
// Unit tests for pure functions
// ---------------------------------------------------------------------------

describe('resolveArchive', () => {
  it('resolves a standard firefox version', () => {
    const result = resolveArchive('140.9.0', 'firefox');
    expect(result.url).toBe(
      'https://archive.mozilla.org/pub/firefox/releases/140.9.0/source/firefox-140.9.0.source.tar.xz'
    );
    expect(result.filename).toBe('firefox-firefox-140.9.0.source.tar.xz');
  });

  it('resolves an ESR version', () => {
    const result = resolveArchive('140.9.0esr', 'firefox-esr');
    expect(result.archiveVersion).toBe('140.9.0esr');
    expect(result.url).toBe(
      'https://archive.mozilla.org/pub/firefox/releases/140.9.0esr/source/firefox-140.9.0esr.source.tar.xz'
    );
    expect(result.filename).toBe('firefox-firefox-esr-140.9.0esr.source.tar.xz');
  });

  it('rejects path traversal in version', () => {
    expect(() => resolveArchive('../etc/passwd', 'firefox')).toThrow('disallowed characters');
  });

  it('derives archiveVersion from product alone, not version string', () => {
    // ESR product with ESR version: should produce ESR archive
    const esr = resolveArchive('140.9.0esr', 'firefox-esr');
    expect(esr.archiveVersion).toBe('140.9.0esr');

    // Stable product with stable version: no esr suffix
    const stable = resolveArchive('140.9.0', 'firefox');
    expect(stable.archiveVersion).toBe('140.9.0');

    // Beta product with beta version
    const beta = resolveArchive('147.0b1', 'firefox-beta');
    expect(beta.archiveVersion).toBe('147.0b1');
    expect(beta.url).toBe(
      'https://archive.mozilla.org/pub/firefox/releases/147.0b1/source/firefox-147.0b1.source.tar.xz'
    );
    expect(beta.filename).toBe('firefox-firefox-beta-147.0b1.source.tar.xz');
  });

  it('resolves Developer Edition to the beta source archive with product-specific cache metadata', () => {
    const result = resolveArchive('152.0b6', 'firefox-devedition');
    expect(result.archiveVersion).toBe('152.0b6');
    expect(result.url).toBe(
      'https://archive.mozilla.org/pub/devedition/releases/152.0b6/source/firefox-152.0b6.source.tar.xz'
    );
    expect(result.filename).toBe('firefox-firefox-devedition-152.0b6.source.tar.xz');
    expect(result.metadataFilename).toBe('firefox-firefox-devedition-152.0b6.source.tar.xz.json');
  });

  it('strips trailing esr from version when product is ESR and re-adds it consistently', () => {
    const result = resolveArchive('128.0.1esr', 'firefox-esr');
    expect(result.archiveVersion).toBe('128.0.1esr');
    expect(result.url).toContain('/128.0.1esr/source/');
  });
});

describe('getDownloadUrl', () => {
  it('returns a mozilla archive URL', () => {
    expect(getDownloadUrl('140.9.0')).toContain('archive.mozilla.org');
  });
});

describe('getTarballFilename', () => {
  it('returns a filename with product prefix', () => {
    expect(getTarballFilename('140.9.0esr', 'firefox-esr')).toContain('firefox-esr');
  });
});

describe('formatBytes', () => {
  it('formats megabytes', () => {
    expect(formatBytes(1_048_576)).toBe('1.0 MB');
  });

  it('formats gigabytes', () => {
    expect(formatBytes(1_073_741_824)).toBe('1.0 GB');
  });
});

// ---------------------------------------------------------------------------
// Integration-style tests for download behavior
// ---------------------------------------------------------------------------

describe('download retry and timeout behavior', () => {
  it('throws VersionNotFoundError on 404 without retrying', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 404, statusText: 'Not Found' }));

    const { downloadFirefoxSource } = await import('../firefox.js');

    await expect(
      downloadFirefoxSource('999.0', 'firefox', '/tmp/dest', '/tmp/cache')
    ).rejects.toThrow(VersionNotFoundError);

    // Should NOT have retried — only 1 fetch call
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries on 500 and eventually succeeds', async () => {
    const body = new ReadableStream({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode('data'));
        controller.close();
      },
    });

    mockFetch
      .mockResolvedValueOnce(
        new Response(null, { status: 500, statusText: 'Internal Server Error' })
      )
      .mockResolvedValueOnce(
        new Response(body, {
          status: 200,
          headers: { 'content-length': '4' },
        })
      )
      // Default integrity check fetches the release SHA256SUMS after the
      // archive lands; 404 exercises the warn-and-continue path.
      .mockResolvedValueOnce(new Response('not found', { status: 404 }));

    const fsMod = await import('../../utils/fs.js');
    vi.mocked(fsMod.pathExists).mockResolvedValue(false);

    stubDownloadFs();

    const { downloadFirefoxSource } = await import('../firefox.js');
    await downloadFirefoxSource('140.9.0', 'firefox', '/tmp/dest', '/tmp/cache');

    // 500 + 200 (archive) + 404 (SHA256SUMS) = 3 calls
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('throws DownloadError after exhausting retries on 500', async () => {
    mockFetch.mockResolvedValue(
      new Response(null, { status: 500, statusText: 'Internal Server Error' })
    );

    stubDownloadFs();

    const { downloadFirefoxSource } = await import('../firefox.js');

    await expect(
      downloadFirefoxSource('140.9.0', 'firefox', '/tmp/dest', '/tmp/cache')
    ).rejects.toThrow(DownloadError);

    // 3 attempts
    expect(mockFetch).toHaveBeenCalledTimes(3);
  }, 15_000);
});

describe('checksum-based cache validation', () => {
  it('invalidates cache when sha256 does not match', async () => {
    const fsMod = await import('../../utils/fs.js');

    // Simulate a cached archive that exists
    vi.mocked(fsMod.pathExists).mockResolvedValue(true);
    vi.mocked(fsMod.readJson).mockResolvedValue({
      requestedVersion: '140.9.0',
      product: 'firefox',
      archiveVersion: '140.9.0',
      url: 'https://archive.mozilla.org/pub/firefox/releases/140.9.0/source/firefox-140.9.0.source.tar.xz',
      contentLength: 100,
      sha256: 'expected-hash-that-will-not-match',
      downloadedAt: '2025-01-01T00:00:00.000Z',
    });

    // Mock stat to return matching content length
    mockStat.mockResolvedValue({ size: 100 });

    // Mock createReadStream for sha256File — returns data with a different hash
    mockCreateReadStream.mockReturnValue(Readable.from([Buffer.from('corrupted-data')]));

    // Now the fetch for re-download — provide fresh body each call
    mockFetch.mockImplementation(() => {
      const body = new ReadableStream({
        start(controller): void {
          controller.enqueue(new TextEncoder().encode('fresh'));
          controller.close();
        },
      });
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { 'content-length': '5' },
        })
      );
    });

    mockCreateWriteStream.mockReturnValue(makeMockWriteStream());
    mockReaddir.mockResolvedValue([{ name: 'firefox-140.9.0', isDirectory: () => true }]);

    const { downloadFirefoxSource } = await import('../firefox.js');
    await downloadFirefoxSource('140.9.0', 'firefox', '/tmp/dest', '/tmp/cache');

    // Should have called removeFile to invalidate cache, then fetched fresh
    expect(fsMod.removeFile).toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalled();
  });

  it('invalidates cache when metadata shape is malformed', async () => {
    const fsMod = await import('../../utils/fs.js');

    vi.mocked(fsMod.pathExists).mockResolvedValue(true);
    vi.mocked(fsMod.readJson).mockResolvedValue({
      requestedVersion: '140.9.0',
      product: 'firefox',
      archiveVersion: '140.9.0',
      url: 'https://archive.mozilla.org/pub/firefox/releases/140.9.0/source/firefox-140.9.0.source.tar.xz',
      contentLength: '100',
      downloadedAt: '2025-01-01T00:00:00.000Z',
    });

    mockFetch.mockImplementation(() => {
      const body = new ReadableStream({
        start(controller): void {
          controller.enqueue(new TextEncoder().encode('fresh'));
          controller.close();
        },
      });
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { 'content-length': '5' },
        })
      );
    });

    mockCreateWriteStream.mockReturnValue(makeMockWriteStream());
    mockCreateReadStream.mockReturnValue(Readable.from([Buffer.from('fresh')]));
    mockReaddir.mockResolvedValue([{ name: 'firefox-140.9.0', isDirectory: () => true }]);

    const { downloadFirefoxSource } = await import('../firefox.js');
    await downloadFirefoxSource('140.9.0', 'firefox', '/tmp/dest', '/tmp/cache');

    expect(fsMod.removeFile).toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalled();
  });

  it('invalidates cache when content length does not match metadata', async () => {
    const fsMod = await import('../../utils/fs.js');
    vi.mocked(fsMod.pathExists).mockResolvedValue(true);
    vi.mocked(fsMod.readJson).mockResolvedValue({
      requestedVersion: '140.9.0',
      product: 'firefox',
      archiveVersion: '140.9.0',
      url: 'https://archive.mozilla.org/pub/firefox/releases/140.9.0/source/firefox-140.9.0.source.tar.xz',
      downloadedAt: new Date().toISOString(),
      contentLength: 999,
    });
    mockStat.mockResolvedValue({ size: 100 });

    mockFetch.mockImplementation(() => {
      const body = new ReadableStream({
        start(controller): void {
          controller.enqueue(new TextEncoder().encode('fresh'));
          controller.close();
        },
      });
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { 'content-length': '5' },
        })
      );
    });

    mockCreateWriteStream.mockReturnValue(makeMockWriteStream());
    mockCreateReadStream.mockReturnValue(Readable.from([Buffer.from('fresh')]));
    mockReaddir.mockResolvedValue([{ name: 'firefox-140.9.0', isDirectory: () => true }]);

    await downloadFirefoxSource('140.9.0', 'firefox', '/tmp/dest', '/tmp/cache');

    expect(fsMod.removeFile).toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalled();
  });

  it('serializes cache validation and download behind a per-archive lock', async () => {
    const fsMod = await import('../../utils/fs.js');
    vi.mocked(fsMod.pathExists).mockResolvedValue(false);

    const body = new ReadableStream({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode('fresh'));
        controller.close();
      },
    });
    mockFetch.mockResolvedValueOnce(
      new Response(body, { status: 200, headers: { 'content-length': '5' } })
    );
    mockCreateWriteStream.mockReturnValue(makeMockWriteStream());
    mockCreateReadStream.mockReturnValue(Readable.from([Buffer.from('fresh')]));
    mockReaddir.mockResolvedValue([{ name: 'firefox-140.9.0', isDirectory: () => true }]);

    await downloadFirefoxSource('140.9.0', 'firefox', '/tmp/dest', '/tmp/cache');

    expect(mockWithFileLock).toHaveBeenCalledWith(
      '/tmp/cache/firefox-firefox-140.9.0.source.tar.xz.fireforge-cache.lock',
      expect.any(Function)
    );
  });

  it('accepts a freshly downloaded archive whose pinned sha256 matches', async () => {
    const fsMod = await import('../../utils/fs.js');
    vi.mocked(fsMod.pathExists).mockResolvedValue(false);

    const body = new ReadableStream({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode('fresh'));
        controller.close();
      },
    });
    mockFetch.mockResolvedValueOnce(
      new Response(body, { status: 200, headers: { 'content-length': '5' } })
    );
    mockCreateWriteStream.mockReturnValue(makeMockWriteStream());
    mockCreateReadStream.mockReturnValue(Readable.from([Buffer.from('fresh')]));
    mockReaddir.mockResolvedValue([{ name: 'firefox-140.9.0', isDirectory: () => true }]);

    await expect(
      downloadFirefoxSource(
        '140.9.0',
        'firefox',
        '/tmp/dest',
        '/tmp/cache',
        undefined,
        undefined,
        'd098ab5e44b9aabb755f76d806598f43573c662b35e4a2eab1e312ec9ad195e2'
      )
    ).resolves.toBeUndefined();
  });

  it('removes this invocation tarball when a pinned sha256 mismatches', async () => {
    const fsMod = await import('../../utils/fs.js');
    vi.mocked(fsMod.pathExists).mockResolvedValue(false);

    const body = new ReadableStream({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode('fresh'));
        controller.close();
      },
    });
    mockFetch.mockResolvedValueOnce(
      new Response(body, { status: 200, headers: { 'content-length': '5' } })
    );
    mockCreateWriteStream.mockReturnValue(makeMockWriteStream());
    mockCreateReadStream.mockReturnValue(Readable.from([Buffer.from('fresh')]));

    await expect(
      downloadFirefoxSource(
        '140.9.0',
        'firefox',
        '/tmp/dest',
        '/tmp/cache',
        undefined,
        undefined,
        '0'.repeat(64)
      )
    ).rejects.toThrow(/SHA-256 mismatch/);

    expect(fsMod.removeFile).toHaveBeenCalledWith(
      '/tmp/cache/firefox-firefox-140.9.0.source.tar.xz'
    );
    expect(fsMod.removeFile).toHaveBeenCalledWith(
      '/tmp/cache/firefox-firefox-140.9.0.source.tar.xz.json'
    );
  });

  it('reports product and resolved URL when a Developer Edition pinned sha256 mismatches', async () => {
    const fsMod = await import('../../utils/fs.js');
    vi.mocked(fsMod.pathExists).mockResolvedValue(false);

    const body = new ReadableStream({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode('fresh'));
        controller.close();
      },
    });
    mockFetch.mockResolvedValueOnce(
      new Response(body, { status: 200, headers: { 'content-length': '5' } })
    );
    mockCreateWriteStream.mockReturnValue(makeMockWriteStream());
    mockCreateReadStream.mockReturnValue(Readable.from([Buffer.from('fresh')]));

    let captured: unknown;
    try {
      await downloadFirefoxSource(
        '152.0b6',
        'firefox-devedition',
        '/tmp/dest',
        '/tmp/cache',
        undefined,
        undefined,
        '0'.repeat(64)
      );
    } catch (error: unknown) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(ChecksumMismatchError);
    const message = (captured as ChecksumMismatchError).userMessage;
    expect(message).toContain('Product: firefox-devedition');
    expect(message).toContain(
      'URL: https://archive.mozilla.org/pub/devedition/releases/152.0b6/source/firefox-152.0b6.source.tar.xz'
    );
    expect(message).toContain('Developer Edition archives should resolve under');
  });

  it('does not delete a peer cache entry when a download fails before promotion', async () => {
    const fsMod = await import('../../utils/fs.js');
    vi.mocked(fsMod.removeFile).mockClear();
    vi.mocked(fsMod.pathExists).mockResolvedValue(false);
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));

    await expect(
      downloadFirefoxSource('140.9.0', 'firefox', '/tmp/dest', '/tmp/cache')
    ).rejects.toThrow(/No response body received/);

    expect(fsMod.removeFile).not.toHaveBeenCalledWith(
      '/tmp/cache/firefox-firefox-140.9.0.source.tar.xz'
    );
    expect(fsMod.removeFile).not.toHaveBeenCalledWith(
      '/tmp/cache/firefox-firefox-140.9.0.source.tar.xz.json'
    );
    expect(vi.mocked(fsMod.removeFile).mock.calls[0]?.[0]).toMatch(
      /^\/tmp\/cache\/firefox-firefox-140\.9\.0\.source\.tar\.xz\.part-/
    );
  });
});

describe('download extraction behavior', () => {
  it('invalidates the cache and rethrows when tar extraction fails', async () => {
    stubDownloadFs();

    const body = new ReadableStream({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode('fresh'));
        controller.close();
      },
    });
    mockFetch.mockResolvedValueOnce(
      new Response(body, { status: 200, headers: { 'content-length': '5' } })
    );

    const fsMod = await import('../../utils/fs.js');
    vi.mocked(fsMod.pathExists).mockResolvedValue(false);

    const processMod = await import('../../utils/process.js');
    vi.mocked(processMod.exec).mockResolvedValueOnce({
      exitCode: 2,
      stdout: '',
      stderr: 'archive exploded',
    });

    await expect(
      downloadFirefoxSource('140.9.0', 'firefox', '/tmp/dest', '/tmp/cache')
    ).rejects.toThrow(ExtractionError);

    expect(fsMod.removeFile).toHaveBeenCalledWith(
      '/tmp/cache/firefox-firefox-140.9.0.source.tar.xz'
    );
    expect(fsMod.removeFile).toHaveBeenCalledWith(
      '/tmp/cache/firefox-firefox-140.9.0.source.tar.xz.json'
    );
  });

  it('moves the temporary extraction directory directly when no firefox-* subdirectory exists', async () => {
    stubDownloadFs();

    const body = new ReadableStream({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode('fresh'));
        controller.close();
      },
    });
    mockFetch.mockResolvedValueOnce(
      new Response(body, { status: 200, headers: { 'content-length': '5' } })
    );

    const fsMod = await import('../../utils/fs.js');
    vi.mocked(fsMod.pathExists).mockResolvedValue(false);
    mockReaddir.mockResolvedValue([{ name: 'tooling', isDirectory: () => true }]);

    await downloadFirefoxSource('140.9.0', 'firefox', '/tmp/dest', '/tmp/cache');

    // Temp dir now includes a UUID suffix for concurrency safety
    const renameArgs = mockRename.mock.calls.map((c) => c as unknown as [string, string]);
    const renameCall = renameArgs.find(
      ([src, dest]) => src.startsWith('/tmp/dest.tmp-') && dest === '/tmp/dest'
    );
    expect(renameCall).toBeDefined();
  });
});

describe('download response validation', () => {
  it('fails when the HTTP response has no body', async () => {
    const fsMod = await import('../../utils/fs.js');
    vi.mocked(fsMod.pathExists).mockResolvedValue(false);
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));

    await expect(
      downloadFirefoxSource('140.9.0', 'firefox', '/tmp/dest', '/tmp/cache')
    ).rejects.toThrow(/No response body received/);
  });
});

// ---------------------------------------------------------------------------
// Download stall detection
// ---------------------------------------------------------------------------

describe('download stall detection', () => {
  it('aborts when the response body stalls mid-transfer', async () => {
    vi.useFakeTimers();

    try {
      // A stream that sends one chunk then never closes (simulates stall)
      const body = new ReadableStream({
        start(controller): void {
          controller.enqueue(new TextEncoder().encode('partial'));
          // intentionally never close
        },
      });

      mockFetch.mockResolvedValueOnce(
        new Response(body, { status: 200, headers: { 'content-length': '10000' } })
      );

      stubDownloadFs();
      const fsMod = await import('../../utils/fs.js');
      vi.mocked(fsMod.pathExists).mockResolvedValue(false);

      const { downloadFirefoxSource } = await import('../firefox.js');

      // Start the download and immediately begin waiting for rejection
      let caught: Error | undefined;
      const downloadPromise = downloadFirefoxSource(
        '140.9.0',
        'firefox',
        '/tmp/dest',
        '/tmp/cache'
      ).catch((err: unknown) => {
        caught = err as Error;
      });

      // Advance past the 30-second stall timeout
      await vi.advanceTimersByTimeAsync(31_000);
      await downloadPromise;

      expect(caught).toBeDefined();
      expect(caught?.message).toMatch(/Download stalled/);
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);

  it('completes normally when data flows without stalling', async () => {
    const body = new ReadableStream({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode('all-data'));
        controller.close();
      },
    });

    mockFetch.mockResolvedValueOnce(
      new Response(body, { status: 200, headers: { 'content-length': '8' } })
    );

    stubDownloadFs();
    const fsMod = await import('../../utils/fs.js');
    vi.mocked(fsMod.pathExists).mockResolvedValue(false);
    mockReaddir.mockResolvedValue([{ name: 'firefox-140.9.0', isDirectory: () => true }]);

    const { downloadFirefoxSource } = await import('../firefox.js');
    await expect(
      downloadFirefoxSource('140.9.0', 'firefox', '/tmp/dest', '/tmp/cache')
    ).resolves.toBeUndefined();
  });

  it('clears the stall timer when the pipeline errors before flush', async () => {
    vi.useFakeTimers();
    try {
      const body = new ReadableStream({
        start(controller): void {
          controller.enqueue(new TextEncoder().encode('partial'));
          controller.close();
        },
      });
      mockFetch.mockResolvedValueOnce(
        new Response(body, { status: 200, headers: { 'content-length': '7' } })
      );

      const failingWriter = new Writable({
        write(_chunk, _encoding, callback): void {
          callback(new Error('disk full'));
        },
      });
      mockCreateWriteStream.mockReturnValue(failingWriter);

      const fsMod = await import('../../utils/fs.js');
      vi.mocked(fsMod.pathExists).mockResolvedValue(false);

      await expect(
        downloadFirefoxSource('140.9.0', 'firefox', '/tmp/dest', '/tmp/cache')
      ).rejects.toThrow('disk full');

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('downloadFirefoxSource phase callback (Finding #2)', () => {
  it('fires onPhase("download") before the transfer and onPhase("extract") before the tar run', async () => {
    // Regression guard: pre-0.16.0 there was no way for the download
    // command to distinguish the byte-transfer phase from the silent
    // tar-xz decompression phase, so the spinner read "Downloading...
    // 100%" throughout extraction. The phase callback gives the command
    // a single signal to switch spinners.
    const body = new ReadableStream({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode('all-data'));
        controller.close();
      },
    });
    mockFetch.mockResolvedValueOnce(
      new Response(body, { status: 200, headers: { 'content-length': '8' } })
    );

    stubDownloadFs();
    const fsMod = await import('../../utils/fs.js');
    vi.mocked(fsMod.pathExists).mockResolvedValue(false);
    mockReaddir.mockResolvedValue([{ name: 'firefox-140.9.0', isDirectory: () => true }]);

    const phases: Array<'download' | 'extract'> = [];
    await downloadFirefoxSource(
      '140.9.0',
      'firefox',
      '/tmp/dest',
      '/tmp/cache',
      undefined,
      (phase) => {
        phases.push(phase);
      }
    );

    // Download fires first (before the HTTP fetch), extract fires before
    // tar. The two calls are the authoritative phase-change signals.
    expect(phases).toEqual(['download', 'extract']);
  });
});

describe('getFirefoxVersion', () => {
  it('returns undefined when version.txt is missing', async () => {
    const fsMod = await import('../../utils/fs.js');
    vi.mocked(fsMod.pathExists).mockResolvedValue(false);

    await expect(getFirefoxVersion('/tmp/engine')).resolves.toBeUndefined();
  });

  it('trims the version file contents when version.txt exists', async () => {
    const fsMod = await import('../../utils/fs.js');
    vi.mocked(fsMod.pathExists).mockResolvedValue(true);
    vi.mocked(fsMod.readText).mockResolvedValue('140.9.0esr\n');

    await expect(getFirefoxVersion('/tmp/engine')).resolves.toBe('140.9.0esr');
  });
});
