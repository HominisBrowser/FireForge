// SPDX-License-Identifier: EUPL-1.2
/** How a client starts a supervisor, what that supervisor inherits, and what a failed start says. */
import * as childProcess from 'node:child_process';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sourceFixture, writeAt } from '../../authored/__tests__/fixtures.js';
import { captureAuthoredSnapshot } from '../../authored/index.js';
import { observeAdmission } from '../admission-context.js';
import { ensureSupervisor, initializeCoordinator } from '../client.js';
import { probeDisplay, probeSessionRefusal } from '../display-probe.js';
import { electSupervisor } from '../election.js';
import { executorFingerprint } from '../evidence.js';
import { coordinatorNamespace } from '../guard.js';
import { processHasExitedAsync } from '../process.js';
import { normalizeRequest } from '../schema.js';
import { createSlot } from '../slot-lifecycle.js';
import { readJson, writeDurable } from '../store.js';
import { validateSubmission } from '../submission.js';

const host = vi.hoisted(() => ({
  home: '',
  /** What `launchctl managername` says. Undefined asks the real one. */
  session: undefined as string | undefined,
  helpers: [] as string[],
  spawned: [] as Array<{ command: string; detached: boolean; cwd?: string }>,
}));

vi.mock('node:os', async (original) => {
  const actual = await original<typeof import('node:os')>();
  return {
    ...actual,
    userInfo: () => ({
      ...actual.userInfo(),
      homedir: host.home === '' ? actual.userInfo().homedir : host.home,
    }),
  };
});

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const { promisify: promisified } = await import('node:util');
  const real = promisified(actual.execFile);
  const asked = (
    file: string,
    args: readonly string[] = [],
    options: object = {}
  ): Promise<unknown> => {
    host.helpers.push(file);
    return file === '/bin/launchctl' && host.session !== undefined
      ? Promise.resolve({ stdout: `${host.session}\n`, stderr: '' })
      : real(file, [...args], options);
  };
  return {
    ...actual,
    execFile: Object.assign(actual.execFile.bind(null), { [promisified.custom]: asked }),
    spawn: (command: string, args: string[], options: childProcess.SpawnOptions) => {
      host.spawned.push({
        command,
        detached: options.detached === true,
        ...(typeof options.cwd === 'string' ? { cwd: options.cwd } : {}),
      });
      return actual.spawn(command, args, options);
    },
  };
});

// Real processes beside whatever else the suite is running.
vi.setConfig({ testTimeout: 180_000 });

const directories: string[] = [];
beforeEach(() => {
  host.home = '';
  host.session = undefined;
  host.helpers.length = 0;
  host.spawned.length = 0;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
async function temp(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'ff-start-')));
  directories.push(path);
  return path;
}

/** A namespace whose recorded Node is this script, which says it ran and then does what it is told. */
async function namespaceRunning(body: string): Promise<{ namespace: string; ran: string }> {
  const directory = await temp();
  const namespace = join(directory, 'coordinator');
  await initializeCoordinator(namespace);
  const ran = join(directory, 'ran.txt');
  const program = join(directory, 'node');
  await writeFile(program, `#!/bin/sh\necho $$ >> "${ran}"\n${body}\n`);
  await chmod(program, 0o755);
  const config = await readJson<Record<string, unknown>>(join(namespace, 'config.json'));
  await writeDurable(join(namespace, 'config.json'), {
    ...config,
    runtime: { node: program, environment: { PATH: '/bin:/usr/bin' } },
  });
  return { namespace, ran };
}

const parentOf = (pid: number): number =>
  Number(childProcess.execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }));

describe('the first client', () => {
  it('starts the default namespace supervisor as its own detached child, in the namespace, with no launchctl involved', async () => {
    vi.stubEnv('FIREFORGE_COORDINATOR', undefined);
    host.home = await temp();
    const namespace = coordinatorNamespace();
    expect(namespace).toBe(join(host.home, '.fireforge', 'host', 'jobs'));
    await initializeCoordinator(namespace, { idleMs: 3_000 });
    const { owner } = await ensureSupervisor(namespace);
    expect(parentOf(owner.pid)).toBe(process.pid);
    // Not the client's directory, which may be a removable worktree or a privacy-watched folder.
    expect(host.spawned).toEqual([{ command: process.execPath, detached: true, cwd: namespace }]);
    if (process.platform === 'darwin') {
      const cwd = childProcess
        .execFileSync('lsof', ['-a', '-p', String(owner.pid), '-d', 'cwd', '-Fn'], {
          encoding: 'utf8',
        })
        .split('\n')
        .find((line) => line.startsWith('n'));
      expect(cwd?.slice(1)).toBe(await realpath(namespace));
    }
    expect(host.helpers).not.toContain('/bin/launchctl');
    await expect(readFile(join(namespace, 'supervisor.plist'))).rejects.toThrow();
    await vi.waitFor(
      async () => {
        expect(await processHasExitedAsync(owner)).toBe(true);
      },
      { timeout: 45_000, interval: 200 }
    );
  }, 90_000);
});

describe('a start that goes nowhere', () => {
  it('is stopped and named, in the error and in the log, when it never reaches the election', async () => {
    const { namespace, ran } = await namespaceRunning('exec sleep 300');
    const refusal = await ensureSupervisor(namespace, 1_500).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(Error);
    const { message } = refusal as Error;
    expect(message).toMatch(/Coordinator did not start: supervisor process \d+ did not reach/);
    expect(message).toContain(join(namespace, 'supervisor.log'));
    if (process.platform === 'darwin') expect(message).toMatch(/privacy controls.*~\/Documents/);
    const log = await readFile(join(namespace, 'supervisor.log'), 'utf8');
    expect(log).toMatch(/did not reach the election/);
    // One start and not a pile of them, and that one is gone. A loaded host can
    // stop the start before its first line runs, so the spawn is what counts.
    const pid = Number(/supervisor process (\d+)/.exec(message)?.[1]);
    expect(host.spawned.map(({ command }) => command)).toEqual([join(namespace, '..', 'node')]);
    const written = (await readFile(ran, 'utf8').catch(() => '')).trim();
    if (written !== '') expect(written).toBe(String(pid));
    await vi.waitFor(
      () => {
        expect(() => {
          process.kill(pid, 0);
        }).toThrow();
      },
      { timeout: 10_000, interval: 50 }
    );
  });

  it('says why at once when it exits having failed, without waiting out the budget', async () => {
    const { namespace } = await namespaceRunning('echo "the reason" >&2; exit 3');
    const started = Date.now();
    await expect(ensureSupervisor(namespace)).rejects.toThrow(
      /Coordinator could not start: the reason/
    );
    expect(Date.now() - started).toBeLessThan(25_000);
  });

  it('names who holds the election, and leaves that process alone', async () => {
    const { namespace } = await namespaceRunning('exit 0');
    const election = await electSupervisor(namespace);
    try {
      await expect(ensureSupervisor(namespace, 1_500)).rejects.toThrow(
        new RegExp(`process ${String(process.pid)} holds the supervisor election`)
      );
      expect(await readFile(join(namespace, 'supervisor.log'), 'utf8')).toMatch(
        /holds the supervisor election/
      );
    } finally {
      await election.release();
    }
  });
});

describe.runIf(process.platform === 'darwin')('a supervisor outside the login session', () => {
  it('refuses a step with a window at submit, and takes a headless one', async () => {
    const f = await sourceFixture();
    directories.push(join(f.root, '..'));
    const namespace = join(f.root, '..', 'coordinator');
    await initializeCoordinator(namespace);
    await writeAt(f.root, 'src/browser/a/test/browser_a.js', 'add_task(() => ok(true));\n');
    const snapshot = await captureAuthoredSnapshot({
      projectRoot: f.root,
      pristineRepository: f.pristine,
    });
    await createSlot({ namespace, id: 'a', snapshot, pristineRepository: f.pristine });
    const config = await readJson<Parameters<typeof validateSubmission>[0]['config']>(
      join(namespace, 'config.json')
    );
    const submit = async (args: string[]): Promise<unknown> =>
      validateSubmission({
        namespace,
        config,
        snapshot,
        executorDigest: await executorFingerprint(),
        request: normalizeRequest({ steps: [{ command: 'test', args }] }, snapshot.id),
      }).catch((error: unknown) => error);
    host.session = 'Background';
    const windowed = await submit(['browser/a/test/browser_a.js']);
    expect((windowed as Error).message).toMatch(/needs the login session.*"Background"/);
    const headless = await submit(['--headless', 'browser/a/test/browser_a.js']);
    expect(String((headless as Error | undefined)?.message)).not.toMatch(/login session/);
    host.session = 'Aqua';
    const inSession = await submit(['browser/a/test/browser_a.js']);
    expect(String((inSession as Error | undefined)?.message)).not.toMatch(/login session/);
  });

  it('holds a recovered step with a window at admission, saying why', async () => {
    const directory = await temp();
    const namespace = join(directory, 'coordinator');
    await initializeCoordinator(namespace);
    host.session = 'Background';
    expect(await probeSessionRefusal()).toMatch(/"Background"/);
    // A reading older than the cache's life, so this one asks.
    const answer = await probeDisplay(Date.now() + 3_600_000);
    expect(answer).toMatchObject({ state: 'unavailable' });
    expect(answer.detail).toMatch(/"Background", outside the login session/);
    const observed = await observeAdmission(namespace, undefined);
    expect(observed.displayDown).toBe(answer.detail);
    // The load a quiet phase waits on comes from the reader, and an unreadable one is left out.
    expect((await observeAdmission(namespace, undefined, () => 37.5)).hostLoad).toBe(37.5);
    expect(await observeAdmission(namespace, undefined, () => undefined)).not.toHaveProperty(
      'hostLoad'
    );
  });
});
