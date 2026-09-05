// SPDX-License-Identifier: EUPL-1.2
import { FireForgeError, remedies } from './base.js';
import { ExitCode } from './codes.js';

/**
 * Base error for rebase operations.
 */
export class RebaseError extends FireForgeError {
  readonly code = ExitCode.PATCH_ERROR;

  override get userMessage(): string {
    return (
      `Rebase Error: ${this.message}` +
      remedies([
        'Check the error message above for specifics',
        'Use "fireforge rebase --continue" to resume an interrupted rebase',
        'Use "fireforge rebase --abort" to cancel and restore engine state',
      ])
    );
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

/**
 * Thrown when the session file exists but cannot be used.
 *
 * Without an error of its own, this case is reported as
 * {@link NoRebaseSessionError} by `--continue`/`--abort` while `rebase`
 * reports {@link RebaseSessionExistsError}, a closed cycle in which each
 * command points at the other two. The message names the file so an operator
 * always has a way out, and `--abort` clears a corrupt session rather than
 * refusing to run against one.
 */
export class CorruptRebaseSessionError extends RebaseError {
  constructor(sessionPath: string, reason: string) {
    super(
      `The rebase session at ${sessionPath} cannot be read (${reason}).\n` +
        'Run "fireforge rebase --abort" to discard it and restore the engine, ' +
        'or delete the file to start over.'
    );
  }
}
