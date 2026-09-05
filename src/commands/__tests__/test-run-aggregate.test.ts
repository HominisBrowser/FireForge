// SPDX-License-Identifier: EUPL-1.2
/**
 * Unit tests for the sharded aggregate verdict: classification precedence
 * (crash > no-tests > test-failures) and `finalizeShardedOutcome`'s
 * emit-then-throw contract. The full command-level composition (including
 * the engine-generation ordering) is covered in `test.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HarnessRunVerdict } from '../../core/test-harness-crash.js';
import { BuildError } from '../../errors/build.js';
import {
  deriveAggregateShardVerdict,
  finalizeShardedOutcome,
  type ShardedRunSummary,
  type ShardOutcome,
} from '../test-run.js';
import { resetVerdictEmission } from '../test-verdict.js';

function shard(label: string, kind: HarnessRunVerdict['kind']): ShardOutcome {
  return {
    label,
    outcome: {
      result: { exitCode: kind === 'tests-ran-ok' ? 0 : 1, stdout: '', stderr: '' },
      verdict: { kind },
      attempts: 1,
      appdirInjectionAttempted: false,
    },
  };
}

beforeEach(() => {
  resetVerdictEmission();
});

describe('deriveAggregateShardVerdict', () => {
  it('reports tests-ran-ok when every shard passed', () => {
    expect(
      deriveAggregateShardVerdict([shard('a', 'tests-ran-ok'), shard('b', 'tests-ran-ok')])
    ).toEqual({ kind: 'tests-ran-ok' });
  });

  it('a crashed shard outranks every other failure kind', () => {
    expect(
      deriveAggregateShardVerdict([
        shard('a', 'test-failures'),
        shard('b', 'harness-crash'),
        shard('c', 'no-tests'),
      ])
    ).toEqual({ kind: 'harness-crash' });
  });

  it('a no-tests shard outranks plain test failures', () => {
    expect(
      deriveAggregateShardVerdict([shard('a', 'no-tests'), shard('b', 'test-failures')])
    ).toEqual({ kind: 'no-tests' });
  });

  it('only failing shards of one kind report that kind', () => {
    expect(
      deriveAggregateShardVerdict([shard('a', 'tests-ran-ok'), shard('b', 'test-failures')])
    ).toEqual({ kind: 'test-failures' });
  });
});

describe('finalizeShardedOutcome', () => {
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

  function summaryOf(shards: ShardOutcome[]): ShardedRunSummary {
    const passed = shards.filter(({ outcome }) => outcome.verdict.kind === 'tests-ran-ok').length;
    return { shards, passed, total: shards.length, aggregate: deriveAggregateShardVerdict(shards) };
  }

  it('emits the classified aggregate verdict, then throws the aggregate error', () => {
    const capture = captureStdout();
    try {
      expect(() => {
        finalizeShardedOutcome(
          summaryOf([shard('a', 'harness-crash'), shard('b', 'tests-ran-ok')])
        );
      }).toThrow(BuildError);
    } finally {
      capture.restore();
    }
    expect(capture.writes).toEqual(['FIREFORGE-VERDICT: FAIL reason=crash shards=1/2\n']);
  });

  it('names the failing shard labels in the aggregate error', () => {
    const capture = captureStdout();
    try {
      expect(() => {
        finalizeShardedOutcome(summaryOf([shard('a', 'no-tests'), shard('b', 'tests-ran-ok')]));
      }).toThrow(/1 of 2 sharded test run\(s\) did not pass: a\./);
    } finally {
      capture.restore();
    }
    expect(capture.writes).toEqual(['FIREFORGE-VERDICT: FAIL reason=no-tests shards=1/2\n']);
  });

  it('an all-pass summary emits PASS and returns', () => {
    const capture = captureStdout();
    try {
      finalizeShardedOutcome(summaryOf([shard('a', 'tests-ran-ok'), shard('b', 'tests-ran-ok')]));
    } finally {
      capture.restore();
    }
    expect(capture.writes).toEqual(['FIREFORGE-VERDICT: PASS shards=2/2\n']);
  });
});
