// SPDX-License-Identifier: EUPL-1.2
import { getActiveRunLogPath } from '../core/run-log.js';
import type { HarnessRunVerdict } from '../core/test-harness-crash.js';
import { formatFireforgeVerdictLine } from '../core/test-harness-crash.js';
import { setStdoutSealed } from '../utils/logger.js';

/**
 * Reason codes the emission layer can put on a `FIREFORGE-VERDICT: FAIL`
 * line. The first three mirror the harness classifier, as does
 * `server-startup`: a harness-crash-class infrastructure failure where a
 * mochitest server never came up, so no test ran. `preflight` covers
 * every failure before harness classification (missing/stale builds,
 * invalid paths, port conflicts, config errors, spawn failures),
 * `inconclusive` marks a run whose harness result exists but cannot be
 * trusted because `engine/` changed (or became unprobeable one-sidedly)
 * while the tests ran, `lock-timeout` marks a run that never started
 * because the engine session lock stayed contended past the wait budget,
 * and `killed` marks a run terminated by a signal before it could reach any
 * of the others.
 */
export type FireforgeVerdictReason =
  | 'crash'
  | 'harness-arguments'
  | 'no-tests'
  | 'test-failures'
  | 'server-startup'
  | 'preflight'
  | 'inconclusive'
  | 'lock-timeout'
  | 'killed';

let emitted = false;

/**
 * Additive `key=value` attributes of the run in flight, appended to
 * whichever verdict line ends it. `shuffle` is the seed a `--shuffle` run
 * exported to the harness, so a red found by shuffling carries its own
 * reproduction on the one line an unattended reader keeps. `orphans-reaped`
 * is how many harness processes FireForge had to terminate itself, at
 * preflight (survivors of an earlier run) or at teardown (helpers this run
 * launched that outlived mach): a green after a reap is not the same
 * finding as a green on a quiet machine. Cleared by
 * {@link resetVerdictEmission}, so a later run in the same process cannot
 * inherit them.
 */
const runAttributes = new Map<VerdictRunAttributeKey, string>();

/** Additive keys a run can stamp on its verdict line. */
export type VerdictRunAttributeKey =
  | 'shuffle'
  | 'orphans-reaped'
  | 'host-load'
  | 'host-cpu-warning'
  | 'power-source'
  | 'power-changed'
  | 'furnace-applied'
  | 'furnace-apply'
  | 'furnace-skipped'
  | 'control-build'
  | 'control-restore-build'
  | 'build-id'
  | 'drift-tolerated'
  | 'lock'
  | 'jobs'
  | 'upload-dirs'
  | 'results'
  | 'build-paths';

/** Records an additive attribute for this run's verdict line. */
export function setVerdictRunAttribute(key: VerdictRunAttributeKey, value: string): void {
  runAttributes.set(key, value);
}

/**
 * A comma-separated path list for a verdict attribute that a script feeds
 * back to FireForge (`build-paths=`). The line is tokenised on whitespace
 * and the list split on commas, so `%`, `,` and whitespace inside a path
 * are percent-encoded (`decodeURIComponent` restores each entry); any other
 * path is written verbatim.
 *
 * @param paths - Engine-relative paths, forward slashes
 */
export function formatVerdictPathList(paths: readonly string[]): string {
  return paths
    .map((path) => path.replace(/[%,\s]/gu, (char) => encodeURIComponent(char)))
    .join(',');
}

/**
 * Adds to a counting attribute. The key appears only once the total is
 * positive, so a run that reaped nothing prints the line it always did.
 * Sums across the preflight census, every retry attempt and every shard.
 */
export function addVerdictRunCount(key: 'orphans-reaped', count: number): void {
  // Written as a negated `> 0` so a NaN (a stubbed census, a bad parse) is
  // dropped rather than stamped on the line as `orphans-reaped=NaN`.
  if (!(count > 0)) return;
  const current = Number(runAttributes.get(key) ?? '0');
  runAttributes.set(key, String(current + count));
}

/**
 * True once a test run has begun in this process.
 *
 * The signal path needs it: a `FIREFORGE-VERDICT` line claims a test run
 * happened, and a Ctrl+C during `fireforge status` must not print one. Set
 * by {@link resetVerdictEmission}, which `testCommand` already calls at
 * entry, so nothing else has to remember to arm it.
 */
let armed = false;

/**
 * Re-arms the verdict sink for a new run. Called at `testCommand` entry so
 * repeated programmatic invocations (and tests) each get their own
 * exactly-one-line guarantee.
 */
export function resetVerdictEmission(): void {
  emitted = false;
  armed = true;
  runAttributes.clear();
  capture = undefined;
  setStdoutSealed(false);
}

/**
 * The sub-run capture slot of a multi-run invocation (`--repeat`, mixed
 * harnesses, `--negative-control`; see `test-orchestrate.ts`). While one is
 * installed, a sub-run's verdict line is recorded here, first write wins as
 * on stdout, and nothing is printed or sealed, so the invocation can still
 * end with its own single aggregate line.
 */
let capture: { line?: string } | undefined;

/** True once this run has written its `FIREFORGE-VERDICT:` line. */
export function verdictEmitted(): boolean {
  return capture === undefined ? emitted : capture.line !== undefined;
}

/** Installs (or, with `undefined`, removes) the sub-run capture slot. */
export function setVerdictCapture(slot: { line?: string } | undefined): void {
  capture = slot;
}

/**
 * Emits a multi-run aggregate verdict. `body` is everything after the
 * `FIREFORGE-VERDICT: ` prefix.
 */
export function emitAggregateVerdict(body: string): void {
  writeVerdictLine(`FIREFORGE-VERDICT: ${body}`);
}

/**
 * Writes the run's single verdict line to raw stdout (clack's renderer can
 * drop output under non-TTY capture). First write wins. Every later call
 * is a no-op: the writer closest to the harness result runs first, so the
 * fallback layers (the engine-generation guard, the preflight wrapper)
 * can emit unconditionally without risking a second line. Writing also
 * seals stdout: the verdict must stay the run's last stdout write, so all
 * subsequent logger output, including the CLI-boundary error/cancel
 * rendering after an emit-then-throw path, routes to stderr.
 */
function writeVerdictLine(line: string): void {
  if (capture !== undefined) {
    capture.line ??= line;
    return;
  }
  if (emitted) return;
  emitted = true;
  // The run log's path rides the verdict line because the verdict must stay
  // the run's last stdout write: a separate announcement after it would
  // break that contract, and one before it is the first thing a `tail` cuts.
  // Appended as an additive `key=value`, so consumers that tokenize the line
  // are unaffected and a truncated tail still says where the full output is.
  const attributes = [...runAttributes].map(([key, value]) => ` ${key}=${value}`).join('');
  const logPath = getActiveRunLogPath();
  const suffix = logPath === undefined ? '' : ` log=${logPath}`;
  process.stdout.write(`${line}${attributes}${suffix}\n`);
  setStdoutSealed(true);
}

/**
 * Emits the classifier-derived verdict for a completed harness run, with
 * the aggregate `shards=<passed>/<total>` suffix for sharded runs.
 */
export function emitHarnessVerdict(
  verdict: HarnessRunVerdict,
  shards?: { passed: number; total: number; failed?: readonly string[] }
): void {
  writeVerdictLine(formatFireforgeVerdictLine(verdict, shards));
}

/** Emits the pathless `--doctor` PASS verdict. */
export function emitPassVerdict(): void {
  writeVerdictLine('FIREFORGE-VERDICT: PASS');
}

/**
 * Emits a FAIL verdict carrying an emission-layer reason code, and
 * optionally the refusal class that produced it.
 *
 * `note=` is additive, like the `log=`, `signal=`, `shards=` and `shuffle=` keys already
 * on this line: `reason=` is unchanged and still comes from the closed set
 * in `docs/machine-output.md`, so a consumer that tokenises `key=value`
 * pairs is unaffected. It exists because `reason=preflight` covers every
 * gate before the harness (a missing build, a peer's packaging record, a
 * developer browser holding the objdir), and an unattended reader whose
 * pipe kept only the verdict line could not tell those apart.
 *
 * @param reason - Closed-set verdict reason
 * @param note - Stable refusal class, when the thrower named one
 */
export function emitFailVerdict(reason: FireforgeVerdictReason, note?: string): void {
  const suffix = note === undefined ? '' : ` note=${note}`;
  writeVerdictLine(`FIREFORGE-VERDICT: FAIL reason=${reason}${suffix}`);
}

/**
 * What ended a killed run: a signal FireForge received, or `parent-exit`,
 * the parent-death watchdog's finding that the process above FireForge
 * vanished (typically SIGKILLed by a supervisor) while a harness ran.
 */
export type KilledVerdictCause = NodeJS.Signals | 'parent-exit';

/**
 * Emits the terminal verdict for a run killed by a signal, or ended by
 * FireForge itself because its parent died.
 *
 * Without it a killed run wrote no terminal line, so a log tail could not
 * distinguish "killed" from "still running" from "never started". Recovery
 * meant checking `ps` and the lock file by hand, at the exact moment (a
 * mass kill under a usage limit, mid-drain) when the tree's state most
 * needs to be readable. A no-op unless a run was actually in flight: the
 * line asserts a test run happened, and an interrupted `status` did not
 * have one.
 *
 * @param signal - The signal that terminated the run, or `parent-exit`
 * @returns True when a line was written
 */
export function emitKilledVerdict(signal: KilledVerdictCause): boolean {
  if (!armed || emitted) return false;
  // A kill ends the whole invocation, so a sub-run capture must not
  // swallow the one line that says so.
  capture = undefined;
  writeVerdictLine(`FIREFORGE-VERDICT: FAIL reason=killed signal=${signal}`);
  return true;
}
