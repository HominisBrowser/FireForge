// SPDX-License-Identifier: EUPL-1.2
/**
 * Doctor check comparing the CONFIGURED Firefox source pin against what the
 * engine checkout actually is.
 *
 * `fireforge source set` lands `firefox.version` inside `fireforge.json`,
 * beside hand-maintained policy sections. That is convenient and it is also
 * the whole problem: a routine `git checkout -- fireforge.json` — undoing an
 * accidental reformat, say — silently reverts an uncommitted pin along with
 * it, and nothing afterwards reports that the pin and the checkout have
 * diverged. The tell in the field was a gate flipping green with no change
 * that should have made it green.
 *
 * This is deliberately not a lock and not a refusal: a tree may legitimately
 * be mid-migration between two versions. It only makes a mismatched tree
 * VISIBLE, which is all that was missing.
 *
 * Scope is limited by what is actually recorded. `firefox.product`,
 * `firefox.sha256` and `firefox.candidate` have NO counterpart anywhere on
 * disk — `.fireforge/state.json` records only `downloadedVersion` and
 * `baseCommit` — so there is nothing to compare them against and the check
 * says nothing about them rather than implying it verified them.
 */

import { getFirefoxVersion } from '../core/firefox.js';
import type { DoctorCheck } from '../types/commands/index.js';
import { toError } from '../utils/errors.js';
import type { DoctorCheckContext, DoctorCheckDefinition } from './doctor-check-core.js';
import { ok, warning } from './doctor-check-core.js';

const CHECK_NAME = 'Source pin matches engine';

/**
 * Reports the configured pin beside the two facts that can contradict it:
 * the engine's own `browser/config/version.txt`, and the version the last
 * download recorded into state.
 */
async function runSourcePinCheck(ctx: DoctorCheckContext): Promise<DoctorCheck> {
  const pinned = ctx.config?.firefox.version;
  if (pinned === undefined) {
    // The config failed to load (its own check already reported that), so
    // there is no pin to compare. Silence beats a second complaint.
    return ok(CHECK_NAME, 'Skipped: no configured source version');
  }

  let actual: string | undefined;
  try {
    // A blank or whitespace-only version.txt (a truncated write, a partial
    // extraction) carries no version to compare — treat it as absent rather
    // than reporting the engine as being at version "".
    actual = (await getFirefoxVersion(ctx.paths.engine))?.trim() || undefined;
  } catch (error: unknown) {
    // Best-effort: an unreadable version.txt is not a pin mismatch, and a
    // diagnostic must never turn into a failure of its own.
    return ok(
      CHECK_NAME,
      `Configured ${pinned}; engine version could not be read (${toError(error).message})`
    );
  }

  const downloaded = ctx.state.downloadedVersion;
  const mismatches: string[] = [];
  if (actual !== undefined && actual !== pinned) {
    mismatches.push(`engine/browser/config/version.txt reads ${actual}`);
  }
  if (downloaded !== undefined && downloaded !== pinned) {
    mismatches.push(`the last download recorded ${downloaded}`);
  }

  if (mismatches.length === 0) {
    const observed = actual ?? downloaded;
    return ok(
      CHECK_NAME,
      observed === undefined
        ? `Configured ${pinned}; no engine version to compare against yet`
        : `Configured ${pinned}, engine ${observed}`
    );
  }

  return warning(
    CHECK_NAME,
    `fireforge.json pins Firefox ${pinned}, but ${mismatches.join(' and ')}.`,
    'If the pin is right, run "fireforge download" to bring the checkout to it. If the ' +
      'CHECKOUT is right, run "fireforge source set --version <version>" to record it — a ' +
      'pin set but not committed is lost by any revert of fireforge.json, which is the most ' +
      'common way these diverge.'
  );
}

/**
 * Pin-vs-checkout reporting. Needs the loaded config, so it declares the
 * dependency on the config check that populates `ctx.config`; skipped
 * entirely without an engine, where there is nothing to compare.
 */
export const SOURCE_PIN_DOCTOR_CHECK: DoctorCheckDefinition = {
  name: CHECK_NAME,
  skipIf: (ctx) => !ctx.engineExists,
  dependsOn: ['fireforge.json is valid'],
  run: runSourcePinCheck,
};
