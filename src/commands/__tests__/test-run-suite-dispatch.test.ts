// SPDX-License-Identifier: EUPL-1.2
/**
 * Regression coverage for item E1 (0.32.0): a single-suite `fireforge test`
 * run dispatches to the suite-specific mach command (`mach xpcshell-test` /
 * `mach mochitest`) — which skips the mozlog resource monitor that crashes
 * generic `mach test` on a broken host — and reaches a passing test instead
 * of exhausting the harness-crash retry budget. `--generic-mach-test` opts
 * back into the generic command.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mochitestWithOutput, testWithOutput, xpcshellTestWithOutput } from '../../core/mach.js';
import { runTestsWithRetries, type TestRunContext, type TestSuite } from '../test-run.js';

vi.mock('../../core/mach.js', () => ({
  testWithOutput: vi.fn(),
  xpcshellTestWithOutput: vi.fn(),
  mochitestWithOutput: vi.fn(),
}));

vi.mock('../test-appdir.js', () => ({
  maybeInjectAppdirArg: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('../../utils/logger.js', () => ({
  info: vi.fn(),
  note: vi.fn(),
  warn: vi.fn(),
}));

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
    vi.mocked(xpcshellTestWithOutput).mockResolvedValue(GREEN);

    const outcome = await runTestsWithRetries(makeCtx('xpcshell'), ['a_test.js']);

    expect(xpcshellTestWithOutput).toHaveBeenCalledWith('/engine', ['a_test.js'], []);
    expect(testWithOutput).not.toHaveBeenCalled();
    expect(mochitestWithOutput).not.toHaveBeenCalled();
    expect(outcome.verdict.kind).toBe('tests-ran-ok');
  });

  it('dispatches a mochitest-suite run to mach mochitest', async () => {
    vi.mocked(mochitestWithOutput).mockResolvedValue(GREEN);

    const outcome = await runTestsWithRetries(makeCtx('mochitest'), ['browser_x.js']);

    expect(mochitestWithOutput).toHaveBeenCalledWith('/engine', ['browser_x.js'], []);
    expect(testWithOutput).not.toHaveBeenCalled();
    expect(outcome.verdict.kind).toBe('tests-ran-ok');
  });

  it('routes the generic suite (and --generic-mach-test) to mach test', async () => {
    vi.mocked(testWithOutput).mockResolvedValue(GREEN);

    await runTestsWithRetries(makeCtx('generic'), ['a_test.js']);

    expect(testWithOutput).toHaveBeenCalledWith('/engine', ['a_test.js'], []);
    expect(xpcshellTestWithOutput).not.toHaveBeenCalled();
    expect(mochitestWithOutput).not.toHaveBeenCalled();
  });

  it('reaches a passing test via the suite command where generic mach test would crash', async () => {
    // Generic `mach test` crashes on every attempt (resource monitor) and
    // exhausts the retry budget...
    vi.mocked(testWithOutput).mockResolvedValue(RESOURCE_MONITOR_CRASH);
    const generic = await runTestsWithRetries(makeCtx('generic', 2), ['a_test.js']);
    expect(generic.verdict.kind).toBe('harness-crash');
    expect(generic.attempts).toBe(3);

    // ...while the suite-specific command (which skips ResourceHandler) passes.
    vi.mocked(xpcshellTestWithOutput).mockResolvedValue(GREEN);
    const suite = await runTestsWithRetries(makeCtx('xpcshell', 2), ['a_test.js']);
    expect(suite.verdict.kind).toBe('tests-ran-ok');
    expect(suite.attempts).toBe(1);
  });
});
