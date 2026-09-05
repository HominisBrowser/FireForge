// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { ExitCode } from '../codes.js';
import {
  ChecksumMismatchError,
  DownloadError,
  EngineExistsError,
  ExtractionError,
  PartialEngineExistsError,
  VersionNotFoundError,
} from '../download.js';

describe('download errors', () => {
  it('formats DownloadError with URL', () => {
    const error = new DownloadError('connection timed out', 'https://archive.mozilla.org/test');

    expect(error.code).toBe(ExitCode.DOWNLOAD_ERROR);
    expect(error.userMessage).toContain('Download Error: connection timed out');
    expect(error.userMessage).toContain('URL: https://archive.mozilla.org/test');
  });

  it('formats DownloadError without URL', () => {
    const error = new DownloadError('network error');

    expect(error.userMessage).not.toContain('URL:');
  });

  it('formats ChecksumMismatchError with product and resolved archive URL', () => {
    const error = new ChecksumMismatchError(
      'firefox-devedition',
      '0'.repeat(64),
      '1'.repeat(64),
      'https://archive.mozilla.org/pub/devedition/releases/152.0b6/source/firefox-152.0b6.source.tar.xz'
    );

    expect(error.code).toBe(ExitCode.DOWNLOAD_ERROR);
    expect(error.userMessage).toContain('Product: firefox-devedition');
    expect(error.userMessage).toContain(
      'URL: https://archive.mozilla.org/pub/devedition/releases/152.0b6/source/firefox-152.0b6.source.tar.xz'
    );
    expect(error.userMessage).toContain('Developer Edition archives should resolve under');
  });

  it('formats ExtractionError with archive path', () => {
    const error = new ExtractionError('/tmp/firefox-140.0.tar.xz');

    expect(error.code).toBe(ExitCode.DOWNLOAD_ERROR);
    expect(error.userMessage).toContain('Archive: /tmp/firefox-140.0.tar.xz');
    expect(error.userMessage).toContain('disk space');
  });

  it('formats VersionNotFoundError', () => {
    const error = new VersionNotFoundError('999.0');

    expect(error.code).toBe(ExitCode.DOWNLOAD_ERROR);
    expect(error.userMessage).toContain('"999.0"');
    expect(error.userMessage).toContain('archive.mozilla.org');
  });

  it('formats EngineExistsError', () => {
    const error = new EngineExistsError('/project/engine');

    expect(error.code).toBe(ExitCode.DOWNLOAD_ERROR);
    expect(error.userMessage).toContain('Path: /project/engine');
    expect(error.userMessage).toContain('--force');
  });

  it('formats PartialEngineExistsError', () => {
    const error = new PartialEngineExistsError('/project/engine');

    expect(error.code).toBe(ExitCode.DOWNLOAD_ERROR);
    expect(error.userMessage).toContain('not fully initialized');
    expect(error.userMessage).toContain('--force');
  });
});
