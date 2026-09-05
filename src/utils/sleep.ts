// SPDX-License-Identifier: EUPL-1.2

/**
 * The single awaitable delay used across FireForge.
 *
 * Five modules had grown a private copy of this (`sleep`, `delay`,
 * `sweepDelay`) and four more sites inlined
 * `new Promise((resolve) => setTimeout(resolve, ms))`. The copies disagreed on
 * the one property that actually matters — whether the pending timer holds the
 * event loop open — and the disagreement was invisible at each call site. Both
 * behaviours now live here, and callers state which one they need.
 *
 * The default is a ref'd timer, because the dangerous mistake is the other
 * one: an unref'd delay awaited between a SIGTERM and its escalation lets Node
 * exit mid-grace and skip the escalation entirely.
 *
 * Deliberately built on the global `setTimeout` rather than
 * `node:timers/promises`: the suites that drive retry and grace-period logic
 * use vitest fake timers, which patch the global but not the promisified
 * module, so the tidier import would make every timing path untestable.
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
