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
  force: boolean;
  nonInteractiveHint: string;
  warningMessage: string;
  promptMessage: string;
  cancelMessage: string;
}

/**
 * Checks if the engine has uncommitted changes and prompts for confirmation.
 * Returns true if safe to proceed, false if the user cancelled.
 * Throws in non-interactive mode without --force.
 */
export async function confirmDirtyEngineReset({
  engineDir,
  force,
  nonInteractiveHint,
  warningMessage,
  promptMessage,
  cancelMessage,
}: DirtyEngineConfirmationOptions): Promise<boolean> {
  if (!(await hasChanges(engineDir)) || force) {
    return true;
  }

  const isInteractive = process.stdin.isTTY && process.stdout.isTTY;
  if (!isInteractive) {
    throw new InvalidArgumentError(
      'Engine has uncommitted changes and interactive confirmation is not available. Use --force to proceed.',
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
