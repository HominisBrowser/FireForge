// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { ExitCode } from '../codes.js';
import {
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
    expect(error.url).toBe('https://archive.mozilla.org/test');
    expect(error.userMessage).toContain('Download Error: connection timed out');
    expect(error.userMessage).toContain('URL: https://archive.mozilla.org/test');
  });

  it('formats DownloadError without URL', () => {
    const error = new DownloadError('network error');

    expect(error.userMessage).not.toContain('URL:');
  });

  it('formats ExtractionError with archive path', () => {
    const error = new ExtractionError('/tmp/firefox-140.0.tar.xz');

    expect(error.code).toBe(ExitCode.DOWNLOAD_ERROR);
    expect(error.archivePath).toBe('/tmp/firefox-140.0.tar.xz');
    expect(error.userMessage).toContain('Archive: /tmp/firefox-140.0.tar.xz');
    expect(error.userMessage).toContain('disk space');
  });

  it('formats VersionNotFoundError', () => {
    const error = new VersionNotFoundError('999.0');

    expect(error.code).toBe(ExitCode.DOWNLOAD_ERROR);
    expect(error.version).toBe('999.0');
    expect(error.userMessage).toContain('"999.0"');
    expect(error.userMessage).toContain('archive.mozilla.org');
  });

  it('formats EngineExistsError', () => {
    const error = new EngineExistsError('/project/engine');

    expect(error.code).toBe(ExitCode.DOWNLOAD_ERROR);
    expect(error.enginePath).toBe('/project/engine');
    expect(error.userMessage).toContain('Path: /project/engine');
    expect(error.userMessage).toContain('--force');
  });

  it('formats PartialEngineExistsError', () => {
    const error = new PartialEngineExistsError('/project/engine');

    expect(error.code).toBe(ExitCode.DOWNLOAD_ERROR);
    expect(error.enginePath).toBe('/project/engine');
    expect(error.userMessage).toContain('not fully initialized');
    expect(error.userMessage).toContain('--force');
  });
});
