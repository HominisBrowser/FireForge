// SPDX-License-Identifier: EUPL-1.2
/**
 * Tests for the signal-deferred critical-section registry. The module is a
 * pure runtime registry (no signal handlers of its own), so the contract is
 * exercised directly: bodies run to completion, results and throws pass
 * through, and waitForActiveCriticalSections blocks until every active
 * section resolves or the bounded timeout elapses.
 *
 * Timing is asserted through fake timers and callback ordering, never
 * through wall-clock bounds: "resolved without advancing the clock" is the
 * immediate-return contract, and "still pending at timeout-1, resolved at
 * timeout" is the bounded-wait contract.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runInSignalCriticalSection, waitForActiveCriticalSections } from '../signal-critical.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Attaches a settled flag so a pending promise can be observed without awaiting it. */
function observe(promise: Promise<unknown>): { readonly settled: boolean } {
  const state = { settled: false };
  void promise.then(() => {
    state.settled = true;
  });
  return state;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('runInSignalCriticalSection', () => {
  it('returns the body result', async () => {
    await expect(runInSignalCriticalSection('test', () => Promise.resolve(42))).resolves.toBe(42);
  });

  it('re-throws the body error and still clears the registry', async () => {
    await expect(
      runInSignalCriticalSection('test', () => Promise.reject(new Error('body failed')))
    ).rejects.toThrow('body failed');

    // Registry must be empty again: with the clock frozen, the wait can only
    // resolve by taking the "nothing active" early return.
    vi.useFakeTimers();
    const wait = observe(waitForActiveCriticalSections(5_000));
    await Promise.resolve();
    expect(wait.settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('waitForActiveCriticalSections', () => {
  it('resolves immediately when no section is active', async () => {
    vi.useFakeTimers();
    const wait = observe(waitForActiveCriticalSections(5_000));
    await Promise.resolve();
    expect(wait.settled).toBe(true);
    // No timeout was armed: the early return never reaches the race.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for an active section to finish', async () => {
    const gate = deferred();
    let bodyFinished = false;

    const section = runInSignalCriticalSection('test-wait', async () => {
      await gate.promise;
      bodyFinished = true;
    });

    const wait = waitForActiveCriticalSections(10_000).then(() => {
      // The wait must not win the race against the still-running body.
      expect(bodyFinished).toBe(true);
    });

    gate.resolve();
    await section;
    await wait;
  });

  it('waits for every concurrently active section', async () => {
    const first = deferred();
    const second = deferred();
    const finished: string[] = [];

    const sections = [
      runInSignalCriticalSection('first', async () => {
        await first.promise;
        finished.push('first');
      }),
      runInSignalCriticalSection('second', async () => {
        await second.promise;
        finished.push('second');
      }),
    ];

    const wait = waitForActiveCriticalSections(10_000).then(() => {
      expect(finished.sort()).toEqual(['first', 'second']);
    });

    first.resolve();
    second.resolve();
    await Promise.all(sections);
    await wait;
  });

  it('gives up after the bounded timeout when a section never finishes', async () => {
    vi.useFakeTimers();
    const gate = deferred();
    const section = runInSignalCriticalSection('stuck', () => gate.promise);

    const wait = observe(waitForActiveCriticalSections(100));
    await vi.advanceTimersByTimeAsync(99);
    expect(wait.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(wait.settled).toBe(true);

    // Unstick and drain so the section does not leak into other tests.
    gate.resolve();
    await section;
    const drained = observe(waitForActiveCriticalSections(1_000));
    await Promise.resolve();
    expect(drained.settled).toBe(true);
  });

  it('treats a throwing section as completed, not as a rejection', async () => {
    const gate = deferred();
    const section = runInSignalCriticalSection('throwing', async () => {
      await gate.promise;
      throw new Error('section failed');
    });

    const wait = waitForActiveCriticalSections(10_000);
    gate.resolve();
    await expect(section).rejects.toThrow('section failed');
    await expect(wait).resolves.toBeUndefined();
  });
});
