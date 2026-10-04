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
