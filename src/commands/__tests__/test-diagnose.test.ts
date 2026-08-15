// SPDX-License-Identifier: EUPL-1.2
/**
 * Direct unit tests for the harness-verdict application layer: the
 * green-summary rejection surfacing (0.35.0 crash green-wash fix) and the
 * non-zero-exit diagnosis branches that only fire on specific captured
 * output shapes. The classifier itself is covered by
 * `src/core/__tests__/test-harness-crash.test.ts`; the command-level
 * composition by `test.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/logger.js', () => ({
  setStdoutSealed: vi.fn(),
  info: vi.fn(),
}));

import { createPostRebuildFailureContext } from '../../core/test-harness-output.js';
import { info } from '../../utils/logger.js';
import { diagnoseShardOutcome, finalizeSingleRunOutcome } from '../test-diagnose.js';
import type { TestRunOutcome } from '../test-run.js';
import { resetVerdictEmission } from '../test-verdict.js';

// The verdict sink is first-write-wins per run; `testCommand` re-arms it at
// entry, so direct unit invocations re-arm it here.
beforeEach(() => {
  resetVerdictEmission();
});

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

describe('finalizeSingleRunOutcome FIREFORGE-VERDICT line (FORGE I5)', () => {
  function captureStdout(): { writes: string[]; restore: () => void } {
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      });
    return {
      writes,
      restore: () => {
        spy.mockRestore();
      },
    };
  }

  it('a pass emits exactly one PASS line as the last stdout write (previously nothing at all)', () => {
    const capture = captureStdout();
    try {
      finalizeSingleRunOutcome(
        makeOutcome({
          exitCode: 0,
          verdict: { kind: 'tests-ran-ok', checks: 16, unexpected: 0 },
        }),
        PATHS,
        'mybrowser',
        undefined
      );
    } finally {
      capture.restore();
    }
    const verdictLines = capture.writes.filter((w) => w.startsWith('FIREFORGE-VERDICT:'));
    expect(verdictLines).toEqual(['FIREFORGE-VERDICT: PASS checks=16 unexpected=0\n']);
    expect(capture.writes.at(-1)).toBe('FIREFORGE-VERDICT: PASS checks=16 unexpected=0\n');
  });

  it('every throw path still rejects AND the last stdout write is the FAIL line', () => {
    const cases: Array<{ verdict: TestRunOutcome['verdict']; exitCode: number; line: string }> = [
      {
        verdict: {
          kind: 'harness-crash',
          signature: { reason: 'resource monitor traceback', line: 'Traceback' },
        },
        exitCode: 1,
        line: 'FIREFORGE-VERDICT: FAIL reason=crash\n',
      },
      {
        verdict: { kind: 'no-tests' },
        exitCode: 0,
        line: 'FIREFORGE-VERDICT: FAIL reason=no-tests\n',
      },
      {
        verdict: {
          kind: 'test-failures',
          unexpected: 2,
          greenSummaryRejected: {
            crashLine: 'killed by SIGSEGV',
            neverStarted: [],
            neverEnded: [],
          },
        },
        exitCode: 1,
        line: 'FIREFORGE-VERDICT: FAIL reason=test-failures unexpected=2\n',
      },
      {
        verdict: { kind: 'test-failures' },
        exitCode: 1,
        line: 'FIREFORGE-VERDICT: FAIL reason=test-failures\n',
      },
    ];
    for (const { verdict, exitCode, line } of cases) {
      resetVerdictEmission();
      const capture = captureStdout();
      try {
        expect(() => {
          finalizeSingleRunOutcome(
            makeOutcome({ exitCode, verdict }),
            PATHS,
            'mybrowser',
            undefined
          );
        }).toThrow();
      } finally {
        capture.restore();
      }
      expect(capture.writes.at(-1)).toBe(line);
    }
  });
});

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

  describe('fork-module signal regex escaping', () => {
    // The inline escape this replaced wrote `[.*+?^${}()|[\\]\\\\]`, a class
    // that closes early and therefore escaped nothing. Config validation
    // (`config-validate.ts:59-70`) lets regex metacharacters through in
    // `binaryName`, so both cases below were reachable from a valid config.
    function diagnose(binaryName: string, stdout: string): () => void {
      return () => {
        finalizeSingleRunOutcome(
          makeOutcome({ exitCode: 1, verdict: { kind: 'test-failures' }, stdout }),
          PATHS,
          binaryName,
          undefined
        );
      };
    }

    it('matches the fork-module failure for a plain binary name', () => {
      expect(
        diagnose('mybrowser', 'Failed to load resource:///modules/mybrowser/Store.sys.mjs')
      ).toThrow(/fork-owned module/);
    });

    it('does not let a dot in the binary name match an arbitrary character', () => {
      // Unescaped, `my.browser` matched `myXbrowser` and misdiagnosed an
      // unrelated module failure as this fork's registration problem.
      expect(
        diagnose('my.browser', 'Failed to load resource:///modules/myXbrowser/Store.sys.mjs')
      ).not.toThrow(/fork-owned module/);
      expect(
        diagnose('my.browser', 'Failed to load resource:///modules/my.browser/Store.sys.mjs')
      ).toThrow(/fork-owned module/);
    });

    it('does not throw a SyntaxError for a binary name containing regex metacharacters', () => {
      // Unescaped, the unbalanced `(` threw out of the diagnosis path and
      // replaced the real test failure with an opaque regex error.
      expect(diagnose('my(browser', 'some unrelated failure output')).not.toThrow(SyntaxError);
      expect(diagnose('my[browser', 'some unrelated failure output')).not.toThrow(SyntaxError);
    });
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
