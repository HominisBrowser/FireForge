// SPDX-License-Identifier: EUPL-1.2
/**
 * Unit tests for the verdict sink: the exactly-one-`FIREFORGE-VERDICT:`-
 * line guarantee (first write wins, `resetVerdictEmission` re-arms) and
 * the exact rendering of every emission form, including the sharded
 * aggregate suffix.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { error as logError } from '../../utils/logger.js';
import {
  emitFailVerdict,
  emitHarnessVerdict,
  emitPassVerdict,
  resetVerdictEmission,
  verdictEmitted,
} from '../test-verdict.js';

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

beforeEach(() => {
  resetVerdictEmission();
});

describe('verdict sink exactly-one-line guarantee', () => {
  it('suppresses every emission after the first, of any kind', () => {
    const capture = captureStdout();
    try {
      expect(verdictEmitted()).toBe(false);
      emitFailVerdict('inconclusive');
      expect(verdictEmitted()).toBe(true);
      emitPassVerdict();
      emitFailVerdict('preflight');
      emitHarnessVerdict({ kind: 'tests-ran-ok' });
    } finally {
      capture.restore();
    }
    expect(capture.writes).toEqual(['FIREFORGE-VERDICT: FAIL reason=inconclusive\n']);
  });

  it('emitting seals stdout: later logger output routes to stderr until the sink is re-armed', () => {
    const capture = captureStdout();
    const stderrWrites: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        stderrWrites.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      });
    try {
      emitFailVerdict('preflight');
      logError('after verdict');
      expect(stderrWrites).toEqual(['error: after verdict\n']);
      // The verdict is still the ONLY stdout write.
      expect(capture.writes).toEqual(['FIREFORGE-VERDICT: FAIL reason=preflight\n']);

      resetVerdictEmission();
      logError('next run');
      // Unsealed: back through clack, off the diagnostic stderr channel.
      expect(stderrWrites).toEqual(['error: after verdict\n']);
    } finally {
      stderrSpy.mockRestore();
      capture.restore();
    }
  });

  it('resetVerdictEmission re-arms the sink for a new run', () => {
    const capture = captureStdout();
    try {
      emitPassVerdict();
      resetVerdictEmission();
      expect(verdictEmitted()).toBe(false);
      emitFailVerdict('preflight');
    } finally {
      capture.restore();
    }
    expect(capture.writes).toEqual([
      'FIREFORGE-VERDICT: PASS\n',
      'FIREFORGE-VERDICT: FAIL reason=preflight\n',
    ]);
  });
});

describe('verdict rendering', () => {
  it('renders every emission-layer FAIL reason exactly', () => {
    for (const reason of [
      'crash',
      'no-tests',
      'test-failures',
      'preflight',
      'inconclusive',
    ] as const) {
      resetVerdictEmission();
      const capture = captureStdout();
      try {
        emitFailVerdict(reason);
      } finally {
        capture.restore();
      }
      expect(capture.writes).toEqual([`FIREFORGE-VERDICT: FAIL reason=${reason}\n`]);
    }
  });

  it('renders harness verdicts with the sharded aggregate suffix', () => {
    const cases: Array<{
      verdict: Parameters<typeof emitHarnessVerdict>[0];
      shards: { passed: number; total: number };
      line: string;
    }> = [
      {
        verdict: { kind: 'tests-ran-ok' },
        shards: { passed: 2, total: 2 },
        line: 'FIREFORGE-VERDICT: PASS shards=2/2\n',
      },
      {
        verdict: { kind: 'harness-crash' },
        shards: { passed: 1, total: 2 },
        line: 'FIREFORGE-VERDICT: FAIL reason=crash shards=1/2\n',
      },
      {
        verdict: { kind: 'no-tests' },
        shards: { passed: 0, total: 3 },
        line: 'FIREFORGE-VERDICT: FAIL reason=no-tests shards=0/3\n',
      },
      {
        verdict: { kind: 'test-failures' },
        shards: { passed: 1, total: 2 },
        line: 'FIREFORGE-VERDICT: FAIL reason=test-failures shards=1/2\n',
      },
    ];
    for (const { verdict, shards, line } of cases) {
      resetVerdictEmission();
      const capture = captureStdout();
      try {
        emitHarnessVerdict(verdict, shards);
      } finally {
        capture.restore();
      }
      expect(capture.writes).toEqual([line]);
    }
  });

  it('renders a single-run harness verdict without a shards suffix', () => {
    const capture = captureStdout();
    try {
      emitHarnessVerdict({ kind: 'tests-ran-ok', checks: 16, unexpected: 0 });
    } finally {
      capture.restore();
    }
    expect(capture.writes).toEqual(['FIREFORGE-VERDICT: PASS checks=16 unexpected=0\n']);
  });
});
