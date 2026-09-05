// SPDX-License-Identifier: EUPL-1.2
/**
 * A single-suite `fireforge test` run dispatches to the suite-specific mach
 * command (`mach xpcshell-test` / `mach mochitest`), which skips the mozlog
 * resource monitor that crashes generic `mach test` on a broken host, and
 * reaches a passing test instead of exhausting the harness-crash retry
 * budget. `--generic-mach-test` opts back into the generic command.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runMachTestSuite } from '../../core/mach.js';
import { createLoggerMock } from '../../test-utils/module-mocks.js';
import { runTestsWithRetries, type TestRunContext, type TestSuite } from '../test-run.js';

vi.mock('../../core/mach.js', () => ({
  runMachTestSuite: vi.fn(),
}));

vi.mock('../test-appdir.js', () => ({
  maybeInjectAppdirArg: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('../../utils/logger.js', () => createLoggerMock());

const GREEN = { exitCode: 0, stdout: 'TEST-START | t\nTEST-PASS | t\n', stderr: '' };
// The exact macOS mozlog resource-monitor startup traceback that aborts
// generic `mach test` before any test runs.
const RESOURCE_MONITOR_CRASH = {
  exitCode: 1,
  stdout: '',
  stderr: [
    'Traceback (most recent call last):',
    "AttributeError: 'SystemResourceMonitor' object has no attribute 'poll_interval'",
  ].join('\n'),
};

function makeCtx(suite: TestSuite, harnessRetries = 0): TestRunContext {
  return {
    engineDir: '/engine',
    objDir: 'obj-debug',
    classification: { xpcshell: [], nonXpcshell: [] },
    suite,
    baseExtraArgs: [],
    harnessRetries,
    headless: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runTestsWithRetries suite dispatch (item E1)', () => {
  it('dispatches an xpcshell-suite run to mach xpcshell-test', async () => {
    vi.mocked(runMachTestSuite).mockResolvedValue(GREEN);

    const outcome = await runTestsWithRetries(makeCtx('xpcshell'), ['a_test.js']);

    expect(runMachTestSuite).toHaveBeenCalledTimes(1);
    expect(runMachTestSuite).toHaveBeenCalledWith('xpcshell-test', {
      engineDir: '/engine',
      testPaths: ['a_test.js'],
      args: [],
      env: expect.objectContaining({
        XPCSHELL_TEST_PROFILE_DIR: expect.any(String) as string,
      }) as Record<string, string>,
    });
    expect(outcome.verdict.kind).toBe('tests-ran-ok');
  });

  it('dispatches a mochitest-suite run to mach mochitest', async () => {
    vi.mocked(runMachTestSuite).mockResolvedValue(GREEN);

    const outcome = await runTestsWithRetries(makeCtx('mochitest'), ['browser_x.js']);

    expect(runMachTestSuite).toHaveBeenCalledTimes(1);
    expect(runMachTestSuite).toHaveBeenCalledWith('mochitest', {
      engineDir: '/engine',
      testPaths: ['browser_x.js'],
      args: [],
    });
    expect(outcome.verdict.kind).toBe('tests-ran-ok');
  });

  it('routes the generic suite (and --generic-mach-test) to mach test', async () => {
    vi.mocked(runMachTestSuite).mockResolvedValue(GREEN);

    await runTestsWithRetries(makeCtx('generic'), ['a_test.js']);

    expect(runMachTestSuite).toHaveBeenCalledTimes(1);
    expect(runMachTestSuite).toHaveBeenCalledWith('test', {
      engineDir: '/engine',
      testPaths: ['a_test.js'],
      args: [],
      env: expect.objectContaining({
        XPCSHELL_TEST_PROFILE_DIR: expect.any(String) as string,
      }) as Record<string, string>,
    });
  });

  it('reaches a passing test via the suite command where generic mach test would crash', async () => {
    // Generic `mach test` crashes on every attempt (resource monitor) and
    // exhausts the retry budget...
    vi.mocked(runMachTestSuite).mockImplementation((kind) =>
      Promise.resolve(kind === 'test' ? RESOURCE_MONITOR_CRASH : GREEN)
    );
    const generic = await runTestsWithRetries(makeCtx('generic', 2), ['a_test.js']);
    expect(generic.verdict.kind).toBe('harness-crash');
    expect(generic.attempts).toBe(3);

    // ...while the suite-specific command (which skips ResourceHandler) passes.
    const suite = await runTestsWithRetries(makeCtx('xpcshell', 2), ['a_test.js']);
    expect(suite.verdict.kind).toBe('tests-ran-ok');
    expect(suite.attempts).toBe(1);
  });
});

/**
 * Firefox's xpcshell harness defaults its profile dir to a fixed $TMPDIR
 * path, so concurrent invocations collide. Every harness invocation that can
 * dispatch xpcshell exports a fresh per-invocation
 * XPCSHELL_TEST_PROFILE_DIR. Pure mochitest dispatches stay untouched.
 */
describe('per-invocation xpcshell profile dir', () => {
  function capturedEnv(call = 0): Record<string, string> {
    return vi.mocked(runMachTestSuite).mock.calls[call]?.[1]?.env ?? {};
  }

  it('exports a fresh, unique dir per xpcshell harness invocation', async () => {
    vi.mocked(runMachTestSuite).mockResolvedValue(GREEN);

    await runTestsWithRetries(makeCtx('xpcshell'), ['a_test.js']);
    await runTestsWithRetries(makeCtx('xpcshell'), ['b_test.js']);

    const first = capturedEnv(0)['XPCSHELL_TEST_PROFILE_DIR'];
    const second = capturedEnv(1)['XPCSHELL_TEST_PROFILE_DIR'];
    expect(first).toContain('fireforge-xpcshell-profile-');
    expect(second).toContain('fireforge-xpcshell-profile-');
    expect(first).not.toBe(second);
  });

  it('leaves a pure mochitest dispatch env byte-identical (no profile var)', async () => {
    vi.mocked(runMachTestSuite).mockResolvedValue(GREEN);

    await runTestsWithRetries(makeCtx('mochitest'), ['browser_x.js']);

    // No env at all. The dispatch shape is unchanged.
    expect(vi.mocked(runMachTestSuite).mock.calls[0]?.[1]?.env).toBeUndefined();
  });

  it('crash retries within one invocation reuse the SAME profile dir', async () => {
    vi.mocked(runMachTestSuite)
      .mockResolvedValueOnce(RESOURCE_MONITOR_CRASH)
      .mockResolvedValueOnce(GREEN);

    const outcome = await runTestsWithRetries(makeCtx('xpcshell', 1), ['a_test.js']);

    expect(outcome.attempts).toBe(2);
    const first = capturedEnv(0)['XPCSHELL_TEST_PROFILE_DIR'];
    const second = capturedEnv(1)['XPCSHELL_TEST_PROFILE_DIR'];
    expect(first).toBe(second);
  });

  it('respects an operator-provided XPCSHELL_TEST_PROFILE_DIR verbatim', async () => {
    vi.mocked(runMachTestSuite).mockResolvedValue(GREEN);

    const ctx = { ...makeCtx('xpcshell'), env: { XPCSHELL_TEST_PROFILE_DIR: '/operator/dir' } };
    await runTestsWithRetries(ctx, ['a_test.js']);

    expect(capturedEnv()['XPCSHELL_TEST_PROFILE_DIR']).toBe('/operator/dir');
  });

  it('preserves caller env vars alongside the minted profile dir', async () => {
    vi.mocked(runMachTestSuite).mockResolvedValue(GREEN);

    const ctx = { ...makeCtx('xpcshell'), env: { MOZ_SAMPLE: '1' } };
    await runTestsWithRetries(ctx, ['a_test.js']);

    const env = capturedEnv();
    expect(env['MOZ_SAMPLE']).toBe('1');
    expect(env['XPCSHELL_TEST_PROFILE_DIR']).toContain('fireforge-xpcshell-profile-');
  });
});
