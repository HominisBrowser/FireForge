// SPDX-License-Identifier: EUPL-1.2
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchWithRetry } from '../firefox-download.js';

vi.mock('../../utils/sleep.js', () => ({ sleep: () => Promise.resolve() }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('checksum response-body deadline', () => {
  it('bounds and retries headers-success/body-never-finishes even if the body ignores abort', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetch = vi.fn((_url: string, init: RequestInit) => {
      signals.push(init.signal as AbortSignal);
      return Promise.resolve(new Response(new ReadableStream({ start: () => undefined })));
    });
    vi.stubGlobal('fetch', fetch);
    const result = fetchWithRetry('https://fixture.invalid/SHA256SUMS', (response) =>
      response.text()
    ).then(
      () => 'unexpected success',
      (error: unknown) => error
    );
    await vi.runAllTimersAsync();
    expect(await result).toBeInstanceOf(Error);
    expect(String(await result)).toContain('response body timed out');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it('retries a failing body consumption and retains the successful complete response', async () => {
    const consume = vi
      .fn()
      .mockRejectedValueOnce(new Error('body reset'))
      .mockResolvedValueOnce('verified sums');
    const fetch = vi.fn(() => Promise.resolve(new Response('sums')));
    vi.stubGlobal('fetch', fetch);
    expect(await fetchWithRetry('https://fixture.invalid/SHA256SUMS', consume)).toBe(
      'verified sums'
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
