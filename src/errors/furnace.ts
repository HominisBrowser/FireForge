// SPDX-License-Identifier: EUPL-1.2
import { FireForgeError } from './base.js';
import { ExitCode } from './codes.js';

/**
 * Error thrown when a furnace component operation fails.
 */
export class FurnaceError extends FireForgeError {
  readonly code = ExitCode.FURNACE_ERROR;

  constructor(
    message: string,
    public readonly component?: string,
    cause?: Error
  ) {
    super(message, cause);
  }

  override get userMessage(): string {
    let msg = this.component
      ? `Furnace Error (${this.component}): ${this.message}`
      : `Furnace Error: ${this.message}`;

    msg += '\n\nRun "fireforge furnace validate" to diagnose issues.';

    return msg;
  }
}
