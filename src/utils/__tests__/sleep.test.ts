// SPDX-License-Identifier: EUPL-1.2
import { afterEach, describe, expect, it, vi } from 'vitest';

import { sleep } from '../sleep.js';

/** Node's `Timeout.prototype`, reached through a throwaway timer. */
function timeoutPrototype(): object {
  const probe = setTimeout(() => undefined, 0);
  clearTimeout(probe);
  return Object.getPrototypeOf(probe) as object;
}

describe('sleep', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The default holds the event loop: an unref'd wait between a SIGTERM and
  // its escalation lets Node exit mid-grace, and a detached child that has
  // already gone leaves nothing else to keep the process alive.
  it("keeps the timer ref'd by default", async () => {
    const unref = vi.spyOn(timeoutPrototype() as { unref: () => void }, 'unref');
    await sleep(1);
    expect(unref).not.toHaveBeenCalled();
  });

  it('unrefs the timer only when asked', async () => {
    const unref = vi.spyOn(timeoutPrototype() as { unref: () => void }, 'unref');
    await sleep(1, { unref: true });
    expect(unref).toHaveBeenCalledTimes(1);
  });
});
