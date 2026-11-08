// SPDX-License-Identifier: EUPL-1.2
/**
 * The completeness veto for `fireforge test`.
 *
 * The classifier rejects hard failures even when mach exits 0. This adds
 * requested-roster accounting for a downstream shape: the browser shut down
 * cleanly inside the 105th of 314 files ("Application shut down (without
 * crashing) in the middle of a test!"), nothing after it ran, mach still
 * exited 0, and the verdict read `PASS checks=7919 unexpected=1`.
 *
 * So a would-be pass is re-examined here against what the run recorded: a
 * non-zero unexpected count, the harness's mid-test shutdown line, and requested
 * test files that never produced a start marker. Any one of them turns the run
 * into `FAIL reason=test-failures`, and a short start count is stamped on the
 * verdict line as `started=<n>/<m> first-unstarted=<path>`.
 *
 * A raw log, when the run wrote one, decides: every requested file ended, no
 * test is unfinished, none reported an unexpected result, and each requested
 * directory ran something. It names every test by its manifest id, so a raw log
 * whose starts name none of the requested files ran something else.
 *
 * From streamed or captured text, a run whose start lines name other files
 * fails too. A run that prints no start line at all is not counted, since the
 * suite-specific xpcshell dispatch can prove execution with a result-summary
 * block alone and a run that never names its files cannot be counted against
 * them. Neither is one whose start lines share a basename with a request
 * without matching its path.
 */

import { type HarnessRunVerdict, SHUTDOWN_REENTRY_PATTERN } from './test-harness-crash.js';
import {
  parseSkipMarker,
  parseStartMarker,
  TEST_FILE_BASENAME_PATTERN,
} from './test-harness-markers.js';
import type { IncompleteRunEvidence, StartMarkers } from './test-harness-signature.js';
import type { RawTestLog } from './test-raw-log.js';

export type { StartMarkers } from './test-harness-signature.js';

/** Basename of a `/`-separated path. */
function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Collects the start and skip marker names in `output`, line by line. */
function scanStartMarkers(output: string): StartMarkers {
  const markers: StartMarkers = { started: [], skipped: [] };
  for (const line of output.split(/\r?\n/)) recordMarkerLine(line, markers);
  return markers;
}

function recordMarkerLine(line: string, markers: StartMarkers): void {
  const start = parseStartMarker(line)?.name;
  if (start !== undefined) {
    markers.started.push(start);
    return;
  }
  const skip = parseSkipMarker(line);
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

const normalizedTestPath = (path: string): string =>
  path.replace(/\\/g, '/').replace(/^engine\//, '');

/** A normalized marker or roster id and a normalized requested path name the same file. */
function namesSameFile(name: string, request: string): boolean {
  return name === request || name.endsWith(`/${request}`) || request.endsWith(`/${name}`);
}

/** A request with no countable test file in its own name: a directory or a manifest. */
function namesNoTestFile(path: string): boolean {
  return !TEST_FILE_BASENAME_PATTERN.test(basenameOf(normalizedTestPath(path)));
}

/**
 * The indexes of `requested` that some name in `list` names unambiguously: a
 * name that could be either of two requested files counts for neither.
 */
function namedIndexes(list: readonly string[], requested: readonly string[]): Set<number> {
  const named = new Set<number>();
  for (const name of list) {
    const normalized = normalizedTestPath(name);
    let only = -1;
    let count = 0;
    requested.forEach((request, index) => {
      if (namesSameFile(normalized, request)) {
        count += 1;
        only = index;
      }
    });
    if (count === 1) named.add(only);
  }
  return named;
}

/**
 * Counts the requested test files that produced a start or skip marker.
 * Returns undefined when nothing can be counted: no test-file-shaped
 * request, or no start line that names any requested file.
 *
 * @param evidence - Captured mach stdout and stderr, or the markers
 *   collected from the complete stream
 * @param requestedPaths - Dispatched paths, in dispatch order
 * @param authoritative - The markers come from the raw log, so a run whose
 *   starts name no requested file is counted (as none started) instead of
 *   being left uncounted
 * @param roster - The test ids the raw log's `suite_start` announced. When
 *   a request names a directory or manifest, its test files are counted
 *   from this, after the files requested by name
 */
export function countStartedFiles(
  evidence: string | StartMarkers,
  requestedPaths: readonly string[],
  authoritative = false,
  roster: readonly string[] = []
): { started: number; requested: number; firstUnstarted?: string } | undefined {
  const named = requestedPaths.filter((path) => !namesNoTestFile(path));
  const namedForms = named.map(normalizedTestPath);
  const requested = requestedPaths.some(namesNoTestFile)
    ? [
        ...named,
        ...roster.filter((id) => {
          const normalized = normalizedTestPath(id);
          return (
            TEST_FILE_BASENAME_PATTERN.test(basenameOf(normalized)) &&
            !namedForms.some((request) => namesSameFile(normalized, request))
          );
        }),
      ]
    : named;
  if (requested.length === 0) return undefined;
  const { started, skipped } = typeof evidence === 'string' ? scanStartMarkers(evidence) : evidence;
  const forms = requested.map(normalizedTestPath);
  const startedIndexes = namedIndexes(started, forms);
  // Counting needs a dialect that names the requested files on its start
  // lines. When no start line names any of them, the output cannot be
  // counted against the request at all, unless it is the raw log.
  if (!authoritative && startedIndexes.size === 0) return undefined;
  const skippedIndexes = namedIndexes(skipped, forms);
  const unstarted = requested.filter(
    (_path, index) => !startedIndexes.has(index) && !skippedIndexes.has(index)
  );
  const firstUnstarted = unstarted[0];
  return {
    started: requested.length - unstarted.length,
    requested: requested.length,
    ...(firstUnstarted !== undefined ? { firstUnstarted } : {}),
  };
}

/**
 * Text whose start lines are about other files altogether: test files, none sharing
 * a basename with any request. A path that differs only in its prefix stays uncounted.
 */
function namesOnlyOtherFiles(markers: StartMarkers, requestedPaths: readonly string[]): boolean {
  const requested = new Set(requestedPaths.map(basenameOf));
  const files = markers.started.filter((name) => TEST_FILE_BASENAME_PATTERN.test(basenameOf(name)));
  return files.length > 0 && !files.some((name) => requested.has(basenameOf(name)));
}

/** Requested directories and manifests a raw log ran nothing under, in request order. */
function directoriesWithoutResults(
  requestedPaths: readonly string[],
  tests: readonly string[]
): string[] {
  return requestedPaths.filter((path) => {
    const normalized = path.replace(/\\/g, '/').replace(/^engine\//, '');
    if (!normalized.includes('/') || TEST_FILE_BASENAME_PATTERN.test(basenameOf(normalized)))
      return false;
    const dir = /\.(?:toml|ini|list)$/.test(normalized)
      ? normalized.slice(0, normalized.lastIndexOf('/'))
      : normalized.replace(/\/+$/, '');
    return !tests.some((test) => {
      const id = test.replace(/\\/g, '/');
      return id.startsWith(`${dir}/`) || id.includes(`/${dir}/`);
    });
  });
}

/**
 * Re-examines a passing verdict and fails it when the run is incomplete or
 * reported unexpected results. Any other verdict is returned unchanged, apart
 * from the evidence it can carry.
 *
 * @param verdict - The classifier's verdict
 * @param output - Captured mach stdout and stderr
 * @param requestedPaths - Dispatched paths, in dispatch order
 * @param tracked - Start markers collected from the complete stream (or
 *   the structured raw log); without them the capped capture is scanned
 * @param raw - The dispatch's raw log, when it wrote one
 */
export function vetoIncompletePass(
  verdict: HarnessRunVerdict,
  output: string,
  requestedPaths: readonly string[],
  tracked?: TrackedStartMarkers,
  raw?: RawTestLog
): HarnessRunVerdict {
  const passed = verdict.kind === 'tests-ran-ok';
  const evidence = gatherEvidence(verdict, output, requestedPaths, tracked, raw);
  const stopped =
    evidence.firstUnstarted !== undefined ||
    evidence.shutdownLine !== undefined ||
    evidence.appExit !== undefined;
  if (!stopped && (!passed || (evidence.unexpected === undefined && !evidence.unfinished))) {
    // A raw log that recorded no test at all is a run that did nothing.
    return passed && raw?.results.length === 0
      ? { kind: 'no-tests', ...countsOf(verdict) }
      : verdict;
  }
  // The pass-only annotations would misdescribe a failed run: "harness
  // teardown noise ignored" and the green-summary override both say the
  // run was trusted.
  const rest: HarnessRunVerdict = { ...verdict };
  if (!passed) return { ...rest, incomplete: evidence };
  delete rest.greenSummaryOverride;
  delete rest.note;
  const unexpected = evidence.unexpected ?? 0;
  return {
    ...rest,
    kind: 'test-failures',
    incomplete: evidence,
    ...(unexpected > (rest.unexpected ?? 0) ? { unexpected } : {}),
    ...(evidence.shutdownLine !== undefined ? { realFailureLine: evidence.shutdownLine } : {}),
  };
}

/** What the output and the raw log say about a run's completeness. */
function gatherEvidence(
  verdict: HarnessRunVerdict,
  output: string,
  requestedPaths: readonly string[],
  tracked: TrackedStartMarkers | undefined,
  raw: RawTestLog | undefined
): IncompleteRunEvidence {
  const appExit = /Main app process: killed by (SIG[A-Z0-9]+)/.exec(output)?.[1];
  const shutdownLine = output
    .split(/\r?\n/)
    .find((line) => SHUTDOWN_REENTRY_PATTERN.test(line))
    ?.trim();
  // A raw log is complete whatever the capture kept. Otherwise tracked markers
  // win whenever they saw a start line at all: an empty tracker means nothing
  // was streamed through it, and the capture is then the only evidence there is.
  const chosen: TrackedStartMarkers | undefined =
    raw !== undefined
      ? { markers: raw.markers, source: 'raw' }
      : tracked !== undefined && tracked.markers.started.length > 0
        ? tracked
        : undefined;
  const counted = countStartedFiles(
    chosen?.markers ?? output,
    requestedPaths,
    chosen !== undefined &&
      (chosen.source === 'raw' ||
        (verdict.kind === 'tests-ran-ok' && namesOnlyOtherFiles(chosen.markers, requestedPaths))),
    raw?.roster
  );
  const firstUnstarted =
    counted?.firstUnstarted ??
    (raw === undefined
      ? undefined
      : directoriesWithoutResults(
          requestedPaths,
          raw.results.map((result) => result.test)
        )[0]);
  const unexpected = Math.max(
    verdict.unexpected ?? 0,
    raw?.results.filter((result) => result.unexpected).length ?? 0
  );
  return {
    started: counted?.started ?? 0,
    requested: counted?.requested ?? 0,
    ...(firstUnstarted !== undefined
      ? { firstUnstarted, startedSource: chosen?.source ?? 'capture' }
      : {}),
    ...(shutdownLine !== undefined ? { shutdownLine } : {}),
    ...(unexpected > 0 ? { unexpected } : {}),
    ...(raw !== undefined && raw.unfinished.length > 0 ? { unfinished: raw.unfinished } : {}),
    ...(appExit === undefined ? {} : { appExit }),
  };
}

function countsOf(verdict: HarnessRunVerdict): Pick<HarnessRunVerdict, 'checks' | 'unexpected'> {
  return {
    ...(verdict.checks === undefined ? {} : { checks: verdict.checks }),
    ...(verdict.unexpected === undefined ? {} : { unexpected: verdict.unexpected }),
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
      evidence.requested > 0 && evidence.started < evidence.requested
        ? `  - only ${evidence.started} of ${evidence.requested} requested test files started; ` +
            `the first that never started is ${evidence.firstUnstarted}`
        : `  - the raw log has no test under the requested ${evidence.firstUnstarted}`
    );
  }
  if (evidence.unfinished !== undefined) {
    lines.push(
      `  - ${evidence.unfinished.length} test file(s) started and never finished: ${evidence.unfinished.join(', ')}`
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
    'FireForge did NOT treat this incomplete harness run as passed:\n\n' +
    `${lines.join('\n')}\n\n` +
    'A browser that quits mid-suite can leave a summary that covers only the ' +
    `files that ran. ${rerun}`
  );
}
