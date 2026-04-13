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

    msg += '\n\nTo fix this:\n';
    msg += '  1. Check the error message above for specifics\n';
    // Avoid circular advice when the error is thrown during validation itself.
    if (!this.message.includes('furnace validate')) {
      msg += '  2. Run "fireforge furnace validate" to diagnose issues\n';
    }
    msg += `  ${this.message.includes('furnace validate') ? '2' : '3'}. Use "fireforge doctor --repair-furnace" if state is inconsistent`;

    return msg;
  }
}
