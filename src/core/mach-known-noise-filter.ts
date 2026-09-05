// SPDX-License-Identifier: EUPL-1.2
/**
 * Terminal-echo filter for the known upstream mozsystemmonitor teardown
 * traceback.
 *
 * Headless test runs against recent engines can end with an
 * `AttributeError: 'SystemResourceMonitor' object has no attribute
 * 'stop_time'` traceback at harness teardown. That is upstream noise, and
 * it sits exactly where a reader looks for the failure summary. Real failure
 * lines already beat this traceback in classification. This filter closes
 * the presentation gap by collapsing the echoed traceback to one labeled
 * line.
 *
 * Scope is narrow on purpose:
 *   - Only the terminal echo is filtered. The captured stdout/stderr strings
 *     stay raw, because the classifier (`test-harness-crash.ts`) depends on
 *     the raw traceback for its green-summary override and secondary-noise
 *     detection.
 *   - Only the exact documented incident is collapsed, and every condition
 *     must hold: an `AttributeError` on `SystemResourceMonitor` naming one
 *     of the two known attributes (`stop_time`, `poll_interval`), and a
 *     `mozsystemmonitor/resourcemonitor.py` stack frame, and a
 *     previously-seen SUITE_END shutdown marker (shared across the run's
 *     stdout/stderr filter instances, where the marker usually lands on
 *     stdout while the traceback lands on stderr). A novel attribute, a novel
 *     exception type in resourcemonitor.py, or a pre-shutdown occurrence is
 *     echoed verbatim, always.
 *   - The hold buffer is bounded. On overflow the block is flushed verbatim
 *     and the filter returns to pass-through, so output is never lost.
 *
 * The collapse is test-only on purpose, not an oversight. Two reasons,
 * since from outside they read like one:
 *   1. Recognition requires a previously-seen SUITE_END shutdown marker, and
 *      `mach build` never prints one. Wiring the option into the build
 *      dispatch would therefore be a silent no-op.
 *   2. Relaxing that gate for builds would be wrong on its own terms. The
 *      marker is what separates teardown noise from a traceback raised while
 *      work was still happening. A build has no equivalent boundary, so
 *      FireForge cannot tell the known-cosmetic case from a real build-time
 *      failure and must not withhold the block.
 * The build path instead recognizes the signature and says so beside the
 * verbatim traceback. See {@link KNOWN_TEARDOWN_NOISE_BUILD_NOTE} and
 * `runProtectedMachBuild`.
 */

const TRACEBACK_HEADER_PATTERN = /^Traceback \(most recent call last\)/;
const CHAINED_EXCEPTION_CONNECTOR_PATTERN =
  /^(?:During handling of the above exception, another exception occurred:|The above exception was the direct cause of the following exception:)\s*$/;

/**
 * Closed allowlist of the documented teardown family's attributes:
 * `stop_time` and `poll_interval` (the same mozsystemmonitor init failure
 * `test-harness-crash.ts` already classifies as recognized noise). Any other
 * missing attribute is a new upstream defect and must print verbatim.
 */
const KNOWN_TEARDOWN_ATTRIBUTE_ERROR_PATTERN =
  /AttributeError: 'SystemResourceMonitor' object has no attribute '(?:stop_time|poll_interval)'/;
const RESOURCEMONITOR_FRAME_PATTERN = /mozsystemmonitor[/\\]resourcemonitor\.py/;

/**
 * Shutdown marker: the harness's SUITE_END line. Matches the shape
 * `test-harness-crash.ts` keys its summary parsing on (module-private
 * there, and duplicated here with this cross-reference rather than
 * exported).
 */
const SHUTDOWN_MARKER_PATTERN = /\bSUITE_END\b/;

/**
 * Whole-block recognition. Every signal must hold (see module doc). True
 * when captured output carries the documented mozsystemmonitor teardown
 * traceback.
 *
 * The echo filter below only affects what a human sees. The classifier
 * reads the raw capture, and it needs the same recognition to tell "the
 * suite finished clean and then upstream fell over at shutdown" from "the
 * suite did not finish". This is the same two-signal test the echo filter
 * applies: a novel attribute or a traceback from anywhere but
 * `resourcemonitor.py` is not this incident and must keep failing the run.
 *
 * The shutdown-marker precondition the echo filter adds is intentionally
 * omitted: at the classification layer the case that matters is exactly
 * the one where the teardown crash prevented the shutdown marker from
 * printing.
 *
 * Pure. Exported for the classifier and for direct unit testing.
 *
 * @param output - Raw captured stdout/stderr
 * @returns True when the recognized teardown traceback is present
 */
export function hasKnownTeardownNoise(output: string): boolean {
  return (
    KNOWN_TEARDOWN_ATTRIBUTE_ERROR_PATTERN.test(output) &&
    RESOURCEMONITOR_FRAME_PATTERN.test(output)
  );
}

/**
 * True when a single line is the documented teardown family's
 * `AttributeError`.
 *
 * The line-level half of {@link hasKnownTeardownNoise}: the traceback frame
 * lives on a neighbouring line, so a per-line test cannot apply the
 * two-signal rule by itself. Callers pair this with
 * `hasKnownTeardownNoise(wholeOutput)` to recover the full recognition
 * ("this capture carries the incident, and this line is its header"), which
 * keeps the closed attribute allowlist (`stop_time`/`poll_interval`) doing
 * the same work it does everywhere else. A novel attribute is not this
 * incident and must stay a candidate failure.
 *
 * @param line - A single output line
 * @returns True when the line is the recognized teardown AttributeError
 */
export function isKnownTeardownNoiseLine(line: string): boolean {
  return KNOWN_TEARDOWN_ATTRIBUTE_ERROR_PATTERN.test(line);
}

/**
 * Shared across the stdout and stderr filter instances of one mach run:
 * SUITE_END typically arrives on stdout while the teardown traceback lands
 * on stderr, so the shutdown-seen flag must be visible to both. The two
 * pipes are independent, so a traceback can theoretically beat the marker
 * through. The block then prints verbatim, which is the correct failure
 * direction.
 */
export interface TeardownNoiseContext {
  shutdownSeen: boolean;
}

/** Fresh per-run context. Hand the same instance to both stream filters. */
export function createTeardownNoiseContext(): TeardownNoiseContext {
  return { shutdownSeen: false };
}

/**
 * Build-phase note for the same recognized signature. The build path does
 * not collapse the traceback (see the module doc's "test-only" note). It
 * prints verbatim and this line is added beside it, so one signature reads
 * the same in both phases without a build losing output it may need.
 */
export const KNOWN_TEARDOWN_NOISE_BUILD_NOTE =
  '[FireForge] The mozsystemmonitor traceback above is the known upstream ' +
  'SystemResourceMonitor AttributeError — cosmetic, and not a build failure. It is left ' +
  'verbatim here (unlike a test run, which collapses it); see docs/testing.md.';

/** One line replaces the whole recognized traceback block in the echo. */
export const KNOWN_TEARDOWN_NOISE_ANNOTATION =
  '[FireForge] Known upstream mozsystemmonitor teardown noise (SystemResourceMonitor ' +
  'AttributeError at harness shutdown) — not a test failure. See docs/testing.md.\n';

/** Bounds on the held traceback block before flushing verbatim. */
const HOLD_LINE_LIMIT = 100;
const HOLD_BYTE_LIMIT = 16 * 1024;

/** Chunk-safe, line-buffered echo filter. See module doc. */
export interface KnownTeardownNoiseFilter {
  /** Feed a raw chunk. Returns the text to echo now (possibly empty). */
  transform(chunk: string): string;
  /** Flush any buffered residue verbatim (call after the stream closes). */
  flush(): string;
}

/**
 * Creates a stateful filter for one output stream. Complete lines outside a
 * traceback pass straight through (only the trailing partial line is held
 * back). A `Traceback (most recent call last)` header switches to hold mode
 * until the block ends, then either the one-line annotation (recognized
 * signature after a seen shutdown marker) or the verbatim block (anything
 * else) is emitted. Pass the run's shared {@link TeardownNoiseContext} so
 * both stream filters see the same shutdown flag.
 */
export function createKnownTeardownNoiseFilter(
  context: TeardownNoiseContext = createTeardownNoiseContext()
): KnownTeardownNoiseFilter {
  /** Partial (no trailing newline yet) input line. */
  let partial = '';
  /** Held traceback lines (each with its newline) while in hold mode. */
  let held: string[] = [];
  let heldBytes = 0;
  /**
   * State machine:
   *   'pass':   outside any traceback, so lines echo through.
   *   'inside': between a Traceback header and its closing exception line.
   *   'closed': saw the closing `SomeError: …` line, still holding in
   *             case a chained-exception connector continues the block
   *             (the real fixture chains two tracebacks, so the whole
   *             chain must be evaluated as one block or the second half
   *             would print raw after the annotation).
   */
  let state: 'pass' | 'inside' | 'closed' = 'pass';

  const resetHold = (): string => {
    const block = held.join('');
    held = [];
    heldBytes = 0;
    state = 'pass';
    return block;
  };

  const releaseHeld = (): string => {
    const block = resetHold();
    if (block.length === 0) return '';
    return context.shutdownSeen && hasKnownTeardownNoise(block)
      ? KNOWN_TEARDOWN_NOISE_ANNOTATION
      : block;
  };

  const hold = (line: string): { out: string; overflowed: boolean } => {
    held.push(line);
    heldBytes += line.length;
    if (held.length > HOLD_LINE_LIMIT || heldBytes > HOLD_BYTE_LIMIT) {
      // Pathological block: flush verbatim rather than risk withholding
      // output. Do not attempt recognition on oversized blocks.
      return { out: resetHold(), overflowed: true };
    }
    return { out: '', overflowed: false };
  };

  const processLine = (line: string): string => {
    const content = line.replace(/\r?\n$/, '');

    if (state === 'pass') {
      if (TRACEBACK_HEADER_PATTERN.test(content)) {
        state = 'inside';
        return hold(line).out;
      }
      if (SHUTDOWN_MARKER_PATTERN.test(content)) context.shutdownSeen = true;
      return line;
    }

    if (state === 'inside') {
      const isContinuation =
        content.trim().length === 0 ||
        /^[ \t]/.test(content) ||
        TRACEBACK_HEADER_PATTERN.test(content);
      const { out, overflowed } = hold(line);
      // The first unindented line is the closing `SomeError: …` line. Keep
      // holding in case a chained connector extends the block.
      if (!overflowed && !isContinuation) {
        state = 'closed';
      }
      return out;
    }

    // state === 'closed': only a blank line, a chained-exception connector,
    // or another Traceback header continues the block.
    if (content.trim().length === 0 || CHAINED_EXCEPTION_CONNECTOR_PATTERN.test(content)) {
      return hold(line).out;
    }
    if (TRACEBACK_HEADER_PATTERN.test(content)) {
      const { out, overflowed } = hold(line);
      if (!overflowed) state = 'inside';
      return out;
    }
    return releaseHeld() + processLineInPass(line);
  };

  // Re-dispatch a line through pass-mode handling after a block release.
  // The line that ended the block may itself start a new traceback.
  const processLineInPass = (line: string): string => {
    const content = line.replace(/\r?\n$/, '');
    if (TRACEBACK_HEADER_PATTERN.test(content)) {
      state = 'inside';
      return hold(line).out;
    }
    if (SHUTDOWN_MARKER_PATTERN.test(content)) context.shutdownSeen = true;
    return line;
  };

  return {
    transform(chunk: string): string {
      let out = '';
      let buffer = partial + chunk;
      partial = '';
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex + 1);
        buffer = buffer.slice(newlineIndex + 1);
        out += processLine(line);
        newlineIndex = buffer.indexOf('\n');
      }
      partial = buffer;
      return out;
    },
    flush(): string {
      let out = '';
      if (state !== 'pass') {
        // A stream that closes mid-block: fold the trailing partial line in
        // and evaluate. The final exception line is often the last thing
        // printed, without a trailing newline.
        if (partial.length > 0) {
          held.push(partial);
          partial = '';
        }
        out += releaseHeld();
      }
      out += partial;
      partial = '';
      return out;
    },
  };
}
