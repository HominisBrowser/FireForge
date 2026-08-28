// SPDX-License-Identifier: EUPL-1.2
import { getActiveRunLogPath } from '../core/run-log.js';
import type { HarnessRunVerdict } from '../core/test-harness-crash.js';
import { formatFireforgeVerdictLine } from '../core/test-harness-crash.js';
import { setStdoutSealed } from '../utils/logger.js';

/**
 * Reason codes the emission layer can put on a `FIREFORGE-VERDICT: FAIL`
 * line. The first three mirror the harness classifier; `preflight` covers
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
  'crash' | 'no-tests' | 'test-failures' | 'preflight' | 'inconclusive' | 'lock-timeout' | 'killed';

let emitted = false;

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
  setStdoutSealed(false);
}

/** True once this run has written its `FIREFORGE-VERDICT:` line. */
export function verdictEmitted(): boolean {
  return emitted;
}

/**
 * Writes the run's single verdict line — raw stdout (clack's renderer can
 * drop output under non-TTY capture), first write wins. Every later call
 * is a no-op: the writer closest to the harness result runs first, so the
 * fallback layers (the engine-generation guard, the preflight wrapper)
 * can emit unconditionally without risking a second line. Writing also
 * seals stdout: the verdict must stay the run's LAST stdout write, so all
 * subsequent logger output — including the CLI-boundary error/cancel
 * rendering after an emit-then-throw path — routes to stderr.
 */
function writeVerdictLine(line: string): void {
  if (emitted) return;
  emitted = true;
  // The run log's path rides the verdict line because the verdict must stay
  // the run's LAST stdout write — a separate announcement after it would
  // break that contract, and one before it is the first thing a `tail` cuts.
  // Appended as an additive `key=value`, so consumers that tokenize the line
  // are unaffected and a truncated tail still says where the full output is.
  const logPath = getActiveRunLogPath();
  const suffix = logPath === undefined ? '' : ` log=${logPath}`;
  process.stdout.write(`${line}${suffix}\n`);
  setStdoutSealed(true);
}

/**
 * Emits the classifier-derived verdict for a completed harness run, with
 * the aggregate `shards=<passed>/<total>` suffix for sharded runs.
 */
export function emitHarnessVerdict(
  verdict: HarnessRunVerdict,
  shards?: { passed: number; total: number }
): void {
  writeVerdictLine(formatFireforgeVerdictLine(verdict, shards));
}

/** Emits the pathless `--doctor` PASS verdict. */
export function emitPassVerdict(): void {
  writeVerdictLine('FIREFORGE-VERDICT: PASS');
}

/** Emits a FAIL verdict carrying an emission-layer reason code. */
export function emitFailVerdict(reason: FireforgeVerdictReason): void {
  writeVerdictLine(`FIREFORGE-VERDICT: FAIL reason=${reason}`);
}

/**
 * Emits the terminal verdict for a run killed by a signal.
 *
 * Without it a killed run wrote NO terminal line, so a log tail could not
 * distinguish "killed" from "still running" from "never started" — recovery
 * meant checking `ps` and the lock file by hand, at the exact moment (a
 * mass kill under a usage limit, mid-drain) when the tree's state most
 * needs to be readable. A no-op unless a run was actually in flight: the
 * line asserts a test run happened, and an interrupted `status` did not
 * have one.
 *
 * @param signal - The signal that terminated the run
 * @returns True when a line was written
 */
export function emitKilledVerdict(signal: NodeJS.Signals): boolean {
  if (!armed || emitted) return false;
  writeVerdictLine(`FIREFORGE-VERDICT: FAIL reason=killed signal=${signal}`);
  return true;
}
