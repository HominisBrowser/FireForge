// SPDX-License-Identifier: EUPL-1.2
import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { type DrainableStream, drainStdio } from './stdio.js';

class FakeStream extends EventEmitter implements DrainableStream {
  destroyed = false;
  writableFinished = false;
  constructor(public writableLength: number) {
    super();
  }
}

describe('drainStdio', () => {
  it('resolves at once when nothing is queued', async () => {
    const stream = new FakeStream(0);
    await drainStdio(10_000, [stream]);
    expect(stream.listenerCount('drain')).toBe(0);
  });

  it('waits for the queue to empty and removes its listeners', async () => {
    const stream = new FakeStream(100_000);
    let drained = false;
    const waiting = drainStdio(10_000, [stream]).then(() => (drained = true));
    stream.emit('drain');
    await Promise.resolve();
    expect(drained).toBe(false);
    stream.writableLength = 0;
    stream.emit('drain');
    await waiting;
    expect(
      stream.listenerCount('drain') + stream.listenerCount('error') + stream.listenerCount('close')
    ).toBe(0);
  });

  it('does not wait for a pipe that closed or failed', async () => {
    const closed = new FakeStream(5);
    const failed = new FakeStream(5);
    const waiting = drainStdio(10_000, [closed, failed]);
    closed.emit('close');
    failed.emit('error');
    await waiting;
  });

  it('gives up at the bound so a stalled reader cannot wedge the exit', async () => {
    const startedAt = Date.now();
    await drainStdio(30, [new FakeStream(5)]);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});
