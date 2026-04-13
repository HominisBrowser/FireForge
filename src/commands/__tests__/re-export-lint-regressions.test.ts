// SPDX-License-Identifier: EUPL-1.2
/**
 * Unit tests for `computeProjectedLintRegressions`, the baseline-vs-projected
 * diff helper used by `re-export --files` to decide which projected errors
 * are new regressions introduced by a shrink (vs. pre-existing errors
 * elsewhere in the queue that should not block).
 *
 * The helper now prefers `PatchLintIssue.fingerprint` when present, so
 * rules like cross-patch forward-import can ignore harmless message drift
 * without collapsing genuinely different findings in the same source file.
 * When no fingerprint exists the helper falls back to the full
 * (check|file|message) tuple.
 */

import { describe, expect, it } from 'vitest';

import { computeProjectedLintRegressions } from '../../core/lint-projection.js';
import type { PatchLintIssue } from '../../types/commands/index.js';

function issue(
  check: string,
  file: string,
  message: string,
  severity: 'error' | 'warning' = 'error',
  fingerprint?: string
): PatchLintIssue {
  return { check, file, message, severity, ...(fingerprint ? { fingerprint } : {}) };
}

describe('computeProjectedLintRegressions', () => {
  it('returns no regressions when baseline and projected are identical', () => {
    const baseline = [
      issue('forward-import', 'foo.js', 'imports bar'),
      issue('duplicate-new-file-creation', 'baz.js', 'created twice'),
    ];
    const projected = [
      issue('forward-import', 'foo.js', 'imports bar'),
      issue('duplicate-new-file-creation', 'baz.js', 'created twice'),
    ];

    expect(computeProjectedLintRegressions(baseline, projected)).toEqual([]);
  });

  it('ignores message drift when check and file match', () => {
    // Same underlying issue, but message text differs (e.g. a line
    // number, or a reformatted owners-summary suffix). The fingerprint
    // keeps the equivalence stable.
    const fingerprint = 'forward-import|foo.js|resource:///modules/bar.sys.mjs|002-infra.patch';
    const baseline = [
      issue('forward-import', 'foo.js', 'imports bar.js at line 42', 'error', fingerprint),
    ];
    const projected = [
      issue('forward-import', 'foo.js', 'imports bar.js at line 43', 'error', fingerprint),
    ];

    expect(computeProjectedLintRegressions(baseline, projected)).toEqual([]);
  });

  it('treats a swapped forward-import in the same file as a regression when fingerprints differ', () => {
    const baseline = [
      issue(
        'forward-import',
        'foo.js',
        'imports bar',
        'error',
        'forward-import|foo.js|resource:///modules/bar.sys.mjs|002-infra-bar.patch'
      ),
    ];
    const projected = [
      issue(
        'forward-import',
        'foo.js',
        'imports baz',
        'error',
        'forward-import|foo.js|resource:///modules/baz.sys.mjs|003-infra-baz.patch'
      ),
    ];

    const regressions = computeProjectedLintRegressions(baseline, projected);
    expect(regressions).toHaveLength(1);
    expect(regressions[0]?.message).toBe('imports baz');
  });

  it('reports a projected issue as a regression when its (check, file) is new', () => {
    const baseline = [issue('forward-import', 'foo.js', 'imports bar.js')];
    const projected = [
      issue('forward-import', 'foo.js', 'imports bar.js'),
      issue('forward-import', 'qux.js', 'imports quux.js'),
    ];

    const regressions = computeProjectedLintRegressions(baseline, projected);
    expect(regressions).toHaveLength(1);
    expect(regressions[0]?.file).toBe('qux.js');
  });

  it('reports the excess count when projected has more of the same (check, file)', () => {
    // Baseline: two distinct forward-import errors on foo.js.
    // Projected: three. The extra one is a regression.
    const baseline = [
      issue('forward-import', 'foo.js', 'imports bar', 'error', 'fi|foo.js|bar|002'),
      issue('forward-import', 'foo.js', 'imports baz', 'error', 'fi|foo.js|baz|003'),
    ];
    const projected = [
      issue('forward-import', 'foo.js', 'imports bar', 'error', 'fi|foo.js|bar|002'),
      issue('forward-import', 'foo.js', 'imports baz', 'error', 'fi|foo.js|baz|003'),
      issue('forward-import', 'foo.js', 'imports quux', 'error', 'fi|foo.js|quux|004'),
    ];

    const regressions = computeProjectedLintRegressions(baseline, projected);
    expect(regressions).toHaveLength(1);
    // Consumption is stable left-to-right, so the *last* projected issue
    // on this key is the one flagged.
    expect(regressions[0]?.message).toBe('imports quux');
  });

  it('does not report a projected issue when baseline has spare counterparts', () => {
    // Baseline has three, projected has two — not a regression.
    const baseline = [
      issue('forward-import', 'foo.js', 'a', 'error', 'fi|foo.js|a'),
      issue('forward-import', 'foo.js', 'b', 'error', 'fi|foo.js|b'),
      issue('forward-import', 'foo.js', 'c', 'error', 'fi|foo.js|c'),
    ];
    const projected = [
      issue('forward-import', 'foo.js', 'a', 'error', 'fi|foo.js|a'),
      issue('forward-import', 'foo.js', 'b', 'error', 'fi|foo.js|b'),
    ];

    expect(computeProjectedLintRegressions(baseline, projected)).toEqual([]);
  });

  it('keys are disjoint by check even for the same file', () => {
    const baseline = [issue('forward-import', 'foo.js', 'imports bar')];
    const projected = [
      issue('forward-import', 'foo.js', 'imports bar'),
      issue('duplicate-new-file-creation', 'foo.js', 'created twice'),
    ];

    const regressions = computeProjectedLintRegressions(baseline, projected);
    expect(regressions).toHaveLength(1);
    expect(regressions[0]?.check).toBe('duplicate-new-file-creation');
  });

  it('keys are disjoint by file even for the same check', () => {
    const baseline = [issue('forward-import', 'foo.js', 'imports bar')];
    const projected = [
      issue('forward-import', 'foo.js', 'imports bar'),
      issue('forward-import', 'qux.js', 'imports quux'),
    ];

    const regressions = computeProjectedLintRegressions(baseline, projected);
    expect(regressions).toHaveLength(1);
    expect(regressions[0]?.file).toBe('qux.js');
  });

  it('treats empty baseline as "every projected issue is a regression"', () => {
    const projected = [
      issue('forward-import', 'foo.js', 'a'),
      issue('duplicate-new-file-creation', 'bar.js', 'b'),
    ];

    const regressions = computeProjectedLintRegressions([], projected);
    expect(regressions).toHaveLength(2);
  });

  it('treats empty projected as "no regressions possible"', () => {
    const baseline = [issue('forward-import', 'foo.js', 'a')];
    expect(computeProjectedLintRegressions(baseline, [])).toEqual([]);
  });

  it('falls back to the full tuple when no fingerprint is present', () => {
    const baseline = [issue('forward-import', 'foo.js', 'imports bar at line 42')];
    const projected = [issue('forward-import', 'foo.js', 'imports bar at line 43')];

    const regressions = computeProjectedLintRegressions(baseline, projected);
    expect(regressions).toHaveLength(1);
    expect(regressions[0]?.message).toBe('imports bar at line 43');
  });
});
