// SPDX-License-Identifier: EUPL-1.2
/**
 * Download with retry, stall detection, and progress tracking.
 */

import { createWriteStream } from 'node:fs';
import { basename } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import { DownloadError, VersionNotFoundError } from '../errors/download.js';

/**
 * Progress callback for download operations.
 */
export type ProgressCallback = (downloaded: number, total: number) => void;

/** Default request timeout in milliseconds (60 seconds). */
const REQUEST_TIMEOUT_MS = 60_000;

/** Maximum number of download attempts. */
const MAX_ATTEMPTS = 3;

/** HTTP status codes that are retryable. */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

/** Base delay between retries in milliseconds. */
const RETRY_BASE_DELAY_MS = 1_000;

/** Stall detection timeout — abort if no data received for this duration (30 seconds). */
const DOWNLOAD_STALL_TIMEOUT_MS = 30_000;

/**
 * Fetches a URL with timeout and bounded retry for transient failures.
 *
 * Non-retryable errors (e.g. 404) are thrown immediately.
 */
export async function fetchWithRetry(url: string): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, { signal: controller.signal });

      if (response.status === 404) {
        throw new VersionNotFoundError(basename(url).replace('.source.tar.xz', ''));
      }

      if (RETRYABLE_STATUS_CODES.has(response.status)) {
        lastError = new DownloadError(`HTTP ${response.status}: ${response.statusText}`, url);
      } else if (!response.ok) {
        throw new DownloadError(`HTTP ${response.status}: ${response.statusText}`, url);
      } else {
        return response;
      }
    } catch (error: unknown) {
      if (error instanceof VersionNotFoundError || error instanceof DownloadError) {
        throw error;
      }
      // Network / timeout errors are retryable
      lastError = error;
    } finally {
      clearTimeout(timer);
    }

    if (attempt < MAX_ATTEMPTS - 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, RETRY_BASE_DELAY_MS * (attempt + 1) ** 2);
      });
    }
  }

  if (lastError instanceof DownloadError) {
    throw lastError;
  }
  throw new DownloadError(
    lastError instanceof Error ? lastError.message : 'Download failed after retries',
    url,
    lastError instanceof Error ? lastError : undefined
  );
}

/**
 * Creates a Transform stream that aborts if no data is received within the stall timeout.
 * The timer resets on each chunk. If it fires, the stream is destroyed with a DownloadError.
 * @param url - URL being downloaded (for error messages)
 * @param timeoutMs - Stall timeout in milliseconds
 */
function createStallDetector(url: string, timeoutMs = DOWNLOAD_STALL_TIMEOUT_MS): Transform {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const detector = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        detector.destroy(
          new DownloadError(
            `Download stalled: no data received for ${Math.round(timeoutMs / 1000)} seconds`,
            url
          )
        );
      }, timeoutMs);
      callback(null, chunk);
    },
    flush(callback) {
      if (timer !== undefined) clearTimeout(timer);
      callback();
    },
  });

  // Start the initial timer (covers the case where the first chunk never arrives).
  timer = setTimeout(() => {
    detector.destroy(
      new DownloadError(
        `Download stalled: no data received for ${Math.round(timeoutMs / 1000)} seconds`,
        url
      )
    );
  }, timeoutMs);

  return detector;
}

/**
 * Downloads a file from a URL with progress tracking, timeout, and retry.
 * @param url - URL to download
 * @param destPath - Destination file path
 * @param onProgress - Optional progress callback
 * @returns The content-length if available, otherwise undefined
 */
export async function downloadFile(
  url: string,
  destPath: string,
  onProgress?: ProgressCallback
): Promise<number | undefined> {
  const response = await fetchWithRetry(url);

  if (!response.body) {
    throw new DownloadError('No response body received', url);
  }

  const totalSize = parseInt(response.headers.get('content-length') ?? '0', 10);
  let downloadedSize = 0;

  const fileStream = createWriteStream(destPath);
  const nodeStream = Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>);
  const stallDetector = createStallDetector(url);

  if (onProgress && totalSize > 0) {
    const progress = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        downloadedSize += chunk.length;
        onProgress(downloadedSize, totalSize);
        callback(null, chunk);
      },
    });
    await pipeline(nodeStream, stallDetector, progress, fileStream);
  } else {
    await pipeline(nodeStream, stallDetector, fileStream);
  }

  return totalSize > 0 ? totalSize : undefined;
}
