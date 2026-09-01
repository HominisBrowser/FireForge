// SPDX-License-Identifier: EUPL-1.2
/**
 * Operator-facing triage for the `timed out … with no output` / `Ran 0
 * checks` stall — the shape where the harness dies before ANY test output.
 *
 * Split out of `test-harness-crash.ts`, which CLASSIFIES runs; this module
 * only renders advice about one already-classified shape. Keeping the two
 * apart matters because the census below carries claims of unequal
 * evidential strength, and the rules for editing it are not the rules for
 * editing a classifier: a pattern in the classifier is either matched by
 * the output or not, while a cause in the census is an assertion about the
 * world that an operator will act on.
 *
 * Everything here is pure — the platform and the probed display state are
 * injected, so unit tests need no mocking.
 */

import type { DisplaySleepState } from './display-state.js';
import type { HarnessCrashSignature } from './test-harness-signature.js';

/**
 * First step for the `timed out … with no output` / `Ran 0 checks`
 * signature, printed ABOVE the cause list. Running a known-good control
 * separates "this test" from "this build" and is the correct opening move
 * for EVERY cause below — it is not specific to any one of them, so
 * attaching it to a single entry made reaching that entry informationally
 * empty.
 */
const NO_OUTPUT_STALL_CONTROL_STEP =
  'First, run a known-good control test. If the control stalls too, the cause is not the test ' +
  'under investigation, and the list below applies to the build or the host.';

/**
 * Recorded causes of the `timed out … with no output` / `Ran 0 checks`
 * signature, each paired with the probe that DISCRIMINATES it from the
 * others. Printed verbatim under the hint.
 *
 * Evidence per entry is deliberately unequal, and the text says so:
 *
 *  - (1) is MEASURED — `probeDisplaySleepState` reads the display's power
 *    state, so the hint states it as fact rather than as a possibility.
 *  - (2) is discriminated by `--headless`.
 *  - (4) is MECHANICAL and was root-caused downstream: the harness serves
 *    its manifest from `server.js` on 8888, and a survivor of an
 *    interrupted run keeps the port. Its probe is exact, and the preflight
 *    in `mochitest-server-port.ts` now refuses it before a run starts.
 *  - (3) is now MECHANICAL and root-caused, replacing the correlation an
 *    earlier revision recorded. A `chrome://` (or `resource://`) URL that
 *    resolves to nothing reaches `CheckForBrokenChromeURL`
 *    (netwerk/base/nsNetUtil.cpp), which outside automation only
 *    `printf_stderr`s `Missing chrome or resource URL: <uri>` — but under
 *    `xpc::IsInAutomation()` the same condition is
 *    `MOZ_CRASH_UNSAFE_PRINTF("Missing chrome or resource URLs: %s")`. A
 *    downstream reproduction symbolicated the faulting frame as
 *    `CheckForBrokenChromeURL`, which is the established diagnosis the bar
 *    in `mach-error-hints.ts` asks for. The discredited "stalls first
 *    paint" story an even earlier revision asserted must not come back: a
 *    failed image load in Gecko fires `error` and does not gate the
 *    document load event.
 *
 * Detection by log line is deliberately NOT specified for (3), and the
 * reason is the mechanism itself: in the reproduction the crash landed in a
 * CONTENT process (`plugin-container`, a child of the browser) with the
 * crash reporter compiled out, so the harness log carried neither the crash
 * message nor a crash line — only the no-output timeout, `Ran 0 checks`,
 * and mochitest's "Can't trigger Breakpad, just killing process". Under
 * automation the message is in the process that DIED, not in the log, so
 * the census points at the two artefacts that do carry it: the OS crash
 * report (whose faulting frame names `CheckForBrokenChromeURL`) and the
 * out-of-automation smoke probe (which prints the non-crashing spelling
 * and, since 0.45.0, counts it as an unallowed error so the exit code
 * agrees with the capture).
 */
const NO_OUTPUT_STALL_TRIAGE = [
  '  1. A sleeping or locked display on an unattended HEADED run (macOS). The browser never ' +
    'paints and never reaches its first test.',
  '  2. A headless SWGL compositor failure — re-run with --headless to separate this from (1): ' +
    'if --headless passes, the stall was display/compositor-side, not product-side.',
  '  3. A broken `chrome://` or `resource://` URL reached from the startup document. Under ' +
    'automation this is a MOZ_CRASH in whichever process opened the channel ' +
    '(CheckForBrokenChromeURL, netwerk/base/nsNetUtil.cpp), so the browser dies before the ' +
    'harness sees anything. Expect the log to name NOTHING: with the crash in a content ' +
    'process and the crash reporter compiled out, the only artefacts are the OS crash report ' +
    '(macOS: ~/Library/Logs/DiagnosticReports/plugin-container-*.ips — the faulting frame ' +
    'reads CheckForBrokenChromeURL) and the smoke probe below. Discriminate with ' +
    '"fireforge run --smoke-exit 60 --headless --capture-console <file>", which launches the ' +
    'same browser OUTSIDE automation, where the same condition only PRINTS ' +
    '"Missing chrome or resource URL: <uri>" — a line the probe counts as an unallowed ' +
    'error, so its exit code and its capture now agree. A clean window with no unallowed ' +
    'console errors means product-side startup is healthy and the stall is harness- or ' +
    'test-side.',
  '  4. A stale mochitest httpd holding the harness server port (127.0.0.1:8888). A fresh ' +
    "browser connects to THAT server, which cannot serve this run's manifest, so the run " +
    'stalls before TEST_START. Probe with "lsof -nP -iTCP:8888": any listener that is not ' +
    "this run's own is the cause. FireForge now refuses this at preflight, so it should " +
    'reach a stall only on a host where the port could not be probed.',
];

/**
 * Optional hint appended to the harness-crash message when a HEADED run on
 * macOS died at the no-output timeout.
 *
 * When `displayState` names a MEASURED display state, the hint states it as
 * fact rather than as one of three possibilities — that is the point of
 * probing: an operator staring at a bare test failure should not have to
 * rediscover that their machine dimmed. `caffeinate` is described accurately
 * (it prevents sleep; it cannot wake an already-sleeping display), so
 * operators are not sent to a command that could not have helped them.
 *
 * Pure — the platform and the probed state are injected so unit tests need
 * no mocking.
 *
 * @param signature - The recognized crash shape
 * @param context - Run mode, platform, and the probed display state
 * @returns The hint text, or undefined when the shape does not apply
 */
export function headedNoOutputTimeoutHint(
  signature: HarnessCrashSignature,
  context: { headless: boolean; platform: string; displayState?: DisplaySleepState }
): string | undefined {
  if (context.platform !== 'darwin' || context.headless) return undefined;
  if (!signature.reason.includes('no-output timeout')) return undefined;

  const lead =
    context.displayState === 'asleep'
      ? 'Hint: this was a HEADED run on macOS and the display was MEASURED ASLEEP ' +
        '(IODisplayWrangler below its awake power state). A headed browser on a sleeping ' +
        'display never paints and never starts a test, so this stall is environmental — not a ' +
        'product or test failure.'
      : context.displayState === 'awake'
        ? 'Hint: this was a HEADED run on macOS that died at the no-output timeout. The display ' +
          'was measured AWAKE, so the sleeping-display cause below is ruled out for this run.'
        : 'Hint: this was a HEADED run on macOS that died at the no-output timeout. The display ' +
          'state could not be measured, so all three causes below remain open.';

  const remedy =
    'Note that `caffeinate -disu` PREVENTS sleep; it cannot WAKE a display that is already ' +
    'asleep. Wake the display (or run on an attended machine), or pass --headless.';

  return (
    `${lead}\n\n${NO_OUTPUT_STALL_CONTROL_STEP}\n\n` +
    `Known causes of this exact signature:\n${NO_OUTPUT_STALL_TRIAGE.join('\n')}\n\n${remedy}`
  );
}

/**
 * Verdict-line note for a headed no-output stall whose display was
 * measured asleep. Returned as the parenthetical the verdict line carries,
 * so the one greppable line an automated consumer reads already names the
 * environmental cause instead of a bare `FAIL reason=crash`.
 */
export function headedDisplayAsleepVerdictNote(
  signature: HarnessCrashSignature,
  context: { headless: boolean; platform: string; displayState: DisplaySleepState }
): string | undefined {
  if (context.platform !== 'darwin' || context.headless) return undefined;
  if (context.displayState !== 'asleep') return undefined;
  if (!signature.reason.includes('no-output timeout')) return undefined;
  return 'headed run stalled with the display asleep';
}
