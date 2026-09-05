// SPDX-License-Identifier: EUPL-1.2

import { hasKnownTeardownNoise, isKnownTeardownNoiseLine } from './mach-known-noise-filter.js';

export type HarnessEarlyExitKind = 'startup' | 'zero-tests';

export interface HarnessEarlyExit {
  kind: HarnessEarlyExitKind;
  line: string;
}

export interface PostRebuildFailureContext {
  rebuildCommand: string;
  requestedPaths: readonly string[];
  firstFailureLine?: string;
}

function getNonEmptyOutputLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function findFirstMatchingLine(
  lines: readonly string[],
  patterns: readonly RegExp[]
): string | undefined {
  return lines.find((line) => patterns.some((pattern) => pattern.test(line)));
}

const FAILURE_LINE_PATTERNS: readonly RegExp[] = [
  /\bTEST-UNEXPECTED-[A-Z-]+\b/,
  /\bPROCESS-CRASH\b/i,
  /\bTIMEOUT\b/i,
  /timed out/i,
  /HominisBrowserUnavailableError/i,
  /Marionette.*(?:session|startup|start).*fail/i,
  /(?:failed|unable) to (?:start|create|open).*Marionette/i,
  /SessionNotCreatedException/i,
  /Browser process exited during spawn/i,
  /Failed to load (?:resource|chrome):\/\//i,
  /\b(?:Error|Exception|TypeError|ReferenceError|SyntaxError):\s+/,
  /AttributeError:\s+/,
];

/**
 * Finds the first high-signal failure line from captured mach test output.
 *
 * Selection is by first matching line, not by first matching pattern, so the
 * bare `AttributeError:` arm above has exactly the same standing as
 * `TEST-UNEXPECTED-FAIL`: whichever appears earlier in the text wins. That
 * is how a run whose real defect was an export shard's file-count assertion
 * got diagnosed as the recognized mozsystemmonitor teardown crash. The
 * information was present and the selection was wrong, which is the
 * expensive kind of wrong, because the named cause is a real, documented,
 * unrelated upstream defect and therefore reads as an answer.
 *
 * So a capture carrying the recognized teardown incident gets two passes:
 * candidates excluding its `AttributeError` header first, and only if that
 * finds nothing does the full set apply. The narrowness the rest of the
 * codebase maintains is preserved exactly: the exclusion is gated on
 * `hasKnownTeardownNoise` for the whole capture, so it requires both the
 * closed attribute allowlist and a `resourcemonitor.py` frame. A novel
 * attribute, or a traceback from anywhere else, stays a real failure and is
 * still eligible to be reported.
 *
 * @param output - Raw captured stdout/stderr from the run
 * @returns The chosen failure line, or the first non-empty line
 */
export function findFirstUsefulFailureLine(output: string): string | undefined {
  const lines = getNonEmptyOutputLines(output);
  if (hasKnownTeardownNoise(output)) {
    const withoutNoise = lines.filter((line) => !isKnownTeardownNoiseLine(line));
    const preferred = findFirstMatchingLine(withoutNoise, FAILURE_LINE_PATTERNS);
    if (preferred !== undefined) return preferred;
  }
  const matched = findFirstMatchingLine(lines, FAILURE_LINE_PATTERNS);
  return matched ?? lines[0];
}

/** Starts a post-rebuild context block for a focused test failure. */
export function createPostRebuildFailureContext(
  rebuildCommand: string,
  requestedPaths: readonly string[]
): PostRebuildFailureContext {
  return { rebuildCommand, requestedPaths };
}

/** Adds the first useful failure line from captured output to an existing context block. */
export function completePostRebuildFailureContext(
  context: PostRebuildFailureContext,
  output: string
): PostRebuildFailureContext {
  const firstFailureLine = findFirstUsefulFailureLine(output);
  return firstFailureLine ? { ...context, firstFailureLine } : context;
}

/** Prepends post-rebuild context when the test failure happened after a successful rebuild. */
export function prependPostRebuildFailureContext(
  message: string,
  context: PostRebuildFailureContext | undefined
): string {
  if (!context) return message;
  const requestedPaths =
    context.requestedPaths.length > 0 ? context.requestedPaths.join(', ') : '(all tests)';
  return (
    'Post-rebuild test failure:\n\n' +
    `Rebuild command: ${context.rebuildCommand}\n` +
    `Requested paths: ${requestedPaths}\n` +
    `First post-rebuild failure: ${context.firstFailureLine ?? '(no captured output)'}\n\n` +
    message
  );
}

/** Classifies mach output where no requested test actually began running. */
export function classifyHarnessEarlyExit(
  output: string,
  normalizedPaths: readonly string[]
): HarnessEarlyExit | undefined {
  const lines = getNonEmptyOutputLines(output);
  const startupLine = findFirstMatchingLine(lines, [
    /HominisBrowserUnavailableError/i,
    /Marionette.*(?:session|startup|start).*fail/i,
    /(?:failed|unable) to (?:start|create|open).*Marionette/i,
    /SessionNotCreatedException/i,
    /Browser process exited during spawn/i,
  ]);
  if (startupLine) {
    return { kind: 'startup', line: startupLine };
  }

  if (normalizedPaths.length === 0) return undefined;
  const zeroTestsLine = findFirstMatchingLine(lines, [
    /\bRan 0 tests?\b/i,
    /\b0 tests? ran\b/i,
    /\b0 tests? selected\b/i,
    /\b0 subtests\b/i,
    /\bno tests (?:were )?(?:run|ran|selected|collected|found)\b/i,
  ]);
  if (zeroTestsLine) {
    return { kind: 'zero-tests', line: zeroTestsLine };
  }

  return undefined;
}

/** Builds the user-facing message for a harness startup or zero-run failure. */
export function buildHarnessEarlyExitMessage(
  earlyExit: HarnessEarlyExit,
  normalizedPaths: readonly string[]
): string {
  const reason =
    earlyExit.kind === 'startup'
      ? 'The test harness failed during browser/session startup before the selected tests began.'
      : 'The test harness exited after reporting that zero selected tests ran.';
  const paths = normalizedPaths.length > 0 ? normalizedPaths.join(', ') : '(all tests)';
  return (
    `mach test did not run the selected tests.\n\n` +
    `${reason}\n\n` +
    `Actionable harness line: ${earlyExit.line}\n\n` +
    `Requested paths: ${paths}\n\n` +
    'Fix the harness startup/discovery issue above before interpreting this as a test failure.'
  );
}
