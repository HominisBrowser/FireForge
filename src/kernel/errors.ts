// SPDX-License-Identifier: EUPL-1.2
/**
 * The one error type the CLI reports, the exit-code table, and the helpers for
 * normalising whatever a `catch` receives. Imports nothing.
 */

/** Process exit codes. Each names a category a script can branch on. */
export const ExitCode = {
  SUCCESS: 0,
  /** Unspecified failure the operator can usually act on. */
  GENERAL_ERROR: 1,
  /** `fireforge.json` or a state document is missing or invalid. */
  CONFIG_ERROR: 2,
  /** Downloading or extracting the Firefox source failed. */
  DOWNLOAD_ERROR: 3,
  /** A git operation failed. */
  GIT_ERROR: 4,
  /** `mach` failed: a build that did not compile, a test suite that went red. */
  BUILD_ERROR: 5,
  /** A patch did not apply or the queue is inconsistent. */
  PATCH_ERROR: 6,
  /** A required tool (git, python3, tar) is not installed. */
  MISSING_DEPENDENCY: 7,
  /** A command-line argument or option is invalid. */
  INVALID_ARGUMENT: 8,
  /** Component management failed. */
  FURNACE_ERROR: 9,
  /** Conflict resolution failed. */
  RESOLUTION_ERROR: 10,
  /** An internal invariant did not hold: a bug in FireForge, never the operator's to fix. */
  INTERNAL_ERROR: 11,
  /** A smoke run saw console errors inside its window. */
  SMOKE_EXIT_FAILURE: 12,
  /** A smoke run's browser exited before its window elapsed. */
  SMOKE_LAUNCH_FAILURE: 13,
  /** A result exists but cannot be trusted. Re-run it; do not report it as red. */
  INCONCLUSIVE: 14,
  /** A lock wait expired, so the work never started. Re-queue it. */
  LOCK_TIMEOUT: 15,
  /** The user interrupted the command or a prompt (128 + SIGINT). */
  USER_CANCELLED: 130,
  /** The command was asked to stop (128 + SIGTERM). */
  TERMINATED: 143,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/** What a {@link FireForgeError} carries besides its code and message. */
export interface ErrorDetails {
  /** Defaults to {@link ExitCode.GENERAL_ERROR}. */
  exitCode?: ExitCode;
  /** What the operator should do next, printed after the message. */
  hint?: string;
  cause?: unknown;
}

/**
 * A failure the CLI reports without a stack trace. `code` is a stable
 * kebab-case tag (`lock-timeout`, `invalid-argument`) that scripts read from
 * the `--json` failure envelope; a module that needs a category of its own
 * picks a code and an exit code rather than declaring a subclass.
 */
export class FireForgeError extends Error {
  readonly code: string;
  readonly exitCode: ExitCode;
  readonly hint: string | undefined;

  constructor(code: string, message: string, details: ErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'FireForgeError';
    this.code = code;
    this.exitCode = details.exitCode ?? ExitCode.GENERAL_ERROR;
    this.hint = details.hint;
  }
}

/**
 * The user interrupted an interactive prompt. A prompt answered "no" is not a
 * cancellation: that run chose not to proceed and exits 0.
 */
export class CancelledError extends FireForgeError {
  constructor(message = 'Cancelled.') {
    super('cancelled', message, { exitCode: ExitCode.USER_CANCELLED });
    this.name = 'CancelledError';
  }
}

/** Normalises any thrown value into an `Error`, keeping the original as `cause`. */
export function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return new Error(error.message, { cause: error });
  }
  return new Error(typeof error === 'string' ? error : String(error), { cause: error });
}

/**
 * The errno string (`ENOENT`, `EACCES`) of a thrown value, or undefined. The
 * check is structural, so a plain `{code}` object from another realm counts.
 */
export function errnoCode(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return undefined;
}

/** A failure description, or a thunk producing one so a hot path builds no string. */
type InvariantMessage = string | (() => string);

function internalError(message: InvariantMessage): FireForgeError {
  return new FireForgeError('internal', typeof message === 'function' ? message() : message, {
    exitCode: ExitCode.INTERNAL_ERROR,
  });
}

/**
 * Asserts state FireForge itself established. Never input validation: anything
 * derived from the user, the filesystem or a subprocess gets a real error.
 *
 * @param condition - The invariant
 * @param message - What was supposed to be true
 */
export function invariant(condition: unknown, message: InvariantMessage): asserts condition {
  if (!condition) throw internalError(message);
}

/**
 * Returns a value that must be present, as an inline {@link invariant}.
 *
 * @param value - The value
 * @param message - What was supposed to be present
 */
export function defined<T>(value: T, message: InvariantMessage): NonNullable<T> {
  if (value === null || value === undefined) throw internalError(message);
  return value;
}
