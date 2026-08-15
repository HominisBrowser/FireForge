// SPDX-License-Identifier: EUPL-1.2
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
 * while the tests ran, and `lock-timeout` marks a run that never started
 * because the engine session lock stayed contended past the wait budget.
 */
export type FireforgeVerdictReason =
  'crash' | 'no-tests' | 'test-failures' | 'preflight' | 'inconclusive' | 'lock-timeout';

let emitted = false;

/**
 * Re-arms the verdict sink for a new run. Called at `testCommand` entry so
 * repeated programmatic invocations (and tests) each get their own
 * exactly-one-line guarantee.
 */
export function resetVerdictEmission(): void {
  emitted = false;
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
  process.stdout.write(`${line}\n`);
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
