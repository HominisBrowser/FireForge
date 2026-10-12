// SPDX-License-Identifier: EUPL-1.2
import { PreflightRefusalError } from '../errors/base.js';
import { info } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';

/** Waits for a busy browser or port without changing or terminating its owner. */
export async function waitForPreflight(
  action: () => Promise<void>,
  seconds?: number
): Promise<void> {
  const deadline = Date.now() + (seconds ?? 0) * 1000;
  let announced = false;
  for (;;) {
    try {
      await action();
      return;
    } catch (error: unknown) {
      if (!(error instanceof PreflightRefusalError) || Date.now() >= deadline) throw error;
      if (!announced) {
        info(`Waiting up to ${seconds} seconds: ${error.message}`);
        announced = true;
      }
      await sleep(Math.min(500, Math.max(1, deadline - Date.now())));
    }
  }
}

/**
 * Spends a `--wait-browser`/`--wait-port` budget BEFORE the engine session
 * lock is taken, so a run queued behind a busy browser or port does not
 * hold the lock (and every peer's build, test and re-export behind it)
 * while it does nothing. The caller re-checks once under the lock.
 *
 * Never refuses on its own: when the budget runs out the run still joins
 * the lock queue, and the single check under the lock decides. A peer's
 * test run that holds the lock legitimately keeps its browser alive until
 * it releases, and refusing here would turn that ordinary queue into a
 * refusal the old in-lock wait never produced. Never terminates anything
 * either: nothing is owned before the lock is won. A refusal whose note is
 * in `clearNotes` (a stale browser the run is allowed to reap under the
 * lock) counts as clear.
 *
 * @param action - The preflight probe, which throws `PreflightRefusalError` while busy
 * @param seconds - The wait budget
 * @param clearNotes - Refusal classes that do not need waiting out
 */
export async function waitBeforeLock(
  action: () => Promise<void>,
  seconds: number | undefined,
  clearNotes: readonly string[] = []
): Promise<void> {
  try {
    await waitForPreflight(async () => {
      try {
        await action();
      } catch (error: unknown) {
        if (error instanceof PreflightRefusalError && clearNotes.includes(error.note)) return;
        throw error;
      }
    }, seconds);
  } catch (error: unknown) {
    if (!(error instanceof PreflightRefusalError)) throw error;
    info(
      `Still busy after the ${seconds ?? 0}-second wait; joining the lock queue and re-checking once under the lock.`
    );
  }
}
