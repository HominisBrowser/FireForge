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
    cause?: Error,
    options?: {
      /**
       * Suppresses the "run furnace validate" advice line. Set by callers
       * whose message already tells the user to run validate, or that ARE
       * the validate command. An explicit flag rather than sniffing the
       * message for `furnace validate`, which drops the advice from any
       * error that merely MENTIONS the command.
       */
      omitValidateAdvice?: boolean;
    }
  ) {
    super(message, cause);
    this.omitValidateAdvice =
      options?.omitValidateAdvice ?? message.includes('Run "fireforge furnace validate"');
  }

  private readonly omitValidateAdvice: boolean;

  override get userMessage(): string {
    let msg = this.component
      ? `Furnace Error (${this.component}): ${this.message}`
      : `Furnace Error: ${this.message}`;

    msg += '\n\nTo fix this:\n';
    msg += '  1. Check the error message above for specifics\n';
    if (!this.omitValidateAdvice) {
      msg += '  2. Run "fireforge furnace validate" to diagnose issues\n';
    }
    msg += `  ${this.omitValidateAdvice ? '2' : '3'}. Use "fireforge doctor --repair-furnace" if state is inconsistent`;

    return msg;
  }
}
