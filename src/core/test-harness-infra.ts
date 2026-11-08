// SPDX-License-Identifier: EUPL-1.2
/**
 * What a harness failure tells the operator: a recognized harness crash after
 * its retries ran out, a green summary that was not trusted, a run that started
 * nothing, a silent SIGSEGV, and the mochitest server that never came up.
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

import type { GreenSummaryRejection, HarnessCrashSignature } from './test-harness-signature.js';

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
      (signature.harnessLines === undefined
        ? ''
        : `Harness lines before the timeout (ports held, what it waited on):\n${signature.harnessLines
            .map((line) => `  ${line}`)
            .join('\n')}\n` +
          'A harness in another checkout holding one of these ports can stall this one; ' +
          'compare with "lsof -nP -iTCP:<port>".\n\n') +
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

/**
 * Builds the operator-facing failure message for a green-looking summary
 * that was rejected on crash or truncation evidence (never trusted as a
 * pass, regardless of how green the embedded counts look).
 */
export function buildGreenSummaryRejectedMessage(
  rejection: GreenSummaryRejection,
  exitCode: number
): string {
  const evidence: string[] = [];
  if (rejection.crashLine !== undefined) {
    evidence.push(`  - crash evidence: ${rejection.crashLine}`);
  }
  if (rejection.exitEvidence !== undefined) {
    evidence.push(`  - ${rejection.exitEvidence}`);
  }
  if (rejection.neverStarted.length > 0) {
    evidence.push(
      `  - requested test file(s) that never started: ${rejection.neverStarted.join(', ')}`
    );
  }
  if (rejection.neverEnded.length > 0) {
    evidence.push(
      `  - test file(s) that started but never finished: ${rejection.neverEnded.join(', ')}`
    );
  }
  return (
    `mach exited ${exitCode} and the embedded suite summary looks green, but FireForge did NOT ` +
    'treat the run as passed:\n\n' +
    `${evidence.join('\n')}\n\n` +
    'A crash- or truncation-shortened run under-reports: the "green" counts only cover the ' +
    'files that ran before the run died, so the summary is not a suite result. Treat this as a ' +
    'FAILED run — check the crash/truncation point in the output above, then re-run the ' +
    'remaining files.'
  );
}

/**
 * Names the known cause of a silent SIGSEGV so the operator checks
 * moz.build registration FIRST instead of paying a full rebuild cycle to
 * rediscover it.
 *
 * @param exitCode - The harness process exit code
 * @param requestedPaths - Test paths the run requested
 */
export function buildSilentSegfaultMessage(
  exitCode: number,
  requestedPaths: readonly string[]
): string {
  return (
    `The test harness died on SIGSEGV (exit ${exitCode}) having printed NO output at all.\n\n` +
    'Known cause, check this FIRST: a `.sys.mjs` imported from a packaged module whose ' +
    '`EXTRA_JS_MODULES` (or namespaced module list) registration is missing from moz.build. ' +
    'The module loader faults before any logging exists, so an unregistered module produces ' +
    'exactly this shape — a dead process with no import error and no stack.\n\n' +
    'What to do, in order:\n' +
    '  1. Run `fireforge lint --per-patch`: the unregistered-system-module check names a new ' +
    'module imported as a resource URL with no moz.build line.\n' +
    '  2. Run `fireforge verify`: its module-resolution preflight resolves every ' +
    '`resource:///modules/…` specifier the queue-owned modules import, including imports ' +
    'added to an EXISTING module — the shape the new-file lint cannot see, and the one that ' +
    'recurs.\n' +
    '  3. Only then look for a product crash: a real one prints a crash dump or a stack.\n\n' +
    `Requested paths: ${requestedPaths.join(', ')}`
  );
}

/**
 * Builds the message for a run that produced no `TEST-START` despite
 * requesting paths, including exit-code-zero runs whose `Passed: 0`
 * summary would otherwise read as a silent false green.
 */
export function buildNoTestsRanMessage(
  exitCode: number,
  requestedPaths: readonly string[],
  zeroChecks = false
): string {
  const exitNote =
    exitCode === 0
      ? 'The harness exited 0 and may have printed a summary line, but a summary without a single TEST-START is not a test result.'
      : `The harness exited ${exitCode} before any TEST-START line.`;
  const startupCrash = zeroChecks
    ? '\n\nThe summary counted zero checks, which is also what a browser dying at startup leaves ' +
      'behind. After a peer commit or a "fireforge build --ui", a chrome or resource URL that ' +
      'resolves to nothing crashes it in CheckForBrokenChromeURL with nothing in this log: read ' +
      '~/Library/Logs/DiagnosticReports for the crash report, then run a plain "fireforge build" ' +
      'and retry.'
    : '';
  return (
    'mach test finished without starting any of the requested tests.\n\n' +
    `${exitNote}${startupCrash}\n\n` +
    `Requested paths: ${requestedPaths.join(', ')}\n\n` +
    'Check that the paths are registered in their test manifest (browser.toml / xpcshell.toml) ' +
    'and that the manifest is reachable from moz.build, then retry.'
  );
}
