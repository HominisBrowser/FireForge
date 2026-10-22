// SPDX-License-Identifier: EUPL-1.2

/**
 * The single awaitable delay used across FireForge.
 *
 * Callers use this rather than a private `sleep`/`delay` or an inline
 * `new Promise((resolve) => setTimeout(resolve, ms))`, because such copies
 * disagree on the one property that actually matters (whether the pending
 * timer holds the event loop open) and the disagreement is invisible at each
 * call site. Both behaviours live here, and callers state which one they need.
 *
 * The default is a ref'd timer, because the dangerous mistake is the other
 * one: an unref'd delay awaited between a SIGTERM and its escalation lets Node
 * exit mid-grace and skip the escalation entirely.
 *
 * Built on the global `setTimeout` rather than `node:timers/promises`: the
 * suites that drive retry and grace-period logic use vitest fake timers,
 * which patch the global but not the promisified module, so the tidier
 * import would make every timing path untestable.
 * @param ms - Milliseconds to wait.
 * @param options - Pass `unref: true` when a pending delay must not keep the
 *   process alive (background probes, best-effort retries during shutdown).
 * @returns A promise that resolves once the delay has elapsed.
 */
export function sleep(ms: number, options?: { unref?: boolean }): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (options?.unref === true) timer.unref();
  });
}
