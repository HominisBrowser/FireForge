// SPDX-License-Identifier: EUPL-1.2
import { FireForgeError } from './base.js';
import { ExitCode } from './codes.js';

/**
 * Error raised by `fireforge run --smoke-exit` when the captured console
 * stream produced one or more error lines that did NOT match the
 * configured allowlist.
 *
 * Distinct from `BuildError` so CI pipelines can route smoke failures
 * differently from build failures and so the exit code is the smoke-run
 * contract's `SMOKE_EXIT_FAILURE` rather than the generic `BUILD_ERROR`.
 */
export class SmokeRunError extends FireForgeError {
  readonly code: ExitCode;

  constructor(message: string, exitCode: ExitCode, cause?: Error) {
    super(message, cause);
    this.code = exitCode;
  }

  override get userMessage(): string {
    return `Smoke run failed: ${this.message}`;
  }
}
