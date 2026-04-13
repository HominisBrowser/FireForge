// SPDX-License-Identifier: EUPL-1.2
/**
 * Dirty-engine confirmation/reset flow.
 */

import { confirm } from '@clack/prompts';

import { hasChanges } from '../../core/git.js';
import { InvalidArgumentError } from '../../errors/base.js';
import { cancel, isCancel, warn } from '../../utils/logger.js';

/** Options for the dirty-engine confirmation prompt. */
export interface DirtyEngineConfirmationOptions {
  engineDir: string;
  yes: boolean;
  nonInteractiveHint: string;
  warningMessage: string;
  promptMessage: string;
  cancelMessage: string;
}

/**
 * Checks if the engine has uncommitted changes and prompts for confirmation.
 * Returns true if safe to proceed, false if the user cancelled.
 * Throws in non-interactive mode without --yes.
 */
export async function confirmDirtyEngineReset({
  engineDir,
  yes,
  nonInteractiveHint,
  warningMessage,
  promptMessage,
  cancelMessage,
}: DirtyEngineConfirmationOptions): Promise<boolean> {
  if (!(await hasChanges(engineDir)) || yes) {
    return true;
  }

  const isInteractive = process.stdin.isTTY && process.stdout.isTTY;
  if (!isInteractive) {
    throw new InvalidArgumentError(
      'Engine has uncommitted changes and interactive confirmation is not available. Use --yes to proceed.',
      nonInteractiveHint
    );
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
