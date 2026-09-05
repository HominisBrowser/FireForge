// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { findFirstUsefulFailureLine } from '../test-harness-output.js';

describe('findFirstUsefulFailureLine', () => {
  it('picks the first TEST-UNEXPECTED line ahead of generic output', () => {
    const output = [
      'INFO Running browser-chrome tests',
      'WARNING unrelated cleanup noise',
      'TEST-UNEXPECTED-FAIL | browser_dummy.js | expected true got false',
    ].join('\n');

    expect(findFirstUsefulFailureLine(output)).toBe(
      'TEST-UNEXPECTED-FAIL | browser_dummy.js | expected true got false'
    );
  });

  it('picks module-load runtime failures', () => {
    const output = [
      'INFO Running xpcshell tests',
      'ERROR Unexpected exception Error: Failed to load resource:///modules/HominisSurfaceManager.sys.mjs',
    ].join('\n');

    expect(findFirstUsefulFailureLine(output)).toBe(
      'ERROR Unexpected exception Error: Failed to load resource:///modules/HominisSurfaceManager.sys.mjs'
    );
  });

  it('prefers the real assertion over a recognized teardown traceback that precedes it', () => {
    // Regression. Selection is first-matching-line, and the bare
    // `AttributeError:` pattern had the same standing as
    // `TEST-UNEXPECTED-FAIL`, so an export shard whose real defect was a
    // file-count assertion got diagnosed as the known mozsystemmonitor
    // teardown crash. That is the expensive kind of wrong: the named cause
    // is a real, documented, unrelated upstream defect, so it reads as an
    // answer.
    const output = [
      'INFO Running export tests',
      'Traceback (most recent call last):',
      '  File "/engine/third_party/python/mozsystemmonitor/resourcemonitor.py", line 1, in stop',
      "AttributeError: 'SystemResourceMonitor' object has no attribute 'stop_time'",
      'TEST-UNEXPECTED-FAIL | test_export.js | expected 18 files got 0',
    ].join('\n');

    expect(findFirstUsefulFailureLine(output)).toBe(
      'TEST-UNEXPECTED-FAIL | test_export.js | expected 18 files got 0'
    );
  });

  it('still reports the recognized teardown line when it is the only failure', () => {
    // Excluding it from CANDIDACY must not make it unreportable: a run
    // whose only evidence is the teardown still has to say something.
    const output = [
      'INFO Running export tests',
      '  File "/engine/third_party/python/mozsystemmonitor/resourcemonitor.py", line 1, in stop',
      "AttributeError: 'SystemResourceMonitor' object has no attribute 'stop_time'",
    ].join('\n');

    expect(findFirstUsefulFailureLine(output)).toBe(
      "AttributeError: 'SystemResourceMonitor' object has no attribute 'stop_time'"
    );
  });

  it('keeps a NOVEL AttributeError as a real failure', () => {
    // The allowlist is closed on purpose: a different missing attribute is
    // a new upstream defect, not this incident, and must not be demoted.
    const output = [
      'INFO Running export tests',
      '  File "/engine/third_party/python/mozsystemmonitor/resourcemonitor.py", line 1, in stop',
      "AttributeError: 'SystemResourceMonitor' object has no attribute 'brand_new_field'",
      'TEST-UNEXPECTED-FAIL | test_export.js | expected 18 files got 0',
    ].join('\n');

    expect(findFirstUsefulFailureLine(output)).toBe(
      "AttributeError: 'SystemResourceMonitor' object has no attribute 'brand_new_field'"
    );
  });

  it('keeps a recognized-shaped AttributeError from OUTSIDE resourcemonitor a real failure', () => {
    // The two-signal rule the rest of the codebase applies: without a
    // `resourcemonitor.py` frame this is not the known incident.
    const output = [
      'INFO Running export tests',
      "AttributeError: 'SystemResourceMonitor' object has no attribute 'stop_time'",
      'TEST-UNEXPECTED-FAIL | test_export.js | expected 18 files got 0',
    ].join('\n');

    expect(findFirstUsefulFailureLine(output)).toBe(
      "AttributeError: 'SystemResourceMonitor' object has no attribute 'stop_time'"
    );
  });

  it('falls back to the first nonempty output line', () => {
    expect(findFirstUsefulFailureLine('\n  first useful line\nsecond line\n')).toBe(
      'first useful line'
    );
  });
});
