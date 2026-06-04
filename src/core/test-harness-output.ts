// SPDX-License-Identifier: EUPL-1.2

export type HarnessEarlyExitKind = 'startup' | 'zero-tests';

export interface HarnessEarlyExit {
  kind: HarnessEarlyExitKind;
  line: string;
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
