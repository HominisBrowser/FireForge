// SPDX-License-Identifier: EUPL-1.2
import { FireForgeError } from './base.js';
import { ExitCode } from './codes.js';

/**
 * Base error for rebase operations.
 */
export class RebaseError extends FireForgeError {
  readonly code = ExitCode.PATCH_ERROR;

  override get userMessage(): string {
    return `Rebase Error: ${this.message}`;
  }
}

/**
 * Thrown when starting a rebase while an existing session is in progress.
 */
export class RebaseSessionExistsError extends RebaseError {
  constructor() {
    super(
      'A rebase session is already in progress.\n' +
        'Use "fireforge rebase --continue" to resume or "fireforge rebase --abort" to cancel.'
    );
  }
}

/**
 * Thrown when --continue or --abort is used without an active session.
 */
export class NoRebaseSessionError extends RebaseError {
  constructor() {
    super('No rebase session in progress. Start one with "fireforge rebase".');
  }
}
