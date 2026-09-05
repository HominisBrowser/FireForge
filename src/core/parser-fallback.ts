// SPDX-License-Identifier: EUPL-1.2
import { GeneralError } from '../errors/base.js';
import { toError } from '../utils/errors.js';
import { warn } from '../utils/logger.js';

export interface ParserFallbackEvent {
  context: string;
  reason: string;
}

const parserFallbackEvents: ParserFallbackEvent[] = [];

/** Returns recorded parser fallback events without clearing the event buffer. */
/** Returns and clears the recorded parser fallback events. */
export function consumeParserFallbackEvents(): ParserFallbackEvent[] {
  const events = [...parserFallbackEvents];
  parserFallbackEvents.length = 0;
  return events;
}

/**
 * Result of a parser-with-fallback invocation, carrying both the computed
 * value and metadata about which code path produced it.
 */
/**
 * The `rethrowIf` predicate every AST-primary caller wants.
 *
 * Rethrows internal-invariant `GeneralError`s ("Unexpected empty …array"):
 * those are programming bugs, and retrying the legacy scanner cannot fix a
 * broken invariant, it just buries the stack. Everything else still falls
 * back, which matters: the AST path raises a raw acorn SyntaxError
 * on chrome sources acorn cannot parse (preprocessor directives), and
 * BuildError when the file's shape is unexpected. Both are exactly what the
 * legacy scanner is here to handle.
 *
 * @param error - The error the primary parser threw
 * @returns True when the error must propagate instead of falling back
 */
export function isInternalInvariantFailure(error: unknown): boolean {
  return error instanceof GeneralError;
}

export interface ParserResult<T> {
  /** The computed value (from either the primary or fallback path). */
  value: T;
  /** True when the primary parser failed and the fallback was used. */
  usedFallback: boolean;
  /** The error that caused the primary parser to fail (undefined when primary succeeded). */
  fallbackReason?: string;
}

/**
 * Wraps a primary (AST/tokenizer) parser with a legacy (regex/line-based)
 * fallback. If the primary throws, a warning is logged and the fallback is
 * used instead.
 *
 * Returns a {@link ParserResult} so callers (and tests) can detect which
 * code path was taken and surface it in logs or assertions.
 *
 * @param primary - The modern parser implementation
 * @param fallback - The legacy fallback implementation
 * @param context - File/context name used in the warning message
 * @param rethrowIf - Optional predicate. If it returns true for the caught
 *   error the error is re-thrown instead of falling back (useful for
 *   domain-specific errors that should not be swallowed).
 */
export function withParserFallback<T>(
  primary: () => T,
  fallback: () => T,
  context: string,
  rethrowIf?: (error: unknown) => boolean
): ParserResult<T> {
  try {
    return { value: primary(), usedFallback: false };
  } catch (error: unknown) {
    if (rethrowIf?.(error)) throw error;
    const reason = toError(error).message;
    parserFallbackEvents.push({ context, reason });
    warn(`AST/tokenizer parsing failed for ${context}, falling back to legacy. Error: ${reason}`);
    return { value: fallback(), usedFallback: true, fallbackReason: reason };
  }
}
