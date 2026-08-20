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
 * Raised when one of FireForge's own internal invariants did not hold —
 * the failure of a runtime assertion from `src/utils/assert.ts`.
 *
 * Dedicated subclass (rather than raw GeneralError) because an invariant
 * failure is categorically different from every other error the CLI
 * raises: it is a bug in FireForge, not something the operator did or can
 * fix. That difference is worth carrying all the way to the exit status
 * (see {@link ExitCode.INTERNAL_ERROR}) so a CI job can escalate it
 * instead of retrying it, and it is the one error class the CLI boundary
 * prints a stack trace for — the stack is the report.
 *
 * Assertions exist so that a violated invariant stops the run at the
 * first inconsistency instead of continuing to write. In the mutating
 * paths that means the surrounding rollback journal restores the engine
 * before this reaches the operator; see `docs/lifecycle-invariants.md`.
 */
export class InternalInvariantError extends FireForgeError {
  readonly code = ExitCode.INTERNAL_ERROR;

  override get userMessage(): string {
    return (
      `Internal error: ${this.message}\n\n` +
      'This is a bug in FireForge itself, not a problem with your project — ' +
      'no configuration change on your side would have prevented it. The ' +
      'operation stopped at the first inconsistency rather than continuing ' +
      'to write.\n\n' +
      'To report this:\n' +
      '  1. Keep the full output above, including the stack trace.\n' +
      '  2. Note the command you ran and what the project looked like at the time.\n' +
      '  3. Open an issue at https://github.com/HominisBrowser/FireForge/issues'
    );
  }
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
 * Error thrown when a spawned command exceeds its `timeout` option.
 *
 * Every `exec*` helper in `src/utils/process.ts` rejects with this type
 * (instead of Node's bare `AbortError: The operation was aborted`) when the
 * caller-supplied timeout fires. The bare AbortError bit an operator during
 * the 2026-04-24 eval (see {@link GitIndexingTimeoutError} in errors/git.ts):
 * an 854 s git indexing pass died with no command name, no elapsed time, and
 * no hint that a timeout — not git — was responsible. The git path gained a
 * site-local typed error then; this class extends the same courtesy to every
 * other `timeout` caller.
 */
export class ExecTimeoutError extends FireForgeError {
  readonly code = ExitCode.GENERAL_ERROR;

  constructor(
    /** Executable that was spawned (argv[0]). */
    public readonly command: string,
    /** Arguments the executable was spawned with. */
    public readonly args: readonly string[],
    /** Timeout that elapsed, in milliseconds. */
    public readonly timeoutMs: number,
    cause?: unknown
  ) {
    super(
      `Command timed out after ${Math.round(timeoutMs / 1000)}s: ${[command, ...args].join(' ')}`,
      cause
    );
  }

  override get userMessage(): string {
    return (
      `${this.message}\n\n` +
      'The command was killed because it exceeded its time budget, not because it failed on its own. ' +
      'If the host is just slow or loaded, re-running may succeed.'
    );
  }
}

/**
 * Error thrown when a file-lock wait times out because another process
 * holds the lock.
 *
 * Dedicated subclass so the CLI boundary renders lock contention as the
 * one-line reason-first/remedy-second refusal it is — before this, the
 * timeout surfaced as a plain `Error`, which `withErrorHandling` treats
 * as an internal failure and prints with a five-frame stack. The refusal
 * was always correct; the presentation made it look like a crash.
 */
export class LockContentionError extends FireForgeError {
  readonly code = ExitCode.GENERAL_ERROR;
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
