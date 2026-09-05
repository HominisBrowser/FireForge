// SPDX-License-Identifier: EUPL-1.2
/**
 * macOS display power-state probe for the headed no-output stall.
 *
 * `TIMEOUT … application timed out after N seconds with no output` /
 * `Ran 0 checks` has three known causes, one of them purely environmental:
 * a headed run on an unattended machine whose display is asleep or locked.
 * A headed Firefox on a sleeping display never paints, never reaches its
 * first test, and dies at the no-output timeout, which from the log alone
 * is indistinguishable from a product hang.
 *
 * `caffeinate -disu` does not cure it. It prevents sleep, but it cannot
 * wake a display that is already asleep, so wrapping the run changes
 * nothing once the machine has dimmed. `fireforge test` defaults to
 * headed, so an unattended run walks straight into this.
 *
 * The probe is advisory and fail-open: anything unexpected reports
 * `'unknown'` and the caller degrades to the generic triage list rather than
 * asserting an environment it could not measure.
 */

import { toError } from '../utils/errors.js';
import { verbose } from '../utils/logger.js';
import { exec } from '../utils/process.js';

/** Measured display power state, or `'unknown'` when nothing was measured. */
export type DisplaySleepState = 'asleep' | 'awake' | 'unknown';

/** Bound on the probe so a wedged `pmset` cannot extend a failing run. */
const DISPLAY_PROBE_TIMEOUT_MS = 5_000;

/**
 * IOKit power state at which `IODisplayWrangler` is fully lit. Lower
 * states are dimmed or off. macOS reports 4 for a live display.
 */
const DISPLAY_AWAKE_POWER_STATE = 4;

/**
 * Parses `pmset -g powerstate IODisplayWrangler` output.
 *
 * The command prints a header row and then one row per driver, e.g.
 *
 * ```
 * Current power states:
 *   IODisplayWrangler             4       12    -1
 * ```
 *
 * Only the `IODisplayWrangler` row matters, and only its first numeric
 * column (the current power state). Any other shape (no such row, a
 * non-numeric column, an error message) is `'unknown'`, never a guess.
 *
 * Pure. Exported for direct unit testing.
 *
 * @param stdout - Raw `pmset -g powerstate IODisplayWrangler` output
 * @returns The measured state, or `'unknown'`
 */
export function parseDisplayPowerState(stdout: string): DisplaySleepState {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.includes('IODisplayWrangler')) continue;
    const match = /IODisplayWrangler\s+(\d+)/.exec(line);
    const state = match?.[1];
    if (state === undefined) continue;
    return Number.parseInt(state, 10) >= DISPLAY_AWAKE_POWER_STATE ? 'awake' : 'asleep';
  }
  return 'unknown';
}

/**
 * Probes the display's power state. Non-darwin platforms report `'unknown'`
 * without spawning anything: the stall shape this serves is macOS-specific
 * and no equivalent single-command probe is wired for other platforms.
 *
 * @param platform - `process.platform`-style id (injected for testability)
 * @returns The measured state, or `'unknown'` when unmeasurable
 */
export async function probeDisplaySleepState(platform: string): Promise<DisplaySleepState> {
  if (platform !== 'darwin') return 'unknown';
  try {
    const result = await exec('pmset', ['-g', 'powerstate', 'IODisplayWrangler'], {
      timeout: DISPLAY_PROBE_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      verbose(`Display power-state probe failed (pmset exit ${result.exitCode}).`);
      return 'unknown';
    }
    return parseDisplayPowerState(result.stdout);
  } catch (error: unknown) {
    verbose(`Display power-state probe failed: ${toError(error).message}`);
    return 'unknown';
  }
}
