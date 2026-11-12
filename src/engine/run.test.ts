// SPDX-License-Identifier: EUPL-1.2
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { ExitCode } from '../kernel/errors.js';
import { loadProject } from '../project/index.js';
import { useMachSandbox } from '../testing/engine.js';
import { HOST_PYTHON, readMachLog, scriptMach, writeSyntheticFirefox } from '../testing/firefox.js';
import { initRepo } from '../testing/git.js';
import { useTempDir, writeTree } from '../testing/temp.js';
import { runBrowser } from './run.js';
import { type Workspace, workspaceAt } from './workspace.js';

const run = promisify(execFile);
const dir = useTempDir();
useMachSandbox();

/** A patch-mode project whose synthetic engine has been built once by the stand-in mach. */
async function builtWorkspace(): Promise<Workspace> {
  const root = join(dir(), 'project');
  await writeTree(root, {
    'fireforge.json': JSON.stringify({
      name: 'Test Browser',
      vendor: 'Test',
      appId: 'org.example.testbrowser',
      binaryName: 'testbrowser',
      firefox: { version: '140.9.0esr', product: 'firefox-esr' },
    }),
    'configs/common.mozconfig': 'ac_add_options --enable-application=browser\n',
    [`configs/${process.platform}.mozconfig`]: '# platform\n',
  });
  const engineDir = join(root, 'engine');
  await writeSyntheticFirefox(engineDir, { '.mach-state/binary-name': 'testbrowser' });
  await initRepo(engineDir);
  await run(HOST_PYTHON, ['mach', 'build'], { cwd: engineDir });
  const project = await loadProject(root, { FIREFORGE_HOME: join(dir(), 'home') });
  return workspaceAt(project, {
    name: 'engine',
    kind: 'project',
    engineDir,
    stateDir: project.paths.stateDir,
    stateFile: project.paths.state,
  });
}

const lastRun = async (workspace: Workspace): Promise<string[]> =>
  (await readMachLog(workspace.engineDir)).filter((call) => call.args[0] === 'run').at(-1)?.args ??
  [];

const runProfiles = async (): Promise<string[]> =>
  (await readdir(tmpdir())).filter((name) => name.startsWith('fireforge-run-profile-'));

describe('runBrowser', () => {
  it('refuses when nothing is built', async () => {
    const workspace = await builtWorkspace();
    const unbuilt = { ...workspace, objDir: join(workspace.engineDir, 'obj-absent') };
    await expect(runBrowser(unbuilt, { headless: true })).rejects.toMatchObject({
      code: 'build-missing',
    });
  });

  it('launches the default profile with -purgecaches and passes arguments through', async () => {
    const workspace = await builtWorkspace();
    const capture = join(dir(), 'console.log');
    const result = await runBrowser(workspace, {
      headless: true,
      args: ['-marionette'],
      captureConsole: capture,
    });
    expect(result.exitCode).toBe(0);
    expect(await lastRun(workspace)).toEqual(['run', '--headless', '-purgecaches', '-marionette']);
    expect(await readFile(capture, 'utf8')).toBe('run complete\n');
  });

  it('keeps a named profile and reports it; a headed launch takes the display', async () => {
    const workspace = await builtWorkspace();
    const profile = join(dir(), 'profile');
    const result = await runBrowser(workspace, { profile, captureConsole: join(dir(), 'c.log') });
    expect(result.profile).toBe(profile);
    expect(await lastRun(workspace)).toEqual(['run', '-profile', profile, '-purgecaches']);
    await expect(runBrowser(workspace, { profile, tempProfile: true })).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  it('fails when a plain launch exits abnormally', async () => {
    const workspace = await builtWorkspace();
    await scriptMach(workspace.engineDir, 'run', { stderr: ['crashed'], exit: 11 });
    await expect(
      runBrowser(workspace, { headless: true, captureConsole: join(dir(), 'c.log') })
    ).rejects.toMatchObject({ code: 'browser-exited', exitCode: ExitCode.BUILD_ERROR });
  });

  it('takes a screenshot headless in a temporary profile', async () => {
    const workspace = await builtWorkspace();
    const before = await runProfiles();
    const shot = join(dir(), 'shot.png');
    const result = await runBrowser(workspace, { screenshot: shot });
    expect(result.screenshot).toBe(shot);
    const args = await lastRun(workspace);
    expect(args.slice(0, 3)).toEqual(['run', '--headless', '-profile']);
    expect(args.slice(4)).toEqual(['--screenshot', shot]);
    expect(await runProfiles()).toEqual(before);
  });
});

// A smoke start ends the browser through its process group, which Windows does not have.
describe.skipIf(process.platform === 'win32')('a smoke start', () => {
  it('passes when the browser is still running at the deadline, in a removed temporary profile', async () => {
    const workspace = await builtWorkspace();
    const before = await runProfiles();
    await scriptMach(workspace.engineDir, 'run', {
      stdout: ['console.log: started', 'console.warn: harmless'],
      sleep: 60,
    });
    const result = await runBrowser(workspace, { smokeExit: 1, headless: true });
    expect(result.smoke).toMatchObject({ timedOut: true, errors: [], browserLines: 2 });
    const args = await lastRun(workspace);
    expect(args[2]).toBe('-profile');
    expect(args).not.toContain('-purgecaches');
    expect(await runProfiles()).toEqual(before);
  });

  it('exits 12 on a console error unless a pattern allows it', async () => {
    const workspace = await builtWorkspace();
    await scriptMach(workspace.engineDir, 'run', {
      stdout: ['console.log: started'],
      stderr: ['JavaScript error: chrome://browser/content/x.js, line 3: TypeError: boom'],
    });
    await expect(runBrowser(workspace, { smokeExit: 20, headless: true })).rejects.toMatchObject({
      code: 'smoke-console-errors',
      exitCode: ExitCode.SMOKE_EXIT_FAILURE,
    });
    const allowFile = join(dir(), 'allow.txt');
    await writeTree(dir(), { 'allow.txt': '# known\nTypeError: boom\n' });
    const allowed = await runBrowser(workspace, {
      smokeExit: 20,
      headless: true,
      consoleAllowFile: allowFile,
    });
    expect(allowed.smoke).toMatchObject({ allowedErrors: 1, timedOut: false });
    await expect(
      runBrowser(workspace, { smokeExit: 20, headless: true, consoleAllow: ['('] })
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('exits 13 when the browser leaves early, crashed or silent', async () => {
    const workspace = await builtWorkspace();
    await scriptMach(workspace.engineDir, 'run', { stdout: ['console.log: up'], exit: 1 });
    await expect(runBrowser(workspace, { smokeExit: 20, headless: true })).rejects.toMatchObject({
      code: 'smoke-launch-failed',
      exitCode: ExitCode.SMOKE_LAUNCH_FAILURE,
    });
    await scriptMach(workspace.engineDir, 'run', { stdout: [' 0:00.10 firefox -profile x'] });
    await expect(runBrowser(workspace, { smokeExit: 20, headless: true })).rejects.toMatchObject({
      exitCode: ExitCode.SMOKE_LAUNCH_FAILURE,
    });
    await expect(runBrowser(workspace, { smokeExit: 0, headless: true })).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });
});
