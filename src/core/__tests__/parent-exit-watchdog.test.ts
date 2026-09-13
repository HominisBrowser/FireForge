// SPDX-License-Identifier: EUPL-1.2
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  parentExited,
  resetParentExitForTests,
  startParentExitWatchdog,
} from '../parent-exit-watchdog.js';

const originalPlatform = process.platform;

function stubPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

// The parent pid is injected rather than stubbed on `process`: redefining
// `process.ppid` is honoured on Node 26 and silently ignored on Node 22, so a
// stub-based test passed locally and never saw a reparent in CI.
let ppid = 4000;
const readPpid = (): number => ppid;

describe('startParentExitWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stubPlatform('darwin');
    ppid = 4000;
    resetParentExitForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(() => {
    stubPlatform(originalPlatform);
  });

  it('reads process.ppid by default', () => {
    const onParentExit = vi.fn();
    const watchdog = startParentExitWatchdog({ intervalMs: 100, onParentExit });
    vi.advanceTimersByTime(300);
    // The real parent is alive for the whole test, so the default reader
    // sees no change.
    expect(onParentExit).not.toHaveBeenCalled();
    watchdog.stop();
  });

  it('stays quiet while the parent is alive', () => {
    const onParentExit = vi.fn();
    const watchdog = startParentExitWatchdog({ intervalMs: 100, onParentExit, readPpid });
    vi.advanceTimersByTime(1000);
    expect(onParentExit).not.toHaveBeenCalled();
    expect(parentExited()).toBe(false);
    watchdog.stop();
  });

  // The supervisor SIGKILLed the process above FireForge: nothing signals
  // FireForge, but the kernel reparents it, and that is the observable.
  it('fires once with both ppids when the parent is reparented, then stops', () => {
    const onParentExit = vi.fn();
    startParentExitWatchdog({ intervalMs: 100, onParentExit, readPpid });
    vi.advanceTimersByTime(250);
    ppid = 1;
    vi.advanceTimersByTime(100);
    expect(onParentExit).toHaveBeenCalledTimes(1);
    expect(onParentExit).toHaveBeenCalledWith({ originalPpid: 4000, currentPpid: 1 });
    expect(parentExited()).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(onParentExit).toHaveBeenCalledTimes(1);
  });

  it('never fires after stop(), even if the parent then dies', () => {
    const onParentExit = vi.fn();
    const watchdog = startParentExitWatchdog({ intervalMs: 100, onParentExit, readPpid });
    watchdog.stop();
    watchdog.stop(); // idempotent
    ppid = 1;
    vi.advanceTimersByTime(1000);
    expect(onParentExit).not.toHaveBeenCalled();
    expect(parentExited()).toBe(false);
  });

  // `process.ppid` is not refreshed on Windows after the parent exits, and
  // there is no process group to signal in response, so the watchdog is off.
  it('is a no-op on Windows', () => {
    stubPlatform('win32');
    const onParentExit = vi.fn();
    const watchdog = startParentExitWatchdog({ intervalMs: 100, onParentExit, readPpid });
    ppid = 1;
    vi.advanceTimersByTime(1000);
    expect(onParentExit).not.toHaveBeenCalled();
    watchdog.stop();
  });
});
