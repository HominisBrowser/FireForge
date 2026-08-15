// SPDX-License-Identifier: EUPL-1.2
/**
 * Unit coverage for the bounded stdio drain (FORGE I1): the waiter must
 * release the exit as soon as the stream is safe (drained, destroyed, or
 * errored) and never later than the timeout — a hang here would turn every
 * failed `status --json | slow-consumer` into a wedged process.
 */
import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import type { DrainableStream } from '../stdio-drain.js';
import { waitForStdioDrain } from '../stdio-drain.js';

class FakeStream extends EventEmitter implements DrainableStream {
  destroyed = false;
  writableFinished = false;
  writableLength = 0;
}

describe('waitForStdioDrain', () => {
  it('resolves immediately when nothing is queued', async () => {
    const stream = new FakeStream();
    await expect(waitForStdioDrain(5_000, [stream])).resolves.toBeUndefined();
    expect(stream.listenerCount('drain')).toBe(0);
  });

  it('resolves immediately on an already-destroyed stream, even with queued bytes', async () => {
    const stream = new FakeStream();
    stream.destroyed = true;
    stream.writableLength = 70_000;
    await expect(waitForStdioDrain(5_000, [stream])).resolves.toBeUndefined();
  });

  it('waits for drain, rechecking the queue on each drain event', async () => {
    const stream = new FakeStream();
    stream.writableLength = 70_000;
    const wait = waitForStdioDrain(5_000, [stream]);

    // A drain that leaves bytes queued must not release the exit.
    stream.writableLength = 100;
    stream.emit('drain');
    let settled = false;
    void wait.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    stream.writableLength = 0;
    stream.emit('drain');
    await expect(wait).resolves.toBeUndefined();
    expect(stream.listenerCount('drain')).toBe(0);
    expect(stream.listenerCount('error')).toBe(0);
    expect(stream.listenerCount('close')).toBe(0);
  });

  it("resolves on 'close' mid-wait (an EPIPE'd pipe can never drain)", async () => {
    const stream = new FakeStream();
    stream.writableLength = 70_000;
    const wait = waitForStdioDrain(5_000, [stream]);
    stream.emit('close');
    await expect(wait).resolves.toBeUndefined();
  });

  it("resolves on 'error' mid-wait without rejecting", async () => {
    const stream = new FakeStream();
    stream.writableLength = 70_000;
    const wait = waitForStdioDrain(5_000, [stream]);
    // The waiter's own listener consumes the event; no unhandled 'error'.
    stream.emit('error');
    await expect(wait).resolves.toBeUndefined();
  });

  it('resolves at the timeout with listeners removed when the stream never drains', async () => {
    const stream = new FakeStream();
    stream.writableLength = 70_000;
    await expect(waitForStdioDrain(20, [stream])).resolves.toBeUndefined();
    expect(stream.listenerCount('drain')).toBe(0);
    expect(stream.listenerCount('error')).toBe(0);
    expect(stream.listenerCount('close')).toBe(0);
  });

  it('waits on every stream, not just the first', async () => {
    const a = new FakeStream();
    const b = new FakeStream();
    b.writableLength = 500;
    const wait = waitForStdioDrain(5_000, [a, b]);
    let settled = false;
    void wait.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    b.writableLength = 0;
    b.emit('drain');
    await expect(wait).resolves.toBeUndefined();
  });
});
