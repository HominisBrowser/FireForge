// SPDX-License-Identifier: EUPL-1.2
/**
 * The daily loop through the CLI, in each mode, over a seeded pristine
 * repository and the stand-in mach: status, lint, build, a smoke start,
 * export; and two checkouts of one source-mode project building at once in
 * two pool workspaces.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_LICENSE } from '../config/index.js';
import { writeTree as writeGitTree } from '../git/index.js';
import { ExitCode } from '../kernel/errors.js';
import { type HostPaths, hostPaths, licenseHeader, type Project } from '../project/index.js';
import { replayQueue } from '../queue/index.js';
import { type CliResult, runCli, spawnCli } from '../testing/cli.js';
import { TEST_PIN_KEY } from '../testing/config.js';
import {
  makeEngineProject,
  makeSourceProject,
  seedPristine,
  useMachSandbox,
} from '../testing/engine.js';
import { readMachLog } from '../testing/firefox.js';
import { git } from '../testing/git.js';
import { useTempDir, writeTree } from '../testing/temp.js';

const dir = useTempDir();
useMachSandbox();

const HEADER = `${licenseHeader(DEFAULT_LICENSE, 'js')}\n`;
const PANEL = 'browser/base/content/panel.mjs';
/** A browser that prints one line and stays up, so a smoke start reaches its deadline. */
const RUNNING = JSON.stringify({ stdout: ['console.log: started'], sleep: 60 });

const host = (): HostPaths => hostPaths({ FIREFORGE_HOME: join(dir(), 'home') });

const cli = (project: Pick<Project, 'root'>, ...args: string[]): Promise<CliResult> =>
  runCli(args, { cwd: project.root, env: { FIREFORGE_HOME: host().root } });

const json = (result: CliResult): Record<string, unknown> =>
  JSON.parse(result.stdout) as Record<string, unknown>;

describe('the daily loop in patch mode', () => {
  // A smoke start ends the browser through its process group, which Windows does not have.
  it.skipIf(process.platform === 'win32')(
    'reports an edit, lints it, builds, refuses a stale run and smoke-starts the build',
    async () => {
      await seedPristine(host(), { '.mach-state/script-run.json': RUNNING });
      const project = await makeEngineProject(dir());
      for (const command of ['status', 'lint', 'build']) {
        expect((await cli(project, command)).stderr).toContain('Run "fireforge download" first.');
      }
      expect((await cli(project, 'download')).exitCode).toBe(ExitCode.SUCCESS);
      const engine = join(project.root, 'engine');
      expect((await cli(project, 'status', '--check')).stdout).toContain('Nothing is unaccounted');

      await writeTree(engine, { [PANEL]: 'export const panel = 1;\n' });
      const status = await cli(project, 'status', '--check', '--json');
      expect(status.exitCode).toBe(ExitCode.GENERAL_ERROR);
      expect(json(status)).toMatchObject({
        mode: 'patches',
        clean: false,
        pending: [{ code: 'unmanaged', subject: PANEL }],
      });

      const flagged = await cli(project, 'lint', '--json');
      expect(flagged.exitCode).toBe(ExitCode.GENERAL_ERROR);
      expect(json(flagged)).toMatchObject({ findings: [{ rule: 'missing-license-header' }] });
      await writeTree(engine, { [PANEL]: `${HEADER}export const panel = 1;\n` });
      expect((await cli(project, 'lint', PANEL)).exitCode).toBe(ExitCode.SUCCESS);
      expect((await cli(project, 'verify')).stdout).toBe('The patch queue is sound.\n');

      const stale = await cli(project, 'run', '--smoke-exit', '1', '--headless');
      expect(stale.exitCode).toBe(ExitCode.GENERAL_ERROR);
      expect(stale.stderr).toContain('is older than its engine');
      expect(stale.stderr).toContain('fireforge build');

      const built = await cli(project, 'build', '--json');
      expect(json(built)).toMatchObject({ workspace: 'engine', kind: 'full' });
      const smoke = await cli(project, 'run', '--smoke-exit', '1', '--headless');
      expect(smoke.exitCode).toBe(ExitCode.SUCCESS);
      expect(smoke.stdout).toContain('Smoke start passed');

      await writeTree(engine, { 'browser/app/nsBrowserApp.cpp': 'int main() { return 0; }\n' });
      const rebuilt = await cli(project, 'run', '--build', '--smoke-exit', '1', '--headless');
      expect(rebuilt.exitCode).toBe(ExitCode.SUCCESS);
      expect((await readMachLog(engine)).map((call) => call.args[0])).toEqual([
        'build',
        'run',
        'build',
        'run',
      ]);
    },
    60_000
  );
});

describe('the daily loop in source mode', () => {
  // A smoke start ends the browser through its process group, which Windows does not have.
  it.skipIf(process.platform === 'win32')(
    'goes from an owned file to a built workspace, a smoke start and a queue that replays',
    async () => {
      const commit = await seedPristine(host(), { '.mach-state/script-run.json': RUNNING });
      const project = await makeSourceProject(dir(), {
        files: { [`src/${PANEL}`]: `${HEADER}export const panel = 1;\n` },
      });
      const script = 'browser/base/content/browser.js';
      await writeTree(project.root, { [`src/${script}`]: 'export const browserTitle = "mine";\n' });
      const undeclared = await cli(project, 'status', '--check', '--json');
      expect(undeclared.exitCode).toBe(ExitCode.GENERAL_ERROR);
      expect(json(undeclared)).toMatchObject({ mode: 'source', pending: [{ subject: script }] });
      await git(project.root, ['clean', '-fdq', 'src']);
      expect((await cli(project, 'override', script)).exitCode).toBe(ExitCode.SUCCESS);
      await writeTree(project.root, { [`src/${script}`]: 'export const browserTitle = "mine";\n' });

      const status = await cli(project, 'status', '--check', '--json');
      expect(status.exitCode).toBe(ExitCode.SUCCESS);
      expect(json(status)).toMatchObject({
        clean: true,
        owned: [
          { path: script, group: 'browser' },
          { path: PANEL, group: 'created-root' },
        ],
        groups: [
          { id: 'browser', kind: 'component', paths: 1 },
          { id: 'created-root', kind: 'created', paths: 1 },
        ],
      });
      expect((await cli(project, 'verify')).exitCode).toBe(ExitCode.SUCCESS);
      const lint = await cli(project, 'lint', PANEL);
      expect(lint.stderr).toBe('');
      expect(lint.exitCode).toBe(ExitCode.SUCCESS);

      const built = await cli(project, 'build', '--json');
      expect(json(built)).toMatchObject({ workspace: 'w1', kind: 'full' });
      const engine = join(host().workspaces, 'w1', 'engine');
      expect(await readFile(join(engine, PANEL), 'utf8')).toContain('export const panel = 1;');
      expect(await readFile(join(engine, script), 'utf8')).toContain('"mine"');
      const smoke = await cli(project, 'run', '--smoke-exit', '1', '--headless');
      expect(smoke.exitCode).toBe(ExitCode.SUCCESS);

      const exported = await cli(project, 'export', '--json');
      expect(exported.exitCode).toBe(ExitCode.SUCCESS);
      const out = join(project.root, 'patches');
      expect(json(exported)).toMatchObject({
        out,
        patches: [{ files: [script] }, { files: [PANEL] }],
      });
      // The written queue replays, byte for byte, to the tree this checkout builds.
      const pristine = join(host().pristine, TEST_PIN_KEY);
      const expected = await writeGitTree(
        pristine,
        [
          { path: script, content: await readFile(join(project.root, 'src', script)) },
          { path: PANEL, content: await readFile(join(project.root, 'src', PANEL)) },
        ],
        commit
      );
      expect(await replayQueue(pristine, commit, out)).toBe(expected);
      // A second export replaces the generated queue; a directory holding anything else is refused.
      expect((await cli(project, 'export')).exitCode).toBe(ExitCode.SUCCESS);
      await writeTree(project.root, { 'notes/readme.txt': 'mine\n' });
      const refused = await cli(project, 'export', '--out', join(project.root, 'notes'));
      expect(refused.exitCode).toBe(ExitCode.INVALID_ARGUMENT);
    },
    60_000
  );

  it('builds two checkouts at once in two workspaces, each holding its own checkout', async () => {
    // Each build stays in mach long enough for the two leases to overlap.
    await seedPristine(host(), {
      '.mach-state/script-build.json': JSON.stringify({ stdout: ['built'], sleep: 2 }),
    });
    const first = await makeSourceProject(dir(), {
      files: { [`src/${PANEL}`]: `${HEADER}export const checkout = "first";\n` },
    });
    const second = { root: join(dir(), 'second') };
    await git(first.root, ['worktree', 'add', '--quiet', '-b', 'second', second.root]);
    await writeTree(second.root, {
      [`src/${PANEL}`]: `${HEADER}export const checkout = "second";\n`,
      'src/browser/base/content/only-second.mjs': `${HEADER}export {};\n`,
    });
    for (const name of ['w1', 'w2']) {
      expect((await cli(first, 'workspace', 'add', name)).exitCode).toBe(ExitCode.SUCCESS);
    }

    const env = { FIREFORGE_HOME: host().root };
    const build = (project: { root: string }): Promise<CliResult> =>
      spawnCli(['build', '--json', '--wait-lock', '60'], { cwd: project.root, env });
    const builds = Promise.all([build(first), build(second)]);
    // While both run, the pool shows two leases at the same moment.
    const state = { running: true };
    void builds.finally(() => (state.running = false));
    let leasedAtOnce = 0;
    while (state.running && leasedAtOnce < 2) {
      const listed = json(await cli(first, 'workspace', 'list', '--json'))['workspaces'];
      const leased = (listed as { holders: number[] }[]).filter((row) => row.holders.length > 0);
      leasedAtOnce = Math.max(leasedAtOnce, leased.length);
    }
    expect(leasedAtOnce).toBe(2);
    const [one, two] = await builds;
    expect(one.exitCode).toBe(ExitCode.SUCCESS);
    expect(two.exitCode).toBe(ExitCode.SUCCESS);
    const workspaces = [json(one)['workspace'], json(two)['workspace']] as string[];
    expect([...workspaces].sort()).toEqual(['w1', 'w2']);

    const engineOf = (name: string | undefined): string =>
      join(host().workspaces, name ?? '', 'engine');
    const panel = (name: string | undefined): Promise<string> =>
      readFile(join(engineOf(name), PANEL), 'utf8');
    expect(await panel(workspaces[0])).toContain('"first"');
    expect(await panel(workspaces[1])).toContain('"second"');
    const only = 'browser/base/content/only-second.mjs';
    await expect(readFile(join(engineOf(workspaces[0]), only))).rejects.toThrow();
    expect(await readFile(join(engineOf(workspaces[1]), only), 'utf8')).toContain('export {}');

    // Each checkout comes back to the workspace it built in, so the other's engine is left alone.
    const again = json(await cli(first, 'build', '--ui', '--json'));
    expect(again).toMatchObject({ workspace: workspaces[0], kind: 'ui' });
    expect(await panel(workspaces[1])).toContain('"second"');
  }, 120_000);
});
