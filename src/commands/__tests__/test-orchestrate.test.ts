// SPDX-License-Identifier: EUPL-1.2
/**
 * `orchestrateTestRuns` with an injected single-run body: mixed harness
 * splitting, `--repeat`, and `--negative-control` against a real temp
 * project, so the control's apply/restore is exercised for real. The
 * command-level composition (one build, union coverage) is covered in
 * test-staleness-coverage.test.ts and test-xpcshell-appdir.test.ts.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/logger.js', async () =>
  (await import('./test-command-mocks.js')).loggerMock()
);
vi.mock('../../core/run-log.js', async () =>
  (await import('../../test-utils/module-mocks.js')).createRunLogMock()
);
vi.mock('../../core/xpcshell-appdir.js', async () =>
  (await import('./test-command-mocks.js')).xpcshellAppdirMock()
);

import { findNearestXpcshellManifest } from '../../core/xpcshell-appdir.js';
import { InvalidArgumentError, PreflightRefusalError } from '../../errors/base.js';
import { TestFailureError } from '../../errors/build.js';
import { createTempProject, removeTempProject, writeFiles } from '../../test-utils/index.js';
import type { TestOptions } from '../../types/commands/index.js';
import { info, success } from '../../utils/logger.js';
import { orchestrateTestRuns, type TestRunBody } from '../test-orchestrate.js';
import {
  emitFailVerdict,
  emitHarnessVerdict,
  emitKilledVerdict,
  resetVerdictEmission,
  verdictEmitted,
} from '../test-verdict.js';

const TARGET = 'browser/modules/Check.sys.mjs';
const SOURCE = 'export function check() {\n  return true;\n}\n';
const NEUTERED = 'export function check() {\n  return false;\n}\n';
const DIFF =
  `diff --git a/engine/${TARGET} b/engine/${TARGET}\n--- a/engine/${TARGET}\n+++ b/engine/${TARGET}\n` +
  '@@ -1,3 +1,3 @@\n export function check() {\n-  return true;\n+  return false;\n }\n';

let root: string;
let writes: string[];

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(findNearestXpcshellManifest).mockResolvedValue(null);
  resetVerdictEmission();
  root = await createTempProject('fireforge-orchestrate-');
  await writeFiles(root, { [`engine/${TARGET}`]: SOURCE, 'control.diff': DIFF });
  writes = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
    writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await removeTempProject(root);
});

const lines = (prefix: string): string[] =>
  writes.filter((write) => write.startsWith(prefix)).map((write) => write.trimEnd());

const onRefusal = (error: unknown): void => {
  emitFailVerdict('preflight', error instanceof PreflightRefusalError ? error.note : undefined);
};

function pass(): Promise<void> {
  emitHarnessVerdict({ kind: 'tests-ran-ok', checks: 2 });
  return Promise.resolve();
}

function red(): Promise<void> {
  emitHarnessVerdict({ kind: 'test-failures', checks: 2, unexpected: 1 });
  return Promise.reject(new TestFailureError('red'));
}

function run(paths: string[], options: TestOptions, body: TestRunBody): Promise<void> {
  return orchestrateTestRuns(root, paths, options, body, onRefusal);
}

describe('orchestrateTestRuns', () => {
  it('runs a plain request through the body once, untouched', async () => {
    const body = vi.fn<TestRunBody>(() => pass());
    await run(['a.js'], { build: true }, body);
    expect(body).toHaveBeenCalledExactlyOnceWith(['a.js'], { build: true }, {});
    expect(lines('FIREFORGE-RUN')).toEqual([]);
    expect(lines('FIREFORGE-VERDICT')).toEqual(['FIREFORGE-VERDICT: PASS checks=2']);
  });

  it('--repeat runs n times, building and probing once, and aggregates', async () => {
    const body = vi.fn<TestRunBody>(() => pass());
    await run(['a.js'], { repeat: 3, build: true, doctor: true, headless: true }, body);
    expect(body.mock.calls.map(([, options]) => options)).toEqual([
      { repeat: 3, build: true, doctor: true, headless: true },
      { repeat: 3, headless: true },
      { repeat: 3, headless: true },
    ]);
    expect(lines('FIREFORGE-RUN')).toEqual([
      'FIREFORGE-RUN: PASS checks=2 run=1/3',
      'FIREFORGE-RUN: PASS checks=2 run=2/3',
      'FIREFORGE-RUN: PASS checks=2 run=3/3',
    ]);
    expect(lines('FIREFORGE-VERDICT')).toEqual(['FIREFORGE-VERDICT: PASS runs=3/3']);
  });

  it('--repeat reports each red run and fails the aggregate', async () => {
    const body = vi
      .fn<TestRunBody>(() => pass())
      .mockImplementationOnce(() => pass())
      .mockImplementationOnce(() => red());
    await expect(run(['a.js'], { repeat: 3 }, body)).rejects.toThrow(
      /1 of 3 run\(s\) did not pass: run 2 \(test-failures\)/
    );
    expect(lines('FIREFORGE-RUN')[1]).toBe(
      'FIREFORGE-RUN: FAIL reason=test-failures checks=2 unexpected=1 run=2/3'
    );
    expect(lines('FIREFORGE-VERDICT')).toEqual([
      'FIREFORGE-VERDICT: FAIL reason=test-failures runs=2/3',
    ]);
  });

  it('stops at a preflight refusal and rethrows it', async () => {
    const refusal = new PreflightRefusalError('stale', 'stale-build');
    const body = vi.fn<TestRunBody>(() => Promise.reject(refusal));
    await expect(run(['a.js'], { repeat: 3 }, body)).rejects.toBe(refusal);
    expect(body).toHaveBeenCalledTimes(1);
    expect(lines('FIREFORGE-RUN')).toEqual([
      'FIREFORGE-RUN: FAIL reason=preflight note=stale-build run=1/3',
    ]);
    expect(lines('FIREFORGE-VERDICT')).toEqual([
      'FIREFORGE-VERDICT: FAIL reason=preflight note=stale-build runs=0/3',
    ]);
    expect(verdictEmitted()).toBe(true);
  });

  it('splits mixed harness paths, xpcshell first, with union coverage on the first run', async () => {
    vi.mocked(findNearestXpcshellManifest).mockImplementation((_engineDir, path) =>
      Promise.resolve(path.includes('/unit/') ? '/x/xpcshell.toml' : null)
    );
    const body = vi.fn<TestRunBody>(() => pass());
    await run(['engine/b/browser_a.js', 'u/unit/test_a.js'], { build: true }, body);
    expect(body.mock.calls).toEqual([
      [
        ['u/unit/test_a.js'],
        { build: true },
        { repetition: 1, coveragePaths: ['u/unit/test_a.js', 'b/browser_a.js'] },
      ],
      [['b/browser_a.js'], {}, { repetition: 1 }],
    ]);
    expect(lines('FIREFORGE-RUN')).toEqual([
      'FIREFORGE-RUN: PASS checks=2 run=1/2 harness=xpcshell',
      'FIREFORGE-RUN: PASS checks=2 run=2/2 harness=mochitest',
    ]);
    expect(lines('FIREFORGE-VERDICT')).toEqual(['FIREFORGE-VERDICT: PASS runs=2/2']);
  });

  it('never splits --build-only or --canary requests', async () => {
    vi.mocked(findNearestXpcshellManifest).mockImplementation((_engineDir, path) =>
      Promise.resolve(path.includes('/unit/') ? '/x/xpcshell.toml' : null)
    );
    const body = vi.fn<TestRunBody>(() => pass());
    await run(['b/browser_a.js', 'u/unit/test_a.js'], { buildOnly: true }, body);
    expect(body).toHaveBeenCalledTimes(1);
    expect(findNearestXpcshellManifest).not.toHaveBeenCalled();
  });

  it.each([
    [[], { repeat: 2 }, /--repeat needs explicit test paths/],
    [['a.js'], { repeat: 2, buildOnly: true }, /cannot be combined with --build-only/],
    [['a.js'], { negativeControl: 'control.diff', canary: true }, /--negative-control runs tests/],
    [['a.js'], { repeat: 2, auto: true }, /--repeat runs tests/],
  ] as const)('refuses %j with %j', async (paths, options, message) => {
    const body = vi.fn<TestRunBody>(() => pass());
    const error = await run([...paths], options, body).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvalidArgumentError);
    expect((error as Error).message).toMatch(message);
    expect(body).not.toHaveBeenCalled();
  });
});

describe('--negative-control', () => {
  const engineFile = (): Promise<string> => readFile(join(root, 'engine', TARGET), 'utf8');

  /** A body that dispatches like the real one: hook first, then the harness. */
  function dispatching(outcome: () => Promise<void>): TestRunBody {
    return async (_paths, _options, hooks) => {
      await hooks.beforeDispatch?.();
      expect(await engineFile()).toBe(NEUTERED);
      await outcome();
    };
  }

  it('applies before dispatch, restores after, and reports a caught control', async () => {
    await run(['a.js'], { negativeControl: 'control.diff' }, dispatching(red));
    expect(await engineFile()).toBe(SOURCE);
    expect(lines('FIREFORGE-VERDICT')).toEqual([
      'FIREFORGE-VERDICT: FAIL reason=test-failures checks=2 unexpected=1 control=caught',
    ]);
    expect(success).toHaveBeenCalledWith('Negative control caught.');
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/restored byte-exact: 1 file/));
  });

  it('a control that stays green fails the invocation as missed', async () => {
    await expect(
      run(['a.js'], { negativeControl: 'control.diff' }, dispatching(pass))
    ).rejects.toThrow(/Negative control stayed green/);
    expect(await engineFile()).toBe(SOURCE);
    expect(lines('FIREFORGE-VERDICT')).toEqual(['FIREFORGE-VERDICT: PASS checks=2 control=missed']);
  });

  it('a crash makes the control inconclusive', async () => {
    const crash = (): Promise<void> => {
      emitHarnessVerdict({ kind: 'harness-crash' });
      return Promise.reject(new Error('crashed'));
    };
    await expect(
      run(['a.js'], { negativeControl: 'control.diff' }, dispatching(crash))
    ).rejects.toThrow(TestFailureError);
    expect(await engineFile()).toBe(SOURCE);
    expect(lines('FIREFORGE-VERDICT')).toEqual([
      'FIREFORGE-VERDICT: FAIL reason=crash control=inconclusive',
    ]);
  });

  it('is restored even when a later gate refuses after the apply', async () => {
    const body: TestRunBody = async (_paths, _options, hooks) => {
      await hooks.beforeDispatch?.();
      throw new PreflightRefusalError('late', 'late-gate');
    };
    await expect(run(['a.js'], { negativeControl: 'control.diff' }, body)).rejects.toThrow('late');
    expect(await engineFile()).toBe(SOURCE);
    expect(lines('FIREFORGE-VERDICT')).toEqual([
      'FIREFORGE-VERDICT: FAIL reason=preflight note=late-gate control=inconclusive',
    ]);
  });

  it('applies and restores around every repetition; caught only when every one goes red', async () => {
    let calls = 0;
    const body = dispatching(() => (++calls === 2 ? pass() : red()));
    await expect(
      run(['a.js'], { negativeControl: 'control.diff', repeat: 3 }, body)
    ).rejects.toThrow(/stayed green/);
    expect(calls).toBe(3);
    expect(await engineFile()).toBe(SOURCE);
    expect(lines('FIREFORGE-VERDICT')).toEqual([
      'FIREFORGE-VERDICT: FAIL reason=test-failures runs=1/3 control=missed',
    ]);
  });

  it('a kill mid-run restores, starts nothing more, and prints nothing after the killed line', async () => {
    const body = vi.fn<TestRunBody>(async (_paths, _options, hooks) => {
      await hooks.beforeDispatch?.();
      emitKilledVerdict('SIGTERM');
      throw new Error('harness terminated');
    });
    await expect(
      run(['a.js'], { negativeControl: 'control.diff', repeat: 3 }, body)
    ).rejects.toThrow('harness terminated');
    expect(body).toHaveBeenCalledTimes(1);
    expect(await engineFile()).toBe(SOURCE);
    expect(writes.filter((write) => write.startsWith('FIREFORGE-'))).toEqual([
      'FIREFORGE-VERDICT: FAIL reason=killed signal=SIGTERM\n',
    ]);
  });

  it('refuses a control whose diff does not apply before any run', async () => {
    await writeFile(join(root, 'engine', TARGET), 'unrelated\n');
    const body = vi.fn<TestRunBody>(() => pass());
    await expect(run(['a.js'], { negativeControl: 'control.diff' }, body)).rejects.toMatchObject({
      note: 'negative-control',
    });
    expect(body).not.toHaveBeenCalled();
  });

  it('a file edited under the control is kept and the invocation is inconclusive', async () => {
    const body: TestRunBody = async (_paths, _options, hooks) => {
      await hooks.beforeDispatch?.();
      await writeFile(join(root, 'engine', TARGET), 'peer edit\n');
      await red();
    };
    await expect(run(['a.js'], { negativeControl: 'control.diff' }, body)).rejects.toThrow(
      /left 1 file\(s\) alone/
    );
    expect(await engineFile()).toBe('peer edit\n');
    expect(lines('FIREFORGE-VERDICT')).toEqual([
      'FIREFORGE-VERDICT: FAIL reason=inconclusive note=negative-control-restore',
    ]);
  });

  it('recovers a control a killed run left applied before running anything', async () => {
    const { applyNegativeControl, planNegativeControl } =
      await import('../../core/negative-control.js');
    const paths = { engineDir: join(root, 'engine'), fireforgeDir: join(root, '.fireforge') };
    await applyNegativeControl(
      paths,
      await planNegativeControl(root, paths.engineDir, 'control.diff')
    );
    expect(await engineFile()).toBe(NEUTERED);
    const body = vi.fn<TestRunBody>(async () => {
      expect(await engineFile()).toBe(SOURCE);
      await pass();
    });
    await run(['a.js'], {}, body);
    expect(body).toHaveBeenCalledTimes(1);
  });

  describe('on compiled source', () => {
    const CPP = 'gfx/apz/Controller.cpp';
    const cppFile = (): Promise<string> => readFile(join(root, 'engine', CPP), 'utf8');

    beforeEach(async () => {
      await writeFiles(root, {
        [`engine/${CPP}`]: SOURCE,
        'cpp.diff': DIFF.replaceAll(TARGET, CPP),
      });
    });

    it('is refused without --build, before any run', async () => {
      const body = vi.fn<TestRunBody>(() => pass());
      await expect(run(['a.js'], { negativeControl: 'cpp.diff' }, body)).rejects.toThrow(
        /edits compiled source.*Add --build/s
      );
      expect(body).not.toHaveBeenCalled();
    });

    it('goes in before the first build, stays for later runs, and marks the verdict', async () => {
      const seen: string[] = [];
      const body = vi.fn<TestRunBody>(async (_paths, _options, hooks) => {
        seen.push(hooks.beforeBuild === undefined ? 'dispatch' : 'build');
        await hooks.beforeBuild?.();
        await hooks.beforeDispatch?.();
        expect(await cppFile()).toBe(NEUTERED);
        await red();
      });
      await run(['a.js'], { negativeControl: 'cpp.diff', build: true, repeat: 2 }, body);
      expect(seen).toEqual(['build', 'dispatch']);
      expect(await cppFile()).toBe(SOURCE);
      expect(lines('FIREFORGE-VERDICT')[0]).toContain('control=caught');
      expect(lines('FIREFORGE-VERDICT')[0]).toContain('control-build=compiled');
    });
  });
});
