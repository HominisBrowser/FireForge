// SPDX-License-Identifier: EUPL-1.2
/**
 * Signal-deferred critical sections.
 *
 * Commands that perform a compound mutation (e.g. "apply a patch to the
 * engine, then persist progress to a session file on disk") need to finish
 * the pair atomically with respect to SIGINT / SIGTERM. The furnace rollback
 * mechanism is not the right tool here: rebase-style operations intentionally
 * leave the engine mutated and only need the on-disk bookkeeping write to
 * complete before the process exits.
 *
 * `runInSignalCriticalSection(fn)` wraps a short body in a registry slot.
 * While the body runs, the CLI entry point's SIGINT / SIGTERM handlers wait
 * for the slot to clear before calling `process.exit`, so a signal that
 * lands mid-body is held until the body's state write finishes.
 *
 * This module is a pure runtime registry — it installs no signal handlers
 * itself. The bin entry point is responsible for awaiting
 * `waitForActiveCriticalSections` before terminating.
 */

interface ActiveCriticalSection {
  /** Human-readable label for telemetry/debugging; never surfaced to users. */
  label: string;
  /** Resolved once the body has finished (success or throw). */
  promise: Promise<void>;
}

const activeSections = new Set<ActiveCriticalSection>();

/**
 * Runs `fn` inside a signal-deferred critical section. The CLI entry point's
 * signal handlers `await` every active section before exiting, so a SIGINT or
 * SIGTERM that arrives during `fn` will hold exit until `fn` returns (or
 * rejects).
 *
 * `fn` should be short — anything that takes longer than the bounded wait in
 * the bin handler (`SIGNAL_CRITICAL_SECTION_TIMEOUT_MS`) will time out and
 * the handler will exit anyway. The intent is "guard the apply + state
 * persist pair," not "postpone exit indefinitely."
 */
export async function runInSignalCriticalSection<T>(
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  let resolver: () => void = () => undefined;
  const section: ActiveCriticalSection = {
    label,
    promise: new Promise<void>((resolve) => {
      resolver = resolve;
    }),
  };
  activeSections.add(section);
  try {
    return await fn();
  } finally {
    activeSections.delete(section);
    resolver();
  }
}

/**
 * Waits for every active critical section to complete or for `timeoutMs` to
 * elapse, whichever comes first. Never rejects: a section that throws still
 * resolves from the registry's perspective because `runInSignalCriticalSection`
 * cleans up in `finally`.
 */
export async function waitForActiveCriticalSections(timeoutMs: number): Promise<void> {
  if (activeSections.size === 0) return;
  const snapshot = [...activeSections].map((s) => s.promise);
  await Promise.race([
    Promise.allSettled(snapshot).then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
