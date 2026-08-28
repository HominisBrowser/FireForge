// SPDX-License-Identifier: EUPL-1.2
/**
 * Unit tests for the verdict sink: the exactly-one-`FIREFORGE-VERDICT:`-
 * line guarantee (first write wins, `resetVerdictEmission` re-arms) and
 * the exact rendering of every emission form, including the sharded
 * aggregate suffix.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setActiveRunLog } from '../../core/run-log.js';
import { error as logError } from '../../utils/logger.js';
import {
  emitFailVerdict,
  emitHarnessVerdict,
  emitKilledVerdict,
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
  setActiveRunLog(undefined);
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

describe('emitKilledVerdict', () => {
  it('writes the terminal line for a run killed mid-flight', () => {
    const stdout = captureStdout();
    try {
      expect(emitKilledVerdict('SIGTERM')).toBe(true);
      expect(stdout.writes.join('')).toBe('FIREFORGE-VERDICT: FAIL reason=killed signal=SIGTERM\n');
    } finally {
      stdout.restore();
    }
  });

  it('does not displace a verdict the run already reached', () => {
    const stdout = captureStdout();
    try {
      emitFailVerdict('test-failures');
      expect(emitKilledVerdict('SIGINT')).toBe(false);
      expect(stdout.writes.join('')).toBe('FIREFORGE-VERDICT: FAIL reason=test-failures\n');
    } finally {
      stdout.restore();
    }
  });

  it('stays silent when no test run was in flight', async () => {
    // A Ctrl+C during `fireforge status` must not claim a test run happened.
    // Reload the module so `armed` is false, as it is in a fresh process.
    vi.resetModules();
    const fresh = await import('../test-verdict.js');
    const stdout = captureStdout();
    try {
      expect(fresh.emitKilledVerdict('SIGINT')).toBe(false);
      expect(stdout.writes).toEqual([]);
    } finally {
      stdout.restore();
    }
  });
});

describe('the run-log path rides the verdict line', () => {
  /**
   * The five command suites mock `run-log.js` away so their exact-string
   * verdict assertions hold on every platform, which leaves this the only
   * place the ` log=<path>` suffix is pinned. It has to be here rather than
   * there: the suffix must be part of the verdict line and not a separate
   * write, because the verdict is the run's LAST stdout write and a `tail`
   * cuts anything printed before it.
   */
  it('appends log=<path> to the emitted line, once, as the final write', () => {
    setActiveRunLog({
      path: '/project/.fireforge/logs/test-2026-08-28T13-44-02-406Z.log',
      write: vi.fn(),
      close: vi.fn(() => Promise.resolve()),
    });
    const capture = captureStdout();
    try {
      emitPassVerdict();
      emitFailVerdict('preflight');
    } finally {
      capture.restore();
      setActiveRunLog(undefined);
    }
    expect(capture.writes).toEqual([
      'FIREFORGE-VERDICT: PASS log=/project/.fireforge/logs/test-2026-08-28T13-44-02-406Z.log\n',
    ]);
  });

  it('emits no suffix when no log could be opened', () => {
    const capture = captureStdout();
    try {
      emitPassVerdict();
    } finally {
      capture.restore();
    }
    expect(capture.writes).toEqual(['FIREFORGE-VERDICT: PASS\n']);
  });
});
