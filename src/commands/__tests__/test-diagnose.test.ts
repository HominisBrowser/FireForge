// SPDX-License-Identifier: EUPL-1.2
/**
 * Direct unit tests for the harness-verdict application layer: the
 * green-summary rejection surfacing (0.35.0 crash green-wash fix) and the
 * non-zero-exit diagnosis branches that only fire on specific captured
 * output shapes. The classifier itself is covered by
 * `src/core/__tests__/test-harness-crash.test.ts`; the command-level
 * composition by `test.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/logger.js', () => ({
  info: vi.fn(),
}));

import { createPostRebuildFailureContext } from '../../core/test-harness-output.js';
import { info } from '../../utils/logger.js';
import { diagnoseShardOutcome, finalizeSingleRunOutcome } from '../test-diagnose.js';
import type { TestRunOutcome } from '../test-run.js';

function makeOutcome(overrides: {
  exitCode: number;
  verdict: TestRunOutcome['verdict'];
  stdout?: string;
}): TestRunOutcome {
  return {
    result: { exitCode: overrides.exitCode, stdout: overrides.stdout ?? '', stderr: '' },
    verdict: overrides.verdict,
    attempts: 1,
    appdirInjectionAttempted: false,
  };
}

const PATHS = ['browser/base/content/test/hominis/browser_hominis_first.js'];

describe('finalizeSingleRunOutcome', () => {
  it('throws the rejection explanation when a green-looking summary was rejected on crash evidence', () => {
    const outcome = makeOutcome({
      exitCode: 1,
      verdict: {
        kind: 'test-failures',
        greenSummaryRejected: {
          crashLine: 'Main app process: killed by SIGSEGV',
          neverStarted: ['browser/base/content/test/hominis/browser_hominis_third.js'],
          neverEnded: ['browser/base/content/test/hominis/browser_hominis_cui_telemetry.js'],
        },
      },
    });

    expect(() => {
      finalizeSingleRunOutcome(outcome, PATHS, 'mybrowser', undefined);
    }).toThrow(/killed by SIGSEGV[\s\S]*never started[\s\S]*never finished/);
  });

  it('keeps the lenient override note for a surviving green-summary override', () => {
    const outcome = makeOutcome({
      exitCode: 1,
      verdict: { kind: 'tests-ran-ok', greenSummaryOverride: true },
    });

    expect(() => {
      finalizeSingleRunOutcome(outcome, PATHS, 'mybrowser', undefined);
    }).not.toThrow();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('non-fatal harness noise'));
  });

  it('diagnoses the harness-symlink FileExistsError shape', () => {
    const outcome = makeOutcome({
      exitCode: 1,
      verdict: { kind: 'test-failures' },
      stdout: 'FileExistsError: [Errno 17] File exists: obj-x/_tests/testing/mochitest/browser',
    });

    expect(() => {
      finalizeSingleRunOutcome(outcome, PATHS, 'mybrowser', undefined);
    }).toThrow(/harness symlinks/);
  });

  it('echoes the TEST-UNEXPECTED blocks with assertion text into the failure summary (0.37.0 item 7)', () => {
    const outcome = makeOutcome({
      exitCode: 1,
      verdict: {
        kind: 'test-failures',
        realFailureLine: 'Unexpected results: 1',
        realFailureBlocks: [
          'TEST-UNEXPECTED-FAIL | browser_x.js | Assert.equal - got false, expected true\nGot false\nExpected true',
        ],
      },
      stdout: 'TEST-UNEXPECTED-FAIL | browser_x.js | Assert.equal - got false, expected true',
    });

    expect(() => {
      finalizeSingleRunOutcome(outcome, PATHS, 'mybrowser', undefined);
    }).toThrow(/Tests failed with exit code 1/);
    expect(info).toHaveBeenCalledWith('First real test failure: Unexpected results: 1');
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining(
        'TEST-UNEXPECTED-FAIL | browser_x.js | Assert.equal - got false, expected true'
      )
    );
    expect(info).toHaveBeenCalledWith(expect.stringContaining('Expected true'));
  });

  it('prepends the post-rebuild context to the generic failure message', () => {
    const outcome = makeOutcome({
      exitCode: 1,
      verdict: { kind: 'test-failures' },
      stdout: 'TEST-UNEXPECTED-FAIL | browser_hominis_first.js | boom',
    });
    const context = createPostRebuildFailureContext('fireforge test --build', PATHS);

    expect(() => {
      finalizeSingleRunOutcome(outcome, PATHS, 'mybrowser', context);
    }).toThrow(/Post-rebuild test failure:[\s\S]*Tests failed with exit code 1/);
  });
});

describe('diagnoseShardOutcome', () => {
  it('returns the rejection explanation instead of the generic exit-code diagnosis', () => {
    const outcome = makeOutcome({
      exitCode: 1,
      verdict: {
        kind: 'test-failures',
        greenSummaryRejected: {
          neverStarted: [],
          neverEnded: ['browser/base/content/test/hominis/browser_hominis_cui_telemetry.js'],
        },
      },
    });

    const diagnosis = diagnoseShardOutcome(
      outcome,
      'browser/base/content/test/hominis',
      'mybrowser',
      undefined
    );
    expect(diagnosis).toContain('did NOT treat the run as passed');
    expect(diagnosis).toContain('browser_hominis_cui_telemetry.js');
  });

  it('prepends the TEST-UNEXPECTED blocks to the shard diagnosis string (0.37.0 item 7)', () => {
    const outcome = makeOutcome({
      exitCode: 1,
      verdict: {
        kind: 'test-failures',
        realFailureBlocks: ['TEST-UNEXPECTED-FAIL | browser_x.js | boom\nGot 1\nExpected 2'],
      },
      stdout: 'TEST-UNEXPECTED-FAIL | browser_x.js | boom',
    });

    const diagnosis = diagnoseShardOutcome(outcome, 'a/browser_x.js', 'mybrowser', undefined);
    expect(diagnosis).toContain('TEST-UNEXPECTED-FAIL | browser_x.js | boom');
    expect(diagnosis).toContain('Expected 2');
    expect(diagnosis).toContain('Tests failed with exit code 1');
  });

  it('returns the no-tests message for a silent exit-0 shard and undefined for a passing one', () => {
    const silent = makeOutcome({ exitCode: 0, verdict: { kind: 'no-tests' } });
    expect(diagnoseShardOutcome(silent, 'a/browser_x.js', 'mybrowser', undefined)).toContain(
      'without starting any of the requested tests'
    );

    const passing = makeOutcome({ exitCode: 0, verdict: { kind: 'tests-ran-ok' } });
    expect(diagnoseShardOutcome(passing, 'a/browser_x.js', 'mybrowser', undefined)).toBeUndefined();
  });
});
