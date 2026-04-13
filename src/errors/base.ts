// SPDX-License-Identifier: EUPL-1.2
import { ExitCode } from './codes.js';

/**
 * Base error class for all FireForge errors.
 * Provides structured error information with exit codes and user-friendly messages.
 */
export abstract class FireForgeError extends Error {
  /** Exit code to use when this error causes process termination */
  abstract readonly code: ExitCode;

  /**
   * Creates a new FireForgeError.
   * @param message - Technical error message for logging
   * @param cause - The underlying error that caused this error
   */
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
    if (cause !== undefined) {
      this.cause = cause;
    }

    // Maintains proper stack trace in V8 environments
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * User-friendly error message with context and suggested fixes.
   * Override in subclasses to provide specific guidance.
   */
  get userMessage(): string {
    return this.message;
  }
}

/**
 * General error for unexpected failures.
 */
export class GeneralError extends FireForgeError {
  readonly code = ExitCode.GENERAL_ERROR;
}

/**
 * Raised when a legacy regex/brace-depth fallback parser decides it
 * cannot safely perform its mutation — e.g. because a block it expected
 * to walk never closes, because the inserted result fails a round-trip
 * brace balance check, or because an expected pattern is missing.
 *
 * Dedicated subclass (rather than raw GeneralError) so callers and tests
 * can distinguish "the fallback refused to corrupt this file" from other
 * failure modes, and so {@link withParserFallback} callers can opt into
 * re-throwing fallback refusals instead of silently swallowing them.
 */
export class ParserFallbackError extends FireForgeError {
  readonly code = ExitCode.GENERAL_ERROR;

  constructor(
    message: string,
    /** Filename or logical context where the fallback ran (e.g. `browser-init.js`). */
    public readonly context?: string,
    cause?: unknown
  ) {
    super(message, cause);
  }

  override get userMessage(): string {
    return this.context ? `${this.message} (in ${this.context})` : this.message;
  }
}

/**
 * Error thrown when a command-line argument is invalid.
 */
export class InvalidArgumentError extends FireForgeError {
  readonly code = ExitCode.INVALID_ARGUMENT;

  constructor(
    message: string,
    public readonly argument?: string,
    cause?: Error
  ) {
    super(message, cause);
  }

  override get userMessage(): string {
    let msg = `Invalid Argument: ${this.message}`;

    if (this.argument) {
      msg += `\n\nArgument: ${this.argument}`;
    }

    return msg;
  }
}

/**
 * Error thrown when the user cancels an interactive prompt.
 */
export class CancellationError extends FireForgeError {
  readonly code = ExitCode.GENERAL_ERROR;
  constructor() {
    super('cancelled');
  }
}

/**
 * Error thrown when patch resolution fails.
 */
export class ResolutionError extends FireForgeError {
  readonly code = ExitCode.RESOLUTION_ERROR;
}

/**
 * Sentinel error used to propagate an exit code to the CLI entrypoint
 * without calling process.exit() from shared library code.
 *
 * The user-visible error message has already been logged by the time this
 * is thrown — the entrypoint only needs to read `.exitCode` and terminate.
 */
export class CommandError extends Error {
  constructor(public readonly exitCode: ExitCode) {
    super(`Command failed with exit code ${exitCode}`);
    this.name = 'CommandError';
  }
}
