// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/logger.js', () => ({ info: vi.fn(), setStdoutSealed: vi.fn() }));

import { nativeAbsPath } from '../../test-utils/index.js';
import { info } from '../../utils/logger.js';
import { buildPerfSampleEnv, mergeHarnessEnv, resolveShuffleSeed } from '../test-harness-env.js';
import { resetVerdictEmission } from '../test-verdict.js';

beforeEach(() => {
  vi.mocked(info).mockClear();
  resetVerdictEmission();
});

describe('resolveShuffleSeed', () => {
  it('returns undefined when --shuffle was not given', () => {
    expect(resolveShuffleSeed(undefined, 'mochitest')).toBeUndefined();
    expect(resolveShuffleSeed(false, 'mochitest')).toBeUndefined();
    expect(info).not.toHaveBeenCalled();
  });

  it('replays an operator-supplied seed verbatim and prints the repro command', () => {
    expect(resolveShuffleSeed(42, 'mochitest')).toBe(42);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('--shuffle=42'));
  });

  it('draws a fresh positive seed for a bare --shuffle', () => {
    const seed = resolveShuffleSeed(true, 'mochitest');
    expect(seed).toBeGreaterThan(0);
    expect(Number.isInteger(seed)).toBe(true);
  });

  it.each(['xpcshell', 'generic'] as const)('refuses the %s suite', (suite) => {
    expect(() => resolveShuffleSeed(1, suite)).toThrow(/--shuffle forwards the mochitest harness/);
  });
});

describe('mergeHarnessEnv', () => {
  it('returns undefined when no part exported anything', () => {
    expect(mergeHarnessEnv(undefined, undefined)).toBeUndefined();
    expect(mergeHarnessEnv()).toBeUndefined();
  });

  it('merges the defined parts', () => {
    expect(mergeHarnessEnv({ A: '1' }, undefined, { B: '2' })).toEqual({ A: '1', B: '2' });
  });
});

describe('buildPerfSampleEnv', () => {
  it('is undefined without --perf-samples', () => {
    expect(buildPerfSampleEnv('/project', 'mybrowser', undefined)).toBeUndefined();
  });

  it('publishes the resolved artifact path under <BINARYNAME>_PERF_SAMPLE_JSON', () => {
    expect(buildPerfSampleEnv('/project', 'my-browser', 'artifacts/perf.json')).toEqual({
      MY_BROWSER_PERF_SAMPLE_JSON: nativeAbsPath('/project/artifacts/perf.json'),
    });
  });
});
