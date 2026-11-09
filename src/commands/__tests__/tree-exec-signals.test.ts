// SPDX-License-Identifier: EUPL-1.2
import { spawn } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { forwardTerminationSignals } from '../tree.js';

describe('forwardTerminationSignals', () => {
  it('terminates a real child when the parent receives SIGTERM, and stops after removal', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    const exited = new Promise<NodeJS.Signals | null>((resolve) => {
      child.on('exit', (_code, signal) => {
        resolve(signal);
      });
    });
    const before = process.listenerCount('SIGTERM');
    const stop = forwardTerminationSignals(child);
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);

    // Delivered to the listeners only: nothing terminates the test process.
    process.emit('SIGTERM');
    await expect(exited).resolves.toBe('SIGTERM');

    stop();
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });
});
