// SPDX-License-Identifier: EUPL-1.2
/**
 * Whole test runs in a synthetic workspace whose stand-in `mach` plays the
 * harness: it prints scripted output, writes the raw log where `--log-raw`
 * says, and can leave a helper behind. A control's mutation edits the
 * script the stand-in follows, which is what a real mutation does to the
 * behaviour a test observes.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { Workspace } from '../engine/index.js';
import { isProcessAlive } from '../kernel/process/index.js';
import { resetShutdown, runShutdown } from '../kernel/signals.js';
import { useMachSandbox } from '../testing/engine.js';
import { type MachScript, readMachLog, scriptMach } from '../testing/firefox.js';
import {
  harnessScript,
  makeTestWorkspace,
  TEST_PATHS,
  writeScriptMutation,
} from '../testing/harness.js';
import { useTempDir, writeTree } from '../testing/temp.js';
import { runControl } from './control.js';
import { planTests, type TestRequest } from './plan.js';
import { runTests, type TestRunResult } from './run.js';
import { controlReport, runReport } from './verdict.js';

const dir = useTempDir();
useMachSandbox();

const { browserDir: FORK, browserA: A, browserB: B, xpcshellX: X, xpcshellY: Y } = TEST_PATHS;
const SCRIPT = '.mach-state/script-mochitest.json';
const xpcshell = (files: readonly string[]): MachScript => harnessScript(files, {}, 'xpcshell');

async function runRequest(
  ws: Workspace,
  request: TestRequest,
  options = {}
): Promise<TestRunResult> {
  return runTests(ws, await planTests(ws.engineDir, request), options);
}

const calls = async (ws: Workspace, command: string): Promise<string[][]> =>
  (await readMachLog(ws.engineDir))
    .filter((call) => call.args[0] === command)
    .map((call) => call.args);

describe('runTests', () => {
  it('passes a green browser-chrome file, judged from its raw log, and records the run', async () => {
    const ws = await makeTestWorkspace(dir());
    await scriptMach(ws.engineDir, 'mochitest', harnessScript([A]));
    const result = await runRequest(ws, { paths: [A] });
    expect(result).toMatchObject({ pass: true, reaped: 0 });
    expect(result.dispatches[0]?.files).toEqual([
      {
        test: A,
        run: 1,
        dispatch: 1,
        planned: true,
        started: true,
        finished: true,
        status: 'OK',
        expected: 'OK',
        unexpected: false,
        durationMs: 400,
        failures: [],
      },
    ]);
    const [args] = await calls(ws, 'mochitest');
    expect(args?.[1]).toBe('--headless');
    expect(args?.some((arg) => arg.startsWith('--log-raw='))).toBe(true);
    expect(args?.at(-1)).toBe(A);
    const env = (await readMachLog(ws.engineDir)).at(-1)?.env ?? {};
    expect(env['FIREFORGE_TEST_ENGINE']).toBe(ws.engineDir);
    expect(env['FIREFORGE_TEST_RUN']).toMatch(/^\d{8}T\d{6}-/);
    expect(await readFile(result.log, 'utf8')).toContain(`TEST_START: ${A}`);
    const report = runReport(result, { results: '/r.json' });
    expect(report.fields).toMatchObject({ checks: 3, unexpected: 0, results: '/r.json' });
    expect(report.failure).toBeUndefined();
  });

  it('gives each browser file its own browser and reports a red with its assertion label', async () => {
    const ws = await makeTestWorkspace(dir());
    await scriptMach(ws.engineDir, 'mochitest', {
      byArg: {
        [A]: harnessScript([A]),
        [B]: harnessScript([B], { [B]: 'the tile keeps its size' }),
      },
    });
    const result = await runRequest(ws, { paths: [FORK] });
    expect(result).toMatchObject({ pass: false, reason: 'test-failures' });
    expect(result.dispatches.map((entry) => entry.verdict.kind)).toEqual(['pass', 'test-failures']);
    expect(result.dispatches[1]?.files[0]?.failures).toEqual([
      { assertion: 'the tile keeps its size', status: 'FAIL', expected: 'PASS' },
    ]);
    const report = runReport(result);
    expect(report.fields).toMatchObject({ reason: 'test-failures', shards: '1/2' });
    expect(report.failure).toMatchObject({ code: 'test-failure', exitCode: 5 });
    expect(report.lines.join('\n')).toContain(`${B}: FAIL (expected PASS) the tile keeps its size`);
  });

  it('runs browser files in one browser, or restarting between them, and fails a file that never started', async () => {
    const ws = await makeTestWorkspace(dir());
    const partial = harnessScript([A]);
    await scriptMach(ws.engineDir, 'mochitest', partial);
    const result = await runRequest(ws, { paths: [A, B], dispatch: 'one-browser' });
    expect(result.reason).toBe('test-failures');
    expect(result.dispatches[0]?.verdict.incomplete).toMatchObject({
      firstUnstarted: B,
      startedSource: 'raw',
    });
    expect(result.dispatches[0]?.files.find((file) => file.test === B)).toMatchObject({
      started: false,
      finished: false,
    });
    expect(runReport(result).fields).toMatchObject({ started: '1/2', 'first-unstarted': B });

    await scriptMach(ws.engineDir, 'mochitest', harnessScript([A, B]));
    expect((await runRequest(ws, { paths: [FORK], dispatch: 'standalone' })).pass).toBe(true);
    const last = (await calls(ws, 'mochitest')).at(-1) ?? [];
    expect(last).toContain('--restart-between-tests');
    expect(last.slice(-2)).toEqual([A, B]);
  });

  it('runs xpcshell files in one invocation with a profile of their own', async () => {
    const ws = await makeTestWorkspace(dir());
    await scriptMach(ws.engineDir, 'xpcshell-test', xpcshell([X, Y]));
    const result = await runRequest(ws, {
      paths: [TEST_PATHS.xpcshellDir],
      env: { SUITE_SETTING: 'on' },
    });
    expect(result.pass).toBe(true);
    const call = (await readMachLog(ws.engineDir)).at(-1);
    expect(call?.args.slice(-2)).toEqual([X, Y]);
    expect(call?.args).not.toContain('--headless');
    expect(call?.env['XPCSHELL_TEST_PROFILE_DIR']).toContain('fireforge-xpcshell-profile-');
    expect(call?.env['SUITE_SETTING']).toBe('on');
  });

  it('retries a recognized harness crash and reports it once the retries are spent', async () => {
    const ws = await makeTestWorkspace(dir());
    await scriptMach(ws.engineDir, 'xpcshell-test', {
      stderr: [
        'Traceback (most recent call last):',
        "AttributeError: 'SystemResourceMonitor' object has no attribute 'poll_interval'",
      ],
      exit: 1,
    });
    const result = await runRequest(ws, { paths: [X] });
    expect(result).toMatchObject({ pass: false, reason: 'crash' });
    expect(result.dispatches[0]?.attempts).toBe(3);
    expect(await calls(ws, 'xpcshell-test')).toHaveLength(3);
    expect(runReport(result).lines.join('\n')).toContain('on all 3 attempt(s)');
  });

  it('reads a hang before any test as a crash, and a run with no test start as no-tests', async () => {
    const ws = await makeTestWorkspace(dir());
    await scriptMach(ws.engineDir, 'xpcshell-test', {
      stdout: [' 6:14.77 ERROR timed out after 370 seconds with no output', 'Passed: 0'],
      exit: 1,
    });
    expect((await runRequest(ws, { paths: [X] })).dispatches[0]?.verdict.signature?.reason).toBe(
      'no-output timeout before any test started'
    );
    await scriptMach(ws.engineDir, 'xpcshell-test', { stdout: ['Passed: 0'], exit: 0 });
    expect((await runRequest(ws, { paths: [X] })).reason).toBe('no-tests');
  });

  it('runs every repetition, and the validator after a clean run', async () => {
    const ws = await makeTestWorkspace(dir());
    await scriptMach(ws.engineDir, 'xpcshell-test', xpcshell([X]));
    const repeated = await runRequest(ws, { paths: [X], repeat: 2 });
    expect(repeated.dispatches.map((entry) => entry.run)).toEqual([1, 2]);
    expect(runReport(repeated).fields).toMatchObject({ runs: '2/2' });
    const rejected = await runRequest(ws, {
      paths: [X],
      validate: { command: [process.execPath, '-e', 'process.exit(3)'], cwd: ws.project.root },
    });
    expect(rejected).toMatchObject({ pass: false, reason: 'validate', validateExit: 3 });
    // A validator is told where the project and the engine it judges are.
    const told =
      'process.exit(process.env.FIREFORGE_ENGINE === process.argv[1] && process.env.FIREFORGE_PROJECT_ROOT === process.argv[2] ? 0 : 4)';
    const accepted = await runRequest(ws, {
      paths: [X],
      validate: {
        command: [process.execPath, '-e', told, ws.engineDir, ws.project.root],
        cwd: ws.project.root,
      },
    });
    expect(accepted).toMatchObject({ pass: true, validateExit: 0 });
  });

  it('discards a result when the engine changed under the harness', async () => {
    const ws = await makeTestWorkspace(dir());
    const target = join(ws.engineDir, 'browser/base/content/browser.js');
    await scriptMach(ws.engineDir, 'xpcshell-test', {
      ...xpcshell([X]),
      detach: [
        process.execPath,
        '-e',
        'require("node:fs").writeFileSync(process.argv[1], process.argv[2])',
        target,
        'export const browserTitle = "moved";\n',
      ],
      sleep: 0.5,
    });
    const result = await runRequest(ws, { paths: [X] });
    expect(result).toMatchObject({
      pass: false,
      reason: 'inconclusive',
      engineMoved: ['browser/base/content/browser.js'],
    });
    expect(runReport(result).failure).toMatchObject({ code: 'test-inconclusive', exitCode: 14 });
  });

  // Sessions, and finding the processes a run left behind, are POSIX.
  it.skipIf(process.platform === 'win32')(
    'terminates a helper the harness left in a session of its own',
    async () => {
      const ws = await makeTestWorkspace(dir());
      await writeTree(ws.objDir, {
        '_tests/xpcshell/moz-http2/moz-http2.js': 'setInterval(() => {}, 1000);\n',
      });
      const pidFile = join(dir(), 'helper.pid');
      const helper = join(ws.objDir, '_tests/xpcshell/moz-http2/moz-http2.js');
      await scriptMach(ws.engineDir, 'xpcshell-test', {
        ...xpcshell([X]),
        detach: ['/bin/sh', '-c', `echo $$ > '${pidFile}'; exec "${process.execPath}" '${helper}'`],
        sleep: 1,
      });
      const result = await runRequest(ws, { paths: [X] });
      expect(result.pass).toBe(true);
      expect(result.reaped).toBeGreaterThanOrEqual(1);
      expect(runReport(result).fields['orphans-reaped']).toBe(result.reaped);
      const pid = Number(await readFile(pidFile, 'utf8'));
      await vi.waitFor(() => {
        expect(isProcessAlive(pid)).toBe(false);
      });
    }
  );

  it('refuses a stale build with the command that repairs it, and builds first when asked', async () => {
    const ws = await makeTestWorkspace(dir());
    await writeFile(
      join(ws.engineDir, 'browser/base/content/browser.js'),
      'export const browserTitle = "edited";\n'
    );
    await scriptMach(ws.engineDir, 'xpcshell-test', xpcshell([X]));
    await expect(runRequest(ws, { paths: [X] })).rejects.toMatchObject({
      code: 'build-stale',
      hint: expect.stringContaining('fireforge build --ui') as string,
    });
    const builds = (await calls(ws, 'build')).length;
    const result = await runRequest(ws, { paths: [X] }, { build: true });
    expect(result).toMatchObject({ pass: true, built: 'ui' });
    expect(await calls(ws, 'build')).toHaveLength(builds + 1);
  });
});

describe('runControl', () => {
  it('catches a mutation red at exactly the expected assertion, then restores the engine', async () => {
    const ws = await makeTestWorkspace(dir());
    await scriptMach(ws.engineDir, 'mochitest', harnessScript([A]));
    const original = await readFile(join(ws.engineDir, SCRIPT), 'utf8');
    const diff = join(dir(), 'control.diff');
    await writeScriptMutation(
      ws.engineDir,
      'mochitest',
      harnessScript([A], { [A]: 'the guard holds' }),
      diff
    );
    const plan = await planTests(ws.engineDir, { paths: [A] });

    const control = await runControl(ws, plan, { diff, expect: ['the guard holds'] });
    expect(control).toMatchObject({ outcome: 'caught', targets: [SCRIPT] });
    expect(control.baseline?.pass).toBe(true);
    expect(control.mutated?.reason).toBe('test-failures');
    expect(await readFile(join(ws.engineDir, SCRIPT), 'utf8')).toBe(original);

    // A diff taken from the checkout names the same engine file through its root.
    const fromCheckout = join(dir(), 'checkout.diff');
    await writeFile(
      fromCheckout,
      (await readFile(diff, 'utf8'))
        .replaceAll(` a/${SCRIPT}`, ` a/src/${SCRIPT}`)
        .replaceAll(` b/${SCRIPT}`, ` b/src/${SCRIPT}`)
    );
    expect(await readFile(fromCheckout, 'utf8')).toContain(`--- a/src/${SCRIPT}`);
    const mapped = await runControl(ws, plan, {
      diff: fromCheckout,
      expect: ['the guard holds'],
      roots: [{ directory: 'src', engine: '' }],
    });
    expect(mapped).toMatchObject({ outcome: 'caught', targets: [SCRIPT] });
    await expect(
      runControl(ws, plan, { diff: fromCheckout, expect: ['the guard holds'] })
    ).rejects.toMatchObject({ code: 'negative-control' });

    // The unmutated tests are recorded green on this engine state, so only the mutated run repeats.
    const before = (await calls(ws, 'mochitest')).length;
    const again = await runControl(ws, plan, { diff, expect: ['the guard holds'] });
    expect(again.baseline).toBeUndefined();
    expect(await calls(ws, 'mochitest')).toHaveLength(before + 1);

    // A green run under another environment says nothing about this one.
    const otherwise = await runControl(
      ws,
      { ...plan, env: { MOZ_EXAMPLE: '1' } },
      { diff, expect: ['the guard holds'] }
    );
    expect(otherwise.baseline?.pass).toBe(true);
    expect(await calls(ws, 'mochitest')).toHaveLength(before + 3);
  });

  it('fails as wrong-red for reds at other assertions, naming the expected and the seen', async () => {
    const ws = await makeTestWorkspace(dir());
    await scriptMach(ws.engineDir, 'mochitest', harnessScript([A]));
    const diff = join(dir(), 'control.diff');
    const mutated = harnessScript([A], { [A]: 'the guard holds' });
    await writeScriptMutation(ws.engineDir, 'mochitest', mutated, diff);
    const plan = await planTests(ws.engineDir, { paths: [A] });
    const wrong = await runControl(ws, plan, { diff, expect: ['the tile keeps its size'] });
    expect(wrong).toMatchObject({
      outcome: 'wrong-red',
      why: 'expected "the tile keeps its size"; the run was red at "the guard holds"',
    });
    expect(controlReport(wrong).failure).toMatchObject({ code: 'control-wrong-red', exitCode: 5 });
  });

  it('fails as baseline-red for tests already red without the mutation, and applies nothing', async () => {
    const ws = await makeTestWorkspace(dir());
    await scriptMach(ws.engineDir, 'mochitest', harnessScript([A], { [A]: 'already broken' }));
    const diff = join(dir(), 'control.diff');
    const mutated = harnessScript([A], { [A]: 'the guard holds' });
    await writeScriptMutation(ws.engineDir, 'mochitest', mutated, diff);
    const plan = await planTests(ws.engineDir, { paths: [A] });
    const red = await runControl(ws, plan, { diff, expect: ['the guard holds'] });
    expect(red).toMatchObject({
      outcome: 'baseline-red',
      why: expect.stringContaining('not green without the mutation') as string,
    });
    expect(red.mutated).toBeUndefined();
  });

  const uiDiff = (from: string, to: string): string =>
    [
      'diff --git a/browser/base/content/browser.js b/browser/base/content/browser.js',
      '--- a/browser/base/content/browser.js',
      '+++ b/browser/base/content/browser.js',
      '@@ -1 +1 @@',
      `-export const browserTitle = "${from}";`,
      `+export const browserTitle = "${to}";`,
      '',
    ].join('\n');

  it('reports a missed mutation, building what it needs and the restored engine after', async () => {
    const ws = await makeTestWorkspace(dir());
    await scriptMach(ws.engineDir, 'mochitest', harnessScript([A]));
    const diff = join(dir(), 'ui.diff');
    await writeFile(diff, uiDiff('baseline', 'mutated'));
    const builds = (await calls(ws, 'build')).length;
    const plan = await planTests(ws.engineDir, { paths: [A] });
    const control = await runControl(ws, plan, { diff, expect: ['x'] });
    expect(control).toMatchObject({ outcome: 'missed', restoreBuild: 'done' });
    expect(control.mutated?.built).toBe('ui');
    expect(await calls(ws, 'build')).toHaveLength(builds + 2);
    expect(await readFile(join(ws.engineDir, 'browser/base/content/browser.js'), 'utf8')).toBe(
      'export const browserTitle = "baseline";\n'
    );
  });

  it('restores the engine when the mutated run fails, and refuses a diff that does not apply', async () => {
    const ws = await makeTestWorkspace(dir());
    await scriptMach(ws.engineDir, 'mochitest', harnessScript([A]));
    const plan = await planTests(ws.engineDir, { paths: [A] });
    const diff = join(dir(), 'ui.diff');
    await writeFile(diff, uiDiff('nothing like this', 'x'));
    await expect(runControl(ws, plan, { diff, expect: ['x'] })).rejects.toMatchObject({
      code: 'negative-control',
    });

    await writeFile(diff, uiDiff('baseline', 'mutated'));
    await runTests(ws, plan);
    await writeTree(ws.engineDir, { '.mach-state/fail-build': '' });
    await expect(runControl(ws, plan, { diff, expect: ['x'] })).rejects.toMatchObject({
      code: 'build-failed',
    });
    expect(await readFile(join(ws.engineDir, 'browser/base/content/browser.js'), 'utf8')).toBe(
      'export const browserTitle = "baseline";\n'
    );
  });

  // Windows has no interrupt a process can handle before it exits.
  it.skipIf(process.platform === 'win32')(
    'restores the engine on an interrupt, before the process would exit',
    async () => {
      const ws = await makeTestWorkspace(dir());
      await scriptMach(ws.engineDir, 'mochitest', harnessScript([A]));
      const original = await readFile(join(ws.engineDir, SCRIPT), 'utf8');
      const diff = join(dir(), 'control.diff');
      const hanging = { ...harnessScript([A], { [A]: 'the guard holds' }), sleep: 60 };
      await writeScriptMutation(ws.engineDir, 'mochitest', hanging, diff);
      const plan = await planTests(ws.engineDir, { paths: [A] });
      await runTests(ws, plan);
      const before = (await calls(ws, 'mochitest')).length;
      const pending = runControl(ws, plan, { diff, expect: ['the guard holds'] }).catch(
        (error: unknown) => error
      );
      await vi.waitFor(
        async () => {
          expect(await calls(ws, 'mochitest')).toHaveLength(before + 1);
        },
        { timeout: 20_000, interval: 100 }
      );
      try {
        await runShutdown('SIGTERM');
        expect(await readFile(join(ws.engineDir, SCRIPT), 'utf8')).toBe(original);
      } finally {
        resetShutdown();
        await pending;
      }
    }
  );
});
