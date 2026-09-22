// SPDX-License-Identifier: EUPL-1.2
/**
 * Dirty-engine confirmation/reset flow.
 */

import { confirm } from '@clack/prompts';

import { stdioIsInteractive } from '../../core/destructive.js';
import { hasChanges } from '../../core/git.js';
import { InvalidArgumentError } from '../../errors/base.js';
import { cancel, isCancel, warn } from '../../utils/logger.js';

/** Options for the dirty-engine confirmation prompt. */
export interface DirtyEngineConfirmationOptions {
  engineDir: string;
  yes: boolean;
  /**
   * Full remediation command the user should run in non-interactive mode,
   * e.g. `"fireforge rebase --abort --yes"`. Rendered inline in the
   * non-interactive error message so the user gets a paste-ready
   * command instead of a bare flag name.
   */
  nonInteractiveCommand: string;
  /**
   * Argument identifier attached to the thrown {@link InvalidArgumentError}
   * (typically the flag name, e.g. `"--yes"`). Separate from
   * `nonInteractiveCommand` so the error's `argument` field carries the
   * canonical flag name for structured handling.
   */
  argumentName: string;
  warningMessage: string;
  promptMessage: string;
  cancelMessage: string;
  /**
   * Precomputed dirtiness. A caller that already measured what would be
   * lost (and may count more than the working tree, such as commits made
   * on top of the base) passes it here instead of the `hasChanges` probe.
   */
  dirty?: boolean;
  /**
   * Replaces the generic "Engine has uncommitted changes" opening of the
   * non-interactive refusal, so the refusal names what would be lost.
   */
  refusalDetail?: string;
}

/**
 * Checks if the engine has uncommitted changes and prompts for confirmation.
 * Returns true if safe to proceed, false if the user cancelled.
 * Throws in non-interactive mode without --yes.
 */
export async function confirmDirtyEngineReset({
  engineDir,
  yes,
  nonInteractiveCommand,
  argumentName,
  warningMessage,
  promptMessage,
  cancelMessage,
  dirty,
  refusalDetail,
}: DirtyEngineConfirmationOptions): Promise<boolean> {
  if (yes || !(dirty ?? (await hasChanges(engineDir)))) {
    return true;
  }

  const isInteractive = stdioIsInteractive();
  if (!isInteractive) {
    const opening =
      refusalDetail !== undefined
        ? `${refusalDetail} Interactive confirmation is not available.`
        : 'Engine has uncommitted changes and interactive confirmation is not available.';
    throw new InvalidArgumentError(`${opening} Run: ${nonInteractiveCommand}`, argumentName);
  }

  warn(warningMessage);

  const confirmed = await confirm({
    message: promptMessage,
    initialValue: false,
  });

  if (isCancel(confirmed) || !confirmed) {
    cancel(cancelMessage);
    return false;
  }

  return true;
}
