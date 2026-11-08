// SPDX-License-Identifier: EUPL-1.2
/** The CLI as an agent runs it: real processes, a real supervisor, a real `git worktree add`. */
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { sourceFixture } from '../../core/authored/__tests__/fixtures.js';
import { ExitCode } from '../../errors/codes.js';

// Real processes and real clones, beside whatever else the suite is running.
vi.setConfig({ testTimeout: 180_000 });

const packageRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const entry = join(packageRoot, 'bin/fireforge.ts');
const loader = join(packageRoot, 'src/core/jobs/source-loader-bootstrap.cjs');

interface Flow {
  directory: string;
  project: string;
  pristine: string;
  namespace: string;
  /** Runs the CLI and reports its exit code, never throwing on nonzero. */
  cli: (
    cwd: string,
    args: string[],
    extra?: NodeJS.ProcessEnv
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
}

const flows: Flow[] = [];
afterEach(async () => {
  for (const flow of flows.splice(0)) {
    // Every job here is terminal, so the short idle timer retires the supervisor.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const running = await readFile(join(flow.namespace, 'endpoint.json')).then(
        () => true,
        () => false
      );
      if (!running) break;
      await new Promise((settle) => setTimeout(settle, 50));
    }
    await rm(flow.directory, { recursive: true, force: true });
  }
});

async function flow(): Promise<Flow> {
  const fixture = await sourceFixture();
  const directory = dirname(fixture.root);
  const namespace = join(directory, 'coordinator');
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'],
    HOME: process.env['HOME'],
    FIREFORGE_COORDINATOR: namespace,
    FIREFORGE_PRISTINE_REPOSITORY: fixture.pristine,
  };
  const created: Flow = {
    directory,
    project: fixture.root,
    pristine: fixture.pristine,
    namespace,
    cli: (cwd, args, extra = {}) =>
      new Promise((settle) => {
        execFile(
          process.execPath,
          ['--import', loader, entry, ...args],
          { cwd, env: { ...environment, ...extra }, encoding: 'utf8', timeout: 120_000 },
          (error, stdout, stderr) => {
            settle({ code: error === null ? 0 : Number(error.code ?? 1), stdout, stderr });
          }
        );
      }),
  };
  flows.push(created);
  return created;
}

/** `host init`, a snapshot and one slot, as an operator would set them up. */
async function provision(f: Flow, cwd: string): Promise<string> {
  const init = await f.cli(cwd, ['host', 'init', '--slots', '0', '--max-slots', '2']);
  expect(init.code, init.stderr).toBe(0);
  const config = JSON.parse(await readFile(join(f.namespace, 'config.json'), 'utf8')) as {
    idleMs: number;
  };
  config.idleMs = 300;
  await writeFile(join(f.namespace, 'config.json'), JSON.stringify(config));
  const snapshot = join(f.directory, `snapshot-${Date.now()}.json`);
  const capture = await f.cli(cwd, ['authored', 'capture', '--path', 'src', '--out', snapshot]);
  expect(capture.code, capture.stderr).toBe(0);
  const slot = await f.cli(cwd, [
    'slot',
    'create',
    'a',
    '--snapshot',
    snapshot,
    '--pristine-repository',
    f.pristine,
  ]);
  expect(slot.code, slot.stderr).toBe(0);
  return snapshot;
}

const jobId = (line: string): string => line.split(' ')[0] ?? '';

describe('job CLI, end to end', () => {
  it('submits from a git worktree with no capability flags, and exits by verdict', async () => {
    const f = await flow();
    const worktree = join(f.directory, 'worktree');
    execFileSync('git', ['-C', f.project, 'worktree', 'add', '-q', '--detach', worktree]);
    const snapshot = await provision(f, worktree);
    const request = join(f.directory, 'request.json');
    await writeFile(request, JSON.stringify({ steps: [{ command: 'status', args: [] }] }));

    const submitted = await f.cli(worktree, ['job', 'submit', request, '--snapshot', snapshot]);
    expect(submitted.code, submitted.stderr).toBe(0);
    const id = jobId(submitted.stdout);
    const waited = await f.cli(worktree, ['job', 'wait', id, '--timeout', '90']);
    expect(waited.code, `${waited.stdout}${waited.stderr}`).toBe(0);
    expect(waited.stdout.trim().split('\n')).toHaveLength(1);
    expect(waited.stdout).toMatch(new RegExp(`^${id} passed slot=a`));

    const record = await f.cli(worktree, ['job', 'status', id, '--json']);
    expect(record.code).toBe(0);
    expect(JSON.parse(record.stdout)).toMatchObject({ id, state: 'passed' });

    const listed = await f.cli(worktree, ['job', 'list']);
    expect(listed.stdout).toContain(id);
  }, 300_000);

  it('a red job exits nonzero, keeps the slot, and tells a timeout from a failure', async () => {
    const f = await flow();
    const snapshot = await provision(f, f.project);
    const redRequest = join(f.directory, 'red.json');
    await writeFile(
      redRequest,
      JSON.stringify({ steps: [{ command: 'status', args: ['--fail-on', 'x'] }] })
    );
    const red = await f.cli(f.project, ['job', 'submit', redRequest, '--snapshot', snapshot]);
    const id = jobId(red.stdout);
    const waited = await f.cli(f.project, ['job', 'wait', id, '--timeout', '90']);
    expect(waited.code, waited.stdout).toBe(ExitCode.JOB_FAILED);
    expect((await f.cli(f.project, ['job', 'status', id])).code).toBe(ExitCode.JOB_FAILED);

    // An unknown job is a plain refusal, not a stack.
    const unknown = await f.cli(f.project, ['job', 'status', 'nope']);
    expect(unknown.code).toBe(ExitCode.GENERAL_ERROR);
    expect(`${unknown.stdout}${unknown.stderr}`).toContain('Unknown job: nope');
    expect(`${unknown.stdout}${unknown.stderr}`).not.toContain('Unexpected error');

    // The slot came back, so the very same request is new work and can pass or fail again.
    const slots = await f.cli(f.project, ['slot', 'list']);
    expect(slots.stdout).toMatch(/^a source=\S+ generation=\d+/);
    expect(slots.stdout).not.toContain('quarantined');
    const again = await f.cli(f.project, ['job', 'submit', redRequest, '--snapshot', snapshot]);
    expect(jobId(again.stdout)).not.toBe(id);
    const timedOut = await f.cli(f.project, ['job', 'wait', jobId(again.stdout), '--timeout', '0']);
    expect(timedOut.code).toBe(ExitCode.JOB_WAIT_TIMEOUT);
    expect(
      (await f.cli(f.project, ['job', 'wait', jobId(again.stdout), '--timeout', '90'])).code
    ).toBe(ExitCode.JOB_FAILED);
  }, 300_000);

  it('a read never starts a supervisor', async () => {
    const f = await flow();
    const snapshot = await provision(f, f.project);
    const request = join(f.directory, 'request.json');
    await writeFile(request, JSON.stringify({ steps: [{ command: 'status', args: [] }] }));
    const id = jobId(
      (await f.cli(f.project, ['job', 'submit', request, '--snapshot', snapshot])).stdout
    );
    await f.cli(f.project, ['job', 'wait', id, '--timeout', '90']);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const up = await readFile(join(f.namespace, 'endpoint.json')).then(
        () => true,
        () => false
      );
      if (!up) break;
      await new Promise((settle) => setTimeout(settle, 50));
    }
    await expect(readFile(join(f.namespace, 'endpoint.json'))).rejects.toThrow(/ENOENT/);

    for (const args of [
      ['job', 'status', id],
      ['job', 'list'],
      ['job', 'logs', id],
      ['job', 'wait', id, '--timeout', '1'],
    ])
      expect((await f.cli(f.project, args)).code).toBe(0);
    await new Promise((settle) => setTimeout(settle, 300));
    await expect(readFile(join(f.namespace, 'endpoint.json'))).rejects.toThrow(/ENOENT/);
  }, 300_000);

  it('a caller’s environment does not reach the supervisor or the job, and refusals name the cause', async () => {
    const f = await flow();
    const snapshot = await provision(f, f.project);
    const session = join(f.directory, 'an-agents-session-tmp');
    await mkdir(session);
    const request = join(f.directory, 'request.json');
    await writeFile(
      request,
      JSON.stringify({
        steps: [
          { command: 'status', args: [] },
          { command: 'status', args: [] },
        ],
      })
    );
    // The first client to touch the coordinator is the one that spawns its supervisor.
    const id = jobId(
      (
        await f.cli(f.project, ['job', 'submit', request, '--snapshot', snapshot], {
          MOZ_HOSTILE: 'yes',
          TMPDIR: session,
        })
      ).stdout
    );
    const endpoint = JSON.parse(await readFile(join(f.namespace, 'endpoint.json'), 'utf8')) as {
      socket: string;
      owner: { pid: number };
    };
    expect(endpoint.socket.startsWith(session)).toBe(false);
    if (process.platform === 'darwin') {
      const environment = execFileSync(
        'ps',
        ['eww', '-o', 'command=', '-p', String(endpoint.owner.pid)],
        { encoding: 'utf8' }
      );
      expect(environment).toContain('FIREFORGE_COORDINATOR=');
      expect(environment).not.toContain('MOZ_HOSTILE');
      expect(environment).not.toContain(session);
    }
    expect((await f.cli(f.project, ['job', 'wait', id, '--timeout', '90'])).code).toBe(0);

    const missing = await f.cli(f.project, ['slot', 'audit', 'typo']);
    expect(missing.code).toBe(ExitCode.GENERAL_ERROR);
    expect(missing.stdout + missing.stderr).toContain('Slot typo does not exist');
    expect(missing.stdout + missing.stderr).not.toContain('Unexpected error');
    const bad = join(f.directory, 'bad.json');
    await writeFile(bad, JSON.stringify({ steps: [{ command: 'lint', args: ['--help'] }] }));
    const refused = await f.cli(f.project, ['job', 'submit', bad, '--snapshot', snapshot]);
    expect(refused.code).toBe(ExitCode.GENERAL_ERROR);
    expect(refused.stdout + refused.stderr).toContain('Unsupported immutable-job option: --help');
    expect(refused.stdout + refused.stderr).not.toMatch(/Error: Error:|Unexpected error/);
    const manifestless = join(f.directory, 'manifestless.json');
    await writeFile(manifestless, JSON.stringify({ steps: [{ command: 'build', args: [] }] }));
    const early = await f.cli(f.project, ['job', 'submit', manifestless, '--snapshot', snapshot]);
    expect(early.code).toBe(ExitCode.GENERAL_ERROR);
    expect(early.stdout + early.stderr).toContain('fireforge host init');
  }, 300_000);
});
