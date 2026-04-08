// SPDX-License-Identifier: EUPL-1.2
import { FireForgeError } from './base.js';
import { ExitCode } from './codes.js';

/**
 * Error thrown when patch operations fail.
 */
export class PatchError extends FireForgeError {
  readonly code = ExitCode.PATCH_ERROR;

  constructor(
    message: string,
    public readonly patchName?: string,
    cause?: Error
  ) {
    super(message, cause);
  }

  override get userMessage(): string {
    let msg = `Patch Error: ${this.message}`;

    if (this.patchName) {
      msg += `\n\nPatch: ${this.patchName}`;
    }

    msg += '\n\nTo fix this:\n';
    msg += '  1. Check if the patch is compatible with the Firefox version\n';
    msg += '  2. Use "fireforge reset" to start with clean source\n';
    msg += '  3. Update the patch for the current Firefox version';

    return msg;
  }
}
