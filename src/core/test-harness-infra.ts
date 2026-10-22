// SPDX-License-Identifier: EUPL-1.2
/**
 * Harness failures that are the environment's, not the tests': the
 * operator message for a recognized harness crash after its retries ran
 * out, and the mochitest server that never came up.
 *
 * A server never comes up when the harness's httpd cannot bind its port,
 * typically because a parallel `--jobs` instance, a sibling checkout or a
 * leftover httpd held it (see `harness-port-reservation.ts`). Without this
 * shape the run read as `no-tests`, a finding about the
 * request, and was not retried. It is an infrastructure failure instead:
 * `classifyHarnessRun` reports it as a `harness-crash` carrying
 * `verdictReason: 'server-startup'`, so the harness-crash retry loop
 * (`--harness-retries`) reruns the shard, and a run that exhausts the
 * budget says `reason=server-startup` on its verdict line.
 */

import type { HarnessCrashSignature } from './test-harness-signature.js';

/**
 * The harness's own lines for the shape: the httpd's bind failure
 * (`!!! could not start server on port 8888`) and `runtests.py`'s wait for
 * it (`Timed out while waiting for server startup`).
 */
const SERVER_STARTUP_FAILURE_PATTERNS: readonly RegExp[] = [
  /could not start server on port \d+/,
  /Timed out while waiting for server startup/,
];

/**
 * Detects a mochitest server that failed to start. The caller checks that
 * no test ran first: both lines precede any test.
 *
 * @param output - Captured mach stdout and stderr
 * @returns The infrastructure signature, or undefined
 */
export function detectServerStartupFailure(output: string): HarnessCrashSignature | undefined {
  for (const line of output.split(/\r?\n/)) {
    if (SERVER_STARTUP_FAILURE_PATTERNS.some((pattern) => pattern.test(line))) {
      return {
        reason: 'mochitest server failed to start (server-startup)',
        line: line.trim(),
        verdictReason: 'server-startup',
      };
    }
  }
  return undefined;
}

/**
 * Builds the operator-facing failure message after retries are exhausted.
 *
 * @param signature - The recognized shape
 * @param attempts - Attempts made
 * @param commandLabel - The mach command, for the message
 */
export function buildHarnessCrashMessage(
  signature: HarnessCrashSignature,
  attempts: number,
  commandLabel = 'mach test'
): string {
  if (signature.verdictReason !== 'server-startup') {
    return (
      `${commandLabel} crashed in the harness itself (not in your tests) on all ${attempts} attempt(s).\n\n` +
      `Detected shape: ${signature.reason}\n` +
      `Evidence line: ${signature.line}\n\n` +
      'This failure mode is environmental (mozlog resource monitor / psutil on macOS, focus-stall ' +
      'shutdown re-entry, or a pre-test hang) rather than a test regression. Re-run the command, ' +
      'raise the retry budget with --harness-retries <n>, or run the file in isolation. ' +
      'If it persists across many runs, inspect the mach virtualenv (mach resyncs psutil on its own; ' +
      'patching it manually does not stick).'
    );
  }
  return (
    `${commandLabel} could not start a mochitest server on all ${attempts} attempt(s), so no ` +
    'test ran (an infrastructure failure, not a test result).\n\n' +
    `Evidence line: ${signature.line}\n\n` +
    'Another harness (a parallel --jobs instance, a sibling checkout, or a leftover httpd) ' +
    'most likely held the server port when this one started. Re-run the shard, raise the ' +
    'retry budget with --harness-retries <n>, or check "lsof -nP -iTCP:8888".'
  );
}
