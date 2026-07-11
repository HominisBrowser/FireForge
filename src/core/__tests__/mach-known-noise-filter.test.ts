// SPDX-License-Identifier: EUPL-1.2
/**
 * Echo-filter tests for the known mozsystemmonitor teardown traceback
 * (0.37.0 item 8). The filter only shapes what reaches the TERMINAL — the
 * capture path stays raw (asserted in mach.test.ts).
 */

import { describe, expect, it } from 'vitest';

import {
  createKnownTeardownNoiseFilter,
  createTeardownNoiseContext,
  KNOWN_TEARDOWN_NOISE_ANNOTATION,
  type TeardownNoiseContext,
} from '../mach-known-noise-filter.js';

/** Runs the whole input through one filter at the given chunk size. */
function filterInChunks(input: string, chunkSize: number, context?: TeardownNoiseContext): string {
  const filter = createKnownTeardownNoiseFilter(context);
  let out = '';
  for (let i = 0; i < input.length; i += chunkSize) {
    out += filter.transform(input.slice(i, i + chunkSize));
  }
  out += filter.flush();
  return out;
}

// The real chained teardown shape (mirrors the classifier fixture): two
// tracebacks joined by the chained-exception connector, closing on the
// stop_time AttributeError.
const KNOWN_TEARDOWN_TRACEBACK = [
  'Traceback (most recent call last):',
  '  File "mozlog/handlers/resource.py", line 58, in stop',
  '    self.resourcemonitor.stop()',
  '  File "mozsystemmonitor/resourcemonitor.py", line 321, in stop',
  '    self._process.send((self.stop_time, psutil.virtual_memory()))',
  "AttributeError: 'SystemResourceMonitor' object has no attribute 'stop_time'",
  'During handling of the above exception, another exception occurred:',
  'Traceback (most recent call last):',
  '  File "psutil/_psosx.py", line 351, in virtual_memory',
  'host_statistics64(HOST_VM_INFO64) syscall failed: (ipc/mig) array not large enough',
  'Error running mach',
  '',
].join('\n');

const GREEN_RUN_WITH_TEARDOWN_NOISE =
  [
    'TEST-START | browser_x.js',
    'TEST-OK | browser_x.js',
    'Unexpected results: 0',
    'SUITE_END',
    '',
  ].join('\n') + KNOWN_TEARDOWN_TRACEBACK;

const UNRELATED_TRACEBACK = [
  'before line',
  'Traceback (most recent call last):',
  '  File "some/module.py", line 12, in main',
  '    1 / 0',
  'ZeroDivisionError: division by zero',
  'after line',
  '',
].join('\n');

describe('createKnownTeardownNoiseFilter', () => {
  it('collapses the known chained teardown traceback to the one-line annotation', () => {
    const out = filterInChunks(GREEN_RUN_WITH_TEARDOWN_NOISE, 4096);
    expect(out).toContain('TEST-OK | browser_x.js');
    expect(out).toContain('SUITE_END');
    expect(out).toContain(KNOWN_TEARDOWN_NOISE_ANNOTATION);
    expect(out).not.toContain('stop_time');
    expect(out).not.toContain('Traceback');
    expect(out).not.toContain('host_statistics64');
    // The trailer after the block still prints.
    expect(out).toContain('Error running mach');
  });

  it('is chunk-boundary safe (mid-line and mid-block splits)', () => {
    for (const chunkSize of [1, 3, 7, 17, 64]) {
      const out = filterInChunks(GREEN_RUN_WITH_TEARDOWN_NOISE, chunkSize);
      expect(out).toContain(KNOWN_TEARDOWN_NOISE_ANNOTATION);
      expect(out).not.toContain('stop_time');
    }
  });

  it('passes an unrelated traceback through byte-identical', () => {
    const out = filterInChunks(UNRELATED_TRACEBACK, 5);
    expect(out).toBe(UNRELATED_TRACEBACK);
  });

  it('passes normal output through promptly and byte-identical', () => {
    const plain = 'line one\nline two\nline three\n';
    const filter = createKnownTeardownNoiseFilter();
    expect(filter.transform('line one\nline tw')).toBe('line one\n');
    expect(filter.transform('o\nline three\n')).toBe('line two\nline three\n');
    expect(filter.flush()).toBe('');
    expect(filterInChunks(plain, 4)).toBe(plain);
  });

  it('flushes an unterminated partial block verbatim when unrecognized', () => {
    const truncated = 'Traceback (most recent call last):\n  File "x.py", line 1, in main';
    const out = filterInChunks(truncated, 9);
    expect(out).toBe(truncated);
  });

  it('recognizes a block that closes at stream end without a trailing newline', () => {
    const closing =
      'SUITE_END\n' +
      'Traceback (most recent call last):\n' +
      '  File "mozsystemmonitor/resourcemonitor.py", line 321, in stop\n' +
      "AttributeError: 'SystemResourceMonitor' object has no attribute 'stop_time'";
    const out = filterInChunks(closing, 11);
    expect(out).toBe(`SUITE_END\n${KNOWN_TEARDOWN_NOISE_ANNOTATION}`);
  });

  it('flushes an oversized block verbatim instead of withholding output', () => {
    const huge =
      'Traceback (most recent call last):\n' + '  filler line\n'.repeat(150) + 'SomeError: x\n';
    const out = filterInChunks(huge, 4096);
    expect(out).toBe(huge);
  });

  it('does not trigger on generic psutil noise without the SystemResourceMonitor signature', () => {
    const generic = [
      'Traceback (most recent call last):',
      '  File "psutil/_psosx.py", line 351, in virtual_memory',
      'psutil.AccessDenied: (pid=42)',
      '',
    ].join('\n');
    const out = filterInChunks(generic, 4096);
    expect(out).toBe(generic);
  });

  // ── The filter is scoped to the documented incident: a closed attribute
  //    allowlist, a resourcemonitor.py frame, and a seen shutdown marker.
  //    Anything looser prints verbatim so new upstream defects stay visible. ──

  it('passes a non-allowlisted SystemResourceMonitor attribute through verbatim', () => {
    const novel = [
      'SUITE_END',
      'Traceback (most recent call last):',
      '  File "mozsystemmonitor/resourcemonitor.py", line 321, in stop',
      "AttributeError: 'SystemResourceMonitor' object has no attribute 'start_time'",
      '',
    ].join('\n');
    const out = filterInChunks(novel, 4096);
    expect(out).toBe(novel);
  });

  it('passes a novel exception type in resourcemonitor.py through verbatim', () => {
    const novel = [
      'SUITE_END',
      'Traceback (most recent call last):',
      '  File "mozsystemmonitor/resourcemonitor.py", line 700, in _collect',
      "TypeError: '_DegradedReading' object is not iterable",
      '',
    ].join('\n');
    const out = filterInChunks(novel, 4096);
    expect(out).toBe(novel);
  });

  it('passes an allowlisted AttributeError without a resourcemonitor.py frame through verbatim', () => {
    const frameless = [
      'SUITE_END',
      'Traceback (most recent call last):',
      '  File "some/other/module.py", line 10, in stop',
      "AttributeError: 'SystemResourceMonitor' object has no attribute 'stop_time'",
      '',
    ].join('\n');
    const out = filterInChunks(frameless, 4096);
    expect(out).toBe(frameless);
  });

  it('passes the recognized traceback through verbatim BEFORE any shutdown marker', () => {
    const midRun = 'TEST-START | browser_x.js\n' + KNOWN_TEARDOWN_TRACEBACK;
    const out = filterInChunks(midRun, 4096);
    expect(out).toBe(midRun);
    expect(out).not.toContain(KNOWN_TEARDOWN_NOISE_ANNOTATION);
  });

  it('collapses the poll_interval variant of the documented family after shutdown', () => {
    const pollInterval = [
      'SUITE_END',
      'Traceback (most recent call last):',
      '  File "mozsystemmonitor/resourcemonitor.py", line 199, in __init__',
      "AttributeError: 'SystemResourceMonitor' object has no attribute 'poll_interval'",
      '',
    ].join('\n');
    const out = filterInChunks(pollInterval, 4096);
    expect(out).toBe(`SUITE_END\n${KNOWN_TEARDOWN_NOISE_ANNOTATION}`);
  });

  it('shares the shutdown flag across the two stream filters of one run', () => {
    // SUITE_END arrives on stdout; the traceback lands on stderr.
    const shared = createTeardownNoiseContext();
    const stdoutFilter = createKnownTeardownNoiseFilter(shared);
    const stderrFilter = createKnownTeardownNoiseFilter(shared);

    let stderrOut = '';
    stdoutFilter.transform('SUITE_END\n');
    stderrOut += stderrFilter.transform(KNOWN_TEARDOWN_TRACEBACK);
    stderrOut += stderrFilter.flush();
    expect(stderrOut).toContain(KNOWN_TEARDOWN_NOISE_ANNOTATION);
    expect(stderrOut).not.toContain('stop_time');

    // With SEPARATE contexts the stderr filter never learns of shutdown
    // and the block prints verbatim.
    const isolatedStderr = createKnownTeardownNoiseFilter(createTeardownNoiseContext());
    createKnownTeardownNoiseFilter(createTeardownNoiseContext()).transform('SUITE_END\n');
    const verbatim = isolatedStderr.transform(KNOWN_TEARDOWN_TRACEBACK) + isolatedStderr.flush();
    expect(verbatim).toContain('stop_time');
    expect(verbatim).not.toContain(KNOWN_TEARDOWN_NOISE_ANNOTATION);
  });
});
