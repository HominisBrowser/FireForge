// SPDX-License-Identifier: EUPL-1.2
/**
 * The exit-0 completeness veto for `fireforge test`.
 *
 * `classifyHarnessRun` trusts a mach exit code of 0 once any test started.
 * That is wrong for one shape a downstream fork hit: the browser shut down
 * cleanly inside the 105th of 314 files ("Application shut down (without
 * crashing) in the middle of a test!"), nothing after it ran, mach still
 * exited 0, and the verdict read `PASS checks=7919 unexpected=1`. The
 * truncation checks the classifier already applies to a non-zero exit with
 * a green-looking summary never ran, because the exit code short-circuited
 * them.
 *
 * So a would-be pass is re-examined here against three facts the captured
 * output carries: a non-zero `Unexpected results:` count, the harness's
 * mid-test shutdown line, and requested test files that never produced a
 * start marker. Any one of them turns the run into
 * `FAIL reason=test-failures`, and a short start count is stamped on the
 * verdict line as `started=<n>/<m> first-unstarted=<path>`.
 *
 * The start-count check only runs when at least one start marker names a
 * requested file. The suite-specific xpcshell dispatch can prove execution
 * with a result-summary block alone and print no `TEST_START` line, and a
 * run that never names its files cannot be counted against them.
 */

import {
  type HarnessRunVerdict,
  SHUTDOWN_REENTRY_PATTERN,
  START_MARKER_PATTERN,
  TEST_FILE_BASENAME_PATTERN,
} from './test-harness-crash.js';
import type { IncompleteRunEvidence } from './test-harness-signature.js';

/**
 * A skip marker naming a test (`TEST-SKIP | path`, `TEST_SKIP: path`). A
 * manifest-skipped file is accounted for, not missing.
 */
const SKIP_MARKER_PATTERN = /\bTEST[-_]SKIP(?:PED)?\b[:| ]*\s*(\S+)?/;

/** Basename of a `/`-separated path. */
function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Start and skip marker names seen in a run's output. */
export interface StartMarkers {
  started: string[];
  skipped: string[];
}

/** Collects the start and skip marker names in `output`, line by line. */
function scanStartMarkers(output: string): StartMarkers {
  const markers: StartMarkers = { started: [], skipped: [] };
  for (const line of output.split(/\r?\n/)) recordMarkerLine(line, markers);
  return markers;
}

function recordMarkerLine(line: string, markers: StartMarkers): void {
  const start = START_MARKER_PATTERN.exec(line)?.[1];
  if (start !== undefined) {
    markers.started.push(start);
    return;
  }
  const skip = SKIP_MARKER_PATTERN.exec(line)?.[1];
  if (skip !== undefined) markers.skipped.push(skip);
}

/**
 * Collects start and skip markers from a dispatch's output as it streams.
 *
 * The capture `runMachCapture` hands back keeps only the last 2 MB of each
 * stream, so a suite that prints more than that (a large browser directory,
 * or any run under `--full-output`) loses its first files' start lines from
 * the capture, and counting from that tail named files that ran and passed
 * as never started. The tracker sees every chunk, splits it into whole lines
 * per stream, and keeps only the marker names, so it grows with the file
 * count, not the output size.
 */
export interface StartMarkerTracker {
  /** Feeds one output chunk; wire it to `MachOptions.onOutputChunk`. */
  onChunk(stream: 'stdout' | 'stderr', chunk: string): void;
  /** The markers seen so far, including any unterminated last line. */
  markers(): StartMarkers;
}

/** Markers collected outside the capped capture, and where they came from. */
export interface TrackedStartMarkers {
  markers: StartMarkers;
  /** `stream`: every output chunk; `raw`: the mozlog structured log. */
  source: 'stream' | 'raw';
}

/** Creates a {@link StartMarkerTracker}. */
export function createStartMarkerTracker(): StartMarkerTracker {
  const collected: StartMarkers = { started: [], skipped: [] };
  const pending = { stdout: '', stderr: '' };
  return {
    onChunk(stream, chunk) {
      const lines = `${pending[stream]}${chunk}`.split(/\r?\n/);
      pending[stream] = lines.pop() ?? '';
      for (const line of lines) recordMarkerLine(line, collected);
    },
    markers() {
      const tail: StartMarkers = { started: [], skipped: [] };
      recordMarkerLine(pending.stdout, tail);
      recordMarkerLine(pending.stderr, tail);
      return {
        started: [...collected.started, ...tail.started],
        skipped: [...collected.skipped, ...tail.skipped],
      };
    },
  };
}

/**
 * Counts the requested test files that produced a start or skip marker.
 * Returns undefined when nothing can be counted: no test-file-shaped
 * request, or no start line that names any requested file.
 *
 * @param evidence - Captured mach stdout and stderr, or the markers
 *   collected from the complete stream
 * @param requestedPaths - Dispatched paths, in dispatch order
 */
export function countStartedFiles(
  evidence: string | StartMarkers,
  requestedPaths: readonly string[]
): { started: number; requested: number; firstUnstarted?: string } | undefined {
  const requested = requestedPaths.filter((path) =>
    TEST_FILE_BASENAME_PATTERN.test(basenameOf(path))
  );
  if (requested.length === 0) return undefined;
  const { started, skipped } = typeof evidence === 'string' ? scanStartMarkers(evidence) : evidence;
  const names = (path: string, list: readonly string[]): boolean => {
    const base = basenameOf(path);
    return list.some((name) => name.includes(base));
  };
  // Counting needs a dialect that names the requested files on its start
  // lines. When no start line names any of them, the output cannot be
  // counted against the request at all.
  if (!requested.some((path) => names(path, started))) return undefined;
  const unstarted = requested.filter((path) => !names(path, started) && !names(path, skipped));
  const firstUnstarted = unstarted[0];
  return {
    started: requested.length - unstarted.length,
    requested: requested.length,
    ...(firstUnstarted !== undefined ? { firstUnstarted } : {}),
  };
}

/**
 * Re-examines a passing verdict for a mach exit-0 run and fails it when
 * the run is incomplete or reported unexpected results. Any other verdict
 * is returned unchanged.
 *
 * @param verdict - The classifier's verdict
 * @param output - Captured mach stdout and stderr
 * @param requestedPaths - Dispatched paths, in dispatch order
 * @param tracked - Start markers collected from the complete stream (or
 *   the structured raw log); without them the capped capture is scanned
 */
export function vetoIncompletePass(
  verdict: HarnessRunVerdict,
  output: string,
  requestedPaths: readonly string[],
  tracked?: TrackedStartMarkers
): HarnessRunVerdict {
  if (verdict.kind !== 'tests-ran-ok') return verdict;
  const shutdownLine = output
    .split(/\r?\n/)
    .find((line) => SHUTDOWN_REENTRY_PATTERN.test(line))
    ?.trim();
  // Tracked markers win whenever they saw a start line at all. An empty
  // tracker means nothing was streamed through it, and the capture is then
  // the only evidence there is.
  const useTracked = tracked !== undefined && tracked.markers.started.length > 0;
  const counted = countStartedFiles(useTracked ? tracked.markers : output, requestedPaths);
  const unexpected = verdict.unexpected ?? 0;
  const truncated = counted?.firstUnstarted !== undefined;
  if (unexpected === 0 && shutdownLine === undefined && !truncated) return verdict;

  const evidence: IncompleteRunEvidence = {
    started: counted?.started ?? 0,
    requested: counted?.requested ?? 0,
    ...(counted?.firstUnstarted !== undefined
      ? {
          firstUnstarted: counted.firstUnstarted,
          startedSource: useTracked ? tracked.source : 'capture',
        }
      : {}),
    ...(shutdownLine !== undefined ? { shutdownLine } : {}),
    ...(unexpected > 0 ? { unexpected } : {}),
  };
  // The pass-only annotations would misdescribe a failed run: "harness
  // teardown noise ignored" and the green-summary override both say the
  // run was trusted.
  const rest: HarnessRunVerdict = { ...verdict };
  delete rest.greenSummaryOverride;
  delete rest.note;
  return {
    ...rest,
    kind: 'test-failures',
    incomplete: evidence,
    ...(shutdownLine !== undefined ? { realFailureLine: shutdownLine } : {}),
  };
}

/**
 * Operator-facing explanation for a pass {@link vetoIncompletePass}
 * refused. Names the first file that never started, because that is
 * where a re-run has to pick up.
 *
 * @param evidence - The veto's evidence
 */
export function buildIncompleteRunMessage(evidence: IncompleteRunEvidence): string {
  const lines: string[] = [];
  if (evidence.firstUnstarted !== undefined) {
    lines.push(
      `  - only ${evidence.started} of ${evidence.requested} requested test files started; ` +
        `the first that never started is ${evidence.firstUnstarted}`
    );
  }
  if (evidence.shutdownLine !== undefined) {
    lines.push(`  - the browser shut down in the middle of a test: ${evidence.shutdownLine}`);
  }
  if (evidence.unexpected !== undefined) {
    lines.push(`  - the suite summary reported ${evidence.unexpected} unexpected result(s)`);
  }
  const rerun =
    evidence.firstUnstarted !== undefined
      ? `Re-run from ${evidence.firstUnstarted} onward, or the whole selection once the engine is quiet.`
      : 'Read the unexpected results in the output above.';
  return (
    'mach exited 0, but FireForge did NOT treat the run as passed:\n\n' +
    `${lines.join('\n')}\n\n` +
    'A browser that quits cleanly mid-suite exits 0, and its summary then covers only the ' +
    `files that ran. ${rerun}`
  );
}
