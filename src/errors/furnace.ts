// SPDX-License-Identifier: EUPL-1.2
import { FireForgeError, remedies } from './base.js';
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
       * whose message already tells the user to run validate, or that are
       * the validate command. An explicit flag rather than sniffing the
       * message for `furnace validate`, which drops the advice from any
       * error that merely mentions the command.
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
    const head = this.component
      ? `Furnace Error (${this.component}): ${this.message}`
      : `Furnace Error: ${this.message}`;

    return (
      head +
      remedies([
        'Check the error message above for specifics',
        ...(this.omitValidateAdvice ? [] : ['Run "fireforge furnace validate" to diagnose issues']),
        'Use "fireforge doctor --repair-furnace" if state is inconsistent',
      ])
    );
  }
}
