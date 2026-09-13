// SPDX-License-Identifier: EUPL-1.2
/**
 * Detects the death of FireForge's own parent while a harness runs.
 *
 * A supervisor that SIGKILLs the process above `fireforge test` (the
 * 2026-09-13 incident: a gate killed its `npm` step at the 15-minute bound)
 * signals nothing below it. FireForge is not told; its stdout pipe merely
 * breaks, and the broken-pipe handler swallows EPIPE on purpose so `| head`
 * works. The mach tree it spawned as a separate process group keeps running
 * under nobody's supervision, and the httpd in that tree spun at 100% CPU
 * for hours.
 *
 * SIGKILL cannot be caught, but reparenting can be observed: once the parent
 * is gone, `process.ppid` changes (to launchd/init, or to a subreaper). This
 * watchdog polls for that while a dispatch is in flight and fires once. It
 * does not decide what to do about it; the test command tears down the
 * harness tree and ends the run.
 *
 * Off on Windows: `process.ppid` is not refreshed there after the parent
 * exits, and there is no process group to signal in response anyway.
 */

/** How often the parent is probed. Cheap (one syscall), so a short interval is fine. */
const DEFAULT_INTERVAL_MS = 2000;

/** Options for {@link startParentExitWatchdog}. */
export interface ParentExitWatchdogOptions {
  /** Probe interval, default {@link DEFAULT_INTERVAL_MS}. */
  intervalMs?: number;
  /** Called exactly once, the first time the parent is seen to be gone. */
  onParentExit: (info: { originalPpid: number; currentPpid: number }) => void;
  /**
   * Reads the current parent pid; default `process.ppid`. Injectable because
   * `process.ppid` cannot be stubbed on every Node line: redefining the
   * property is honoured on Node 26 and silently ignored on Node 22, so a
   * test that stubs it passes on one and never observes a reparent on the
   * other.
   */
  readPpid?: () => number;
}

/** Handle for a running watchdog. */
export interface ParentExitWatchdog {
  /** Stops probing. Idempotent. A stopped watchdog never fires. */
  stop(): void;
}

let parentExitObserved = false;

/**
 * True once any watchdog in this process has seen the parent die. The
 * dispatch loop reads it to end the run instead of classifying the killed
 * harness as a crash and retrying it under a parent that no longer exists.
 */
export function parentExited(): boolean {
  return parentExitObserved;
}

/**
 * Forgets an observed parent exit.
 *
 * @internal Exported only so tests can reach it. It is not part of the
 * public surface.
 */
export function resetParentExitForTests(): void {
  parentExitObserved = false;
}

/**
 * Starts probing `process.ppid`. The timer is unref'd so the watchdog can
 * never be the thing keeping FireForge alive; while a child runs, the child
 * does that.
 */
export function startParentExitWatchdog(options: ParentExitWatchdogOptions): ParentExitWatchdog {
  if (process.platform === 'win32') {
    return { stop: () => undefined };
  }
  const readPpid = options.readPpid ?? ((): number => process.ppid);
  const originalPpid = readPpid();
  let timer: NodeJS.Timeout | undefined = setInterval(() => {
    const currentPpid = readPpid();
    if (currentPpid === originalPpid) return;
    stop();
    parentExitObserved = true;
    options.onParentExit({ originalPpid, currentPpid });
  }, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref();

  function stop(): void {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  }
  return { stop };
}
