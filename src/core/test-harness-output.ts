// SPDX-License-Identifier: EUPL-1.2

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

/** Finds the first high-signal failure line from captured mach test output. */
export function findFirstUsefulFailureLine(output: string): string | undefined {
  const lines = getNonEmptyOutputLines(output);
  const matched = findFirstMatchingLine(lines, [
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
  ]);
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
