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

    // Trims the constructor frames off the stack. `engines` pins Node >= 22,
    // so the V8-only `captureStackTrace` is always present — the former
    // `typeof === 'function'` guard was an unreachable branch that coverage
    // could never close.
    Error.captureStackTrace(this, this.constructor);
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
 * Renders the trailing "To fix this:" block shared by every FireForge error
 * that offers remedies.
 *
 * Numbering is derived from the array rather than written into each string.
 * Several classes vary their advice by context (`FurnaceError` drops the
 * validate step, `ChecksumMismatchError` adds a Developer Edition note), and
 * hand-numbered branches had to renumber every later step by hand — one
 * conditional away from printing "2." twice.
 *
 * @param steps - The remedy lines, in order, without their numbers
 * @returns The block, starting with the blank-line separator
 */
export function remedies(steps: readonly string[]): string {
  return `\n\nTo fix this:\n${steps.map((step, index) => `  ${index + 1}. ${step}`).join('\n')}`;
}

/**
 * General error for unexpected failures.
 */
export class GeneralError extends FireForgeError {
  readonly code = ExitCode.GENERAL_ERROR;
}

/**
 * A `fireforge test` preflight gate that refused before any harness ran.
 *
 * Exists to carry a `note`, not to change behaviour: it keeps
 * {@link ExitCode.GENERAL_ERROR}, so `docs/exit-codes.md` and every CI
 * consumer keying on the exit status are untouched. The note is a stable
 * kebab-case refusal class that the `FIREFORGE-VERDICT:` line reports as an
 * additive `note=` key. Without it every preflight refusal reached an
 * unattended reader as the single token `reason=preflight`, which covers
 * everything from a missing build to a peer's packaging record — so the one
 * line that survives a truncating pipe could not say WHICH gate fired.
 */
export class PreflightRefusalError extends GeneralError {
  constructor(
    message: string,
    /** Stable refusal class, e.g. `stale-browser`. */
    public readonly note: string
  ) {
    super(message);
  }
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
    return this.argument
      ? `Invalid Argument: ${this.message}\n\nArgument: ${this.argument}`
      : `Invalid Argument: ${this.message}`;
  }
}

/**
 * Error thrown when a spawned command exceeds its `timeout` option.
 *
 * Every `exec*` helper in `src/utils/process.ts` rejects with this type
 * instead of Node's bare `AbortError: The operation was aborted`, which
 * carries no command name, no elapsed time, and no hint that a timeout —
 * not the command — was responsible. See {@link GitIndexingTimeoutError} in
 * errors/git.ts for the git-specific variant.
 */
export class ExecTimeoutError extends FireForgeError {
  readonly code = ExitCode.GENERAL_ERROR;

  /** Standard output captured before the deadline fired (empty when the exec path does not capture). */
  readonly stdout: string;
  /** Standard error captured before the deadline fired (empty when the exec path does not capture). */
  readonly stderr: string;
  /** True when either captured stream was cut off at the exec layer's collector cap. */
  readonly outputTruncated: boolean;

  constructor(
    /** Executable that was spawned (argv[0]). */
    public readonly command: string,
    /** Arguments the executable was spawned with. */
    public readonly args: readonly string[],
    /** Timeout that elapsed, in milliseconds. */
    public readonly timeoutMs: number,
    cause?: unknown,
    output?: ExecTimeoutOutput
  ) {
    super(
      `Command timed out after ${Math.round(timeoutMs / 1000)}s: ${[command, ...args].join(' ')}`,
      cause
    );
    this.stdout = output?.stdout ?? '';
    this.stderr = output?.stderr ?? '';
    this.outputTruncated = output?.truncated ?? false;
  }

  override get userMessage(): string {
    return (
      `${this.message}\n\n` +
      'The command was killed because it exceeded its time budget, not because it failed on its own. ' +
      'If the host is just slow or loaded, re-running may succeed.' +
      this.outputTailForUser()
    );
  }

  /**
   * The last few lines the command printed before it was killed, so an
   * operator can see what it was doing (a `git add -A` stuck on one path,
   * a build step that hung) instead of a bare budget number. Prefers
   * stderr; falls back to stdout when stderr is silent.
   */
  private outputTailForUser(): string {
    const source = this.stderr.trim().length > 0 ? this.stderr : this.stdout;
    const lines = source
      .trimEnd()
      .split(/\r?\n/)
      .filter((line) => line.length > 0);
    if (lines.length === 0) return '';
    const tail = lines.slice(-EXEC_TIMEOUT_TAIL_LINES);
    const label = this.stderr.trim().length > 0 ? 'stderr' : 'stdout';
    const omitted =
      lines.length > tail.length ? ` (last ${tail.length} of ${lines.length} lines)` : '';
    const truncatedNote = this.outputTruncated ? ' [captured output was truncated]' : '';
    return `\n\nOutput before the timeout (${label}${omitted})${truncatedNote}:\n${tail.map((line) => `  ${line}`).join('\n')}`;
  }
}

/** Output captured before an exec timeout fired; see {@link ExecTimeoutError}. */
export interface ExecTimeoutOutput {
  stdout: string;
  stderr: string;
  truncated: boolean;
}

/** How many trailing output lines {@link ExecTimeoutError.userMessage} shows. */
const EXEC_TIMEOUT_TAIL_LINES = 20;

/**
 * Error thrown when a file-lock wait times out because another process holds
 * the lock.
 *
 * Dedicated subclass so the CLI boundary renders lock contention as the
 * one-line reason-first/remedy-second refusal it is. As a plain `Error` it
 * is treated by `withErrorHandling` as an internal failure and printed with
 * a five-frame stack — a correct refusal that looks like a crash.
 *
 * Exit code 15, not 1: the run never started. A script that retries on
 * failure wants to re-queue this one, not treat it as a failure of the work
 * it asked for. Every lock in FireForge shares the class and therefore the
 * code — the fact is the same whichever lock was contended.
 */
export class LockContentionError extends FireForgeError {
  readonly code = ExitCode.LOCK_TIMEOUT;
}

/**
 * Error thrown when a test run completed but its verdict cannot be trusted,
 * because `engine/` changed (or stopped being probeable) while the harness
 * was running.
 *
 * Dedicated subclass for its exit code alone: as a `GeneralError` this
 * refusal exited 1 beside real test failures' 5, and a summary line reading
 * `FAIL — exit 1` next to `FAIL — exit 5` invites treating them as the same
 * kind of fact. They are opposites — one suite failed, the other's result
 * was discarded — and only a distinct code makes "unknown, re-run"
 * mechanically separable from "red".
 */
export class InconclusiveVerdictError extends FireForgeError {
  readonly code = ExitCode.INCONCLUSIVE;
}

/**
 * Error thrown when the user INTERRUPTS an interactive prompt — Esc or
 * Ctrl+C, i.e. `isCancel(...)`.
 *
 * Not for a prompt the operator deliberately answered "no" to: 130 is
 * 128+SIGINT, which claims an interrupt. A declined confirmation is a
 * successful run that chose not to proceed, and exits 0.
 */
export class CancellationError extends FireForgeError {
  readonly code = ExitCode.USER_CANCELLED;
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
