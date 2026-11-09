// SPDX-License-Identifier: EUPL-1.2
/**
 * Hooks from the exec layer up to whoever needs to hear about a process tree.
 * The library needs no coordinator or lock knowledge: the executable and
 * `core/file-lock.ts` install these.
 */

let reporter: ((reason: string) => Promise<void>) | undefined;

/**
 * Installs the runtime reporter for teardown that could not be established
 * (the census failed, or an owned process survived SIGKILL).
 *
 * @param report - Receives the reason. May reject; see {@link reportProcessCleanupUncertainty}.
 */
export function setProcessCleanupReporter(report: (reason: string) => Promise<void>): void {
  reporter = report;
}

/**
 * Reports uncertain teardown. A diagnostic never replaces a command's result,
 * so this resolves whatever the reporter does and returns the reporter's
 * failure for the caller to log.
 *
 * @param reason - What could not be established
 * @returns The reporter's failure, when it failed
 */
export async function reportProcessCleanupUncertainty(reason: string): Promise<unknown> {
  try {
    await reporter?.(reason);
    return undefined;
  } catch (error: unknown) {
    return error;
  }
}

/** Told about the lifetime of every process group this process starts. */
export interface ChildGroupListener {
  /** The group has just been created. Called synchronously. Must not throw. */
  started: (pgid: number) => void;
  /** The group's teardown established it is gone. Called synchronously. Must not throw. */
  ended: (pgid: number) => void;
}

let childGroupListener: ChildGroupListener | undefined;

/**
 * Installs the listener told about every process group this process starts.
 *
 * @param listener - See {@link ChildGroupListener}
 */
export function setChildGroupListener(listener: ChildGroupListener): void {
  childGroupListener = listener;
}

/**
 * Announces a process group that has just been created.
 *
 * @param pgid - The new group id
 */
export function announceChildGroup(pgid: number): void {
  childGroupListener?.started(pgid);
}

/**
 * Announces that a process group's teardown established it is gone. A group
 * whose teardown stayed inconclusive is never announced, so anything relying on
 * the announcement errs toward treating the group as alive.
 *
 * @param pgid - The group id
 */
export function announceChildGroupEnd(pgid: number): void {
  childGroupListener?.ended(pgid);
}
