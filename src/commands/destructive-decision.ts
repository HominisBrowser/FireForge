// SPDX-License-Identifier: EUPL-1.2
import type { DestructiveOpResult } from '../core/destructive.js';
import { outro } from '../utils/logger.js';

/** The dry-run outro every command prints, spelled once. */
const DRY_RUN_OUTRO = 'Dry run complete — no changes made';

/**
 * Closes out a {@link DestructiveOpResult} and says whether to run the
 * mutation.
 *
 * Eleven commands had copied the same tail: `if (decision === 'dry-run') {
 * outro(…); return; } if (decision === 'declined') { outro(…); return; }`.
 * The dry-run wording is a user-facing contract that must not drift between
 * commands, so it lives here. The declined wording is per-command and stays
 * a parameter.
 *
 * `confirmDestructive` never mutates on its own, so a caller that forgets this
 * check silently performs a "dry run" for real. That is why this returns a
 * boolean the caller must act on instead of being a helper that returns void.
 * @param decision - The result from `confirmDestructive`.
 * @param declinedOutro - Outro to print when the operator answered "no".
 * @returns True when the caller should proceed with the mutation.
 */
export function proceedAfterDecision(
  decision: DestructiveOpResult,
  declinedOutro: string
): boolean {
  if (decision === 'dry-run') {
    outro(DRY_RUN_OUTRO);
    return false;
  }
  if (decision === 'declined') {
    outro(declinedOutro);
    return false;
  }
  return true;
}
