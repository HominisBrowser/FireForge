// SPDX-License-Identifier: EUPL-1.2
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Workspace } from '../engine/index.js';
import { ExitCode } from '../kernel/errors.js';
import { hostPaths } from '../project/index.js';
import { type CliResult, runCli } from '../testing/cli.js';
import {
  makeEngineProject,
  makeSourceProject,
  seedPristine,
  useMachSandbox,
} from '../testing/engine.js';
import { readMachLog, scriptMach } from '../testing/firefox.js';
import {
  harnessScript,
  makeTestWorkspace,
  TEST_ENGINE_FILES,
  TEST_PATHS,
  writeScriptMutation,
} from '../testing/harness.js';
import { useTempDir } from '../testing/temp.js';

const dir = useTempDir();
useMachSandbox();
const { browserA: A, browserSupport: HEAD } = TEST_PATHS;

/** Runs `fireforge` in the workspace's own project, whose engine/ is the workspace. */
const inProject = (ws: Workspace, ...args: string[]): Promise<CliResult> =>
  runCli(args, { cwd: ws.project.root, env: { FIREFORGE_HOME: join(dir(), 'home') } });
const verdictLine = (stdout: string): string => stdout.trimEnd().split('\n').at(-1) ?? '';

describe('fireforge test', () => {
  it('says in its help which way of dispatching mochitest files is the default', async () => {
    const help = (await runCli(['test', '--help'], { cwd: dir() })).stdout.replace(/\s+/g, ' ');
    expect(help).toContain(
      '--shard Give each mochitest file a browser of its own; --no-shard runs them all in one (on by default)'
    );
    expect(help).toContain('--no-shard Turn off --shard');
  });

  it('ends a green run with the verdict line and writes the results document', async () => {
    const ws = await makeTestWorkspace(dir());
    await scriptMach(ws.engineDir, 'mochitest', harnessScript([A]));
    const results = join(dir(), 'results.json');
    const kept = join(dir(), 'kept.log');
    const run = await inProject(ws, 'test', A, '--results', results, '--keep-log', kept);
    expect(run.exitCode).toBe(0);
    expect(verdictLine(run.stdout)).toMatch(
      /^FIREFORGE-VERDICT: PASS checks=3 unexpected=0 log=\S+output\.log results=\S+results\.json$/
    );
    const document = JSON.parse(await readFile(results, 'utf8')) as Record<string, unknown>;
    expect(document).toMatchObject({
      schemaVersion: 1,
      verdict: 'pass',
      summary: { files: 1, passed: 1, failed: 0, unfinished: 0, neverStarted: 0 },
    });
    expect(await readFile(kept, 'utf8')).toContain(`TEST_START: ${A}`);
  });

  it('exits 5 on a red, and writes one JSON document under --json', async () => {
    const ws = await makeTestWorkspace(dir());
    await scriptMach(ws.engineDir, 'mochitest', harnessScript([A], { [A]: 'boom' }));
    const red = await inProject(ws, 'test', A);
    expect(red.exitCode).toBe(5);
    expect(verdictLine(red.stdout)).toMatch(/^FIREFORGE-VERDICT: FAIL reason=test-failures /);
    const json = await inProject(ws, 'test', A, '--json');
    expect(json.exitCode).toBe(5);
    expect(JSON.parse(json.stdout)).toMatchObject({
      schemaVersion: 1,
      verdict: 'fail',
      reason: 'test-failures',
    });
  });

  it('refuses before the harness with reason=preflight and the refusal on stdout', async () => {
    const ws = await makeTestWorkspace(dir());
    const run = await inProject(ws, 'test', HEAD);
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain('is a support file, not a test');
    expect(verdictLine(run.stdout)).toBe(
      'FIREFORGE-VERDICT: FAIL reason=preflight note=not-a-test'
    );
    const usage = await inProject(ws, 'test', A, '--standalone', '--no-shard');
    expect(usage.exitCode).toBe(8);
    const lone = await inProject(ws, 'test', A, '--expect', 'x');
    expect(lone.exitCode).toBe(8);
    for (const env of ['NOVALUE', '=x', 'FIREFORGE_TEST_RUN=1']) {
      const refused = await inProject(ws, 'test', A, '--env', env);
      expect(refused.exitCode).toBe(8);
      expect(verdictLine(refused.stdout)).toMatch(/^FIREFORGE-VERDICT: FAIL reason=preflight/);
    }
  });

  it('hands --env assignments to the harness', async () => {
    const ws = await makeTestWorkspace(dir());
    await scriptMach(ws.engineDir, 'mochitest', harnessScript([A]));
    const run = await inProject(ws, 'test', A, '--env', 'SUITE_SETTING=a=b');
    expect(run.exitCode).toBe(0);
    const calls = await readMachLog(ws.engineDir);
    expect(calls.at(-1)?.env['SUITE_SETTING']).toBe('a=b');
  });

  it('runs a negative control: caught exits 0 with control=caught', async () => {
    const ws = await makeTestWorkspace(dir());
    await scriptMach(ws.engineDir, 'mochitest', harnessScript([A]));
    const diff = join(dir(), 'control.diff');
    await writeScriptMutation(
      ws.engineDir,
      'mochitest',
      harnessScript([A], { [A]: 'the guard holds' }),
      diff
    );
    const run = await inProject(ws, 'test', A, '--control', diff, '--expect', 'the guard holds');
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('Negative control caught');
    expect(verdictLine(run.stdout)).toMatch(/^FIREFORGE-VERDICT: PASS .*control=caught$/);
    const wrong = await inProject(ws, 'test', A, '--control', diff, '--expect', 'elsewhere');
    expect(wrong.exitCode).toBe(5);
    expect(verdictLine(wrong.stdout)).toMatch(
      /^FIREFORGE-VERDICT: FAIL reason=control-wrong-red .*control=wrong-red$/
    );
    expect(wrong.stdout).toContain(
      'Negative control FAILED, red at the wrong assertions: expected "elsewhere"; the run was red at "the guard holds"'
    );
    expect(wrong.stdout).not.toContain('inconclusive');
    expect(wrong.stderr).toContain('control-wrong-red');
    expect(wrong.stderr).not.toContain('inconclusive');
  });
});

describe('fireforge test in the project workspace', () => {
  const home = (): string => join(dir(), 'home');
  const cli = (project: { root: string }, ...args: string[]): Promise<CliResult> =>
    runCli(args, { cwd: project.root, env: { FIREFORGE_HOME: home() } });
  const config = { config: { test: { mochitestPorts: 'auto' } } };
  const seed = (): Promise<string> =>
    seedPristine(hostPaths({ FIREFORGE_HOME: home() }), {
      ...TEST_ENGINE_FILES,
      '.mach-state/script-mochitest.json': JSON.stringify(harnessScript([A])),
    });

  it('patch mode: refuses an unbuilt engine, and builds first under --build', async () => {
    await seed();
    const project = await makeEngineProject(dir(), config);
    expect((await cli(project, 'download')).exitCode).toBe(ExitCode.SUCCESS);
    const stale = await cli(project, 'test', A);
    expect(stale.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(verdictLine(stale.stdout)).toBe(
      'FIREFORGE-VERDICT: FAIL reason=preflight note=build-stale'
    );

    const run = await cli(project, 'test', A, '--build');
    expect(run.exitCode).toBe(ExitCode.SUCCESS);
    expect(verdictLine(run.stdout)).toMatch(/^FIREFORGE-VERDICT: PASS checks=3 unexpected=0 /);
    const calls = await readMachLog(join(project.root, 'engine'));
    expect(calls.map((call) => call.args[0])).toEqual(['build', 'mochitest']);
    const pool = await cli(project, 'test', A, '--workspace', 'w1');
    expect(pool.exitCode).toBe(ExitCode.INVALID_ARGUMENT);
  }, 60_000);

  it('source mode: leases a workspace holding the checkout, builds it and tests there', async () => {
    await seed();
    const project = await makeSourceProject(dir(), {
      ...config,
      files: { 'src/browser/base/content/panel.mjs': 'export const panel = 1;\n' },
    });
    const run = await cli(project, 'test', A, '--build', '--json');
    expect(run.exitCode).toBe(ExitCode.SUCCESS);
    expect(JSON.parse(run.stdout)).toMatchObject({ verdict: 'pass', summary: { passed: 1 } });
    const engine = join(home(), 'workspaces', 'w1', 'engine');
    expect(await readFile(join(engine, 'browser/base/content/panel.mjs'), 'utf8')).toContain(
      'panel = 1'
    );
    expect((await readMachLog(engine)).map((call) => call.args[0])).toEqual(['build', 'mochitest']);
    // The build is fresh for this checkout, so the next run needs no --build.
    expect((await cli(project, 'test', A)).exitCode).toBe(ExitCode.SUCCESS);
  }, 60_000);
});
