// SPDX-License-Identifier: EUPL-1.2
/** `job run --run` as a person runs it: real processes, a real supervisor, a fake mach whose window can be held open. */
import { spawn } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import {
  type HostFixture,
  hostFixture,
  lintClean,
  removeHostFixture,
} from '../../core/jobs/__tests__/host-fixture.js';
import { readJournal } from '../../core/jobs/store.js';
import { ExitCode } from '../../errors/codes.js';

const fixtures: HostFixture[] = [];
afterAll(async () => {
  await Promise.all(fixtures.splice(0).map(removeHostFixture));
}, 120_000);

const packageRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const entry = join(packageRoot, 'bin/fireforge.ts');
const loader = join(packageRoot, 'src/core/jobs/source-loader-bootstrap.cjs');

async function host(options: Parameters<typeof hostFixture>[0] = {}): Promise<HostFixture> {
  const f = await hostFixture(options);
  fixtures.push(f);
  const init = await f.cli(f.project, ['host', 'init', '--slots', '1', '--from-engine', f.donor]);
  expect(init.code, init.stdout + init.stderr).toBe(0);
  return f;
}

/** The CLI as a terminal runs it, so a test can wait for a line and then press Ctrl-C. */
function attached(
  f: HostFixture,
  args: string[]
): {
  seen: (text: string) => Promise<void>;
  signal: (name: NodeJS.Signals) => void;
  done: Promise<{ code: number; stdout: string; stderr: string }>;
} {
  const child = spawn(process.execPath, ['--import', loader, entry, ...args], {
    cwd: f.project,
    env: {
      PATH: process.env['PATH'],
      HOME: process.env['HOME'],
      FIREFORGE_COORDINATOR: f.namespace,
      FIREFORGE_TOOLCHAINS: f.toolchains,
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const done = new Promise<{ code: number; stdout: string; stderr: string }>((settle) => {
    child.on('exit', (code) => {
      settle({ code: code ?? 1, stdout, stderr });
    });
  });
  return {
    seen: async (text) => {
      for (let waited = 0; !stdout.includes(text); waited += 50) {
        if (waited > 120_000) throw new Error(`Never saw "${text}":\n${stdout}\n${stderr}`);
        await new Promise((settle) => setTimeout(settle, 50));
      }
    },
    signal: (name) => {
      child.kill(name);
    },
    done,
  };
}

describe.concurrent('fireforge job run --run', () => {
  it('opens the browser, streams its output, keeps a named profile across runs, and Ctrl-C cancels it', async () => {
    const f = await host();
    const profile = join(f.directory, 'profiles', 'dev');

    const first = await f.cli(f.project, [
      'job',
      'run',
      '--run',
      '--build',
      'full',
      '--profile',
      profile,
      '--',
      'about:blank',
    ]);
    expect(first.code, first.stdout + first.stderr).toBe(0);
    expect(first.stdout).toContain('--- step 0: build');
    expect(first.stdout).toContain('--- step 1: run -- about:blank');
    expect(first.stdout).toMatch(
      /ran the browser .*'-profile', '[^']*profiles\/dev'.*'about:blank'/
    );
    expect(first.stdout).toContain('profile sessions 1');
    // The verdict comes last, after everything the browser said.
    expect(first.stdout.trim().split('\n').at(-1)).toMatch(/^\S+ passed slot=a /);

    // The default build is a UI one, and the profile remembers the first session.
    const second = await f.cli(f.project, ['job', 'run', '--run', '--profile', profile]);
    expect(second.code, second.stdout + second.stderr).toBe(0);
    expect(second.stdout).toContain('--- step 0: build --ui');
    expect(second.stdout).toContain('profile sessions 2');
    expect(await readFile(join(profile, 'fake-mach-sessions'), 'utf8')).toBe('session\nsession\n');

    // Ctrl-C while the window is open cancels the job through the normal path.
    const hold = join(profile, 'fake-mach-hold');
    await writeFile(hold, 'hold');
    const session = attached(f, ['job', 'run', '--run', '--build', 'none', '--profile', profile]);
    await session.seen('holding the window open');
    session.signal('SIGINT');
    const stopped = await session.done;
    expect(stopped.code, stopped.stdout + stopped.stderr).toBe(ExitCode.JOB_STOPPED);
    expect(stopped.stderr).toContain('SIGINT, cancelling');
    expect(stopped.stdout.trim().split('\n').at(-1)).toMatch(/^\S+ cancelled slot=a /);
    const cancelled = [...(await readJournal(f.namespace)).values()].filter(
      (job) => job.state === 'cancelled'
    );
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]?.request.steps.at(-1)).toMatchObject({ interactive: true, profile });
    await rm(hold);

    // The slot came back clean, and a fresh-profile run takes it.
    const slots = await f.cli(f.project, ['slot', 'list']);
    expect(slots.stdout).not.toContain('quarantined');
    const fresh = await f.cli(f.project, ['job', 'run', '--run', '--build', 'none']);
    expect(fresh.code, fresh.stdout + fresh.stderr).toBe(0);
    expect(fresh.stdout).toMatch(/ran the browser .*fireforge-run-profile-/);
    expect(await readFile(join(profile, 'fake-mach-sessions'), 'utf8')).toBe(
      'session\nsession\nsession\n'
    );
  }, 300_000);

  it('keeps a profile only outside every slot, the namespace and tracked source', async () => {
    const f = await host();
    const refused = async (profile: string, says: string): Promise<void> => {
      const result = await f.cli(f.project, ['job', 'run', '--run', '--profile', profile]);
      expect(result.code, `${profile}\n${result.stdout}${result.stderr}`).not.toBe(0);
      expect(result.stdout + result.stderr, profile).toContain(says);
    };
    await refused(join(f.namespace, 'slots', 'a', 'root', 'profile'), 'targets slot a');
    await refused(join(f.namespace, 'profiles', 'dev'), 'inside the coordinator namespace');
    await refused(join(f.project, 'src', 'profile'), "inside this checkout's tracked source");
    await refused('profiles/dev', 'absolute directory');
    // None of them reached the coordinator.
    const sessions = [...(await readJournal(f.namespace)).values()].filter((job) =>
      job.request.steps.some((step) => step.interactive === true)
    );
    expect(sessions).toHaveLength(0);

    // A source-mode refusal names the command that works.
    const direct = await f.cli(f.project, ['run']);
    expect(direct.code).not.toBe(0);
    expect(direct.stdout + direct.stderr).toContain('fireforge job run --run');
  }, 300_000);

  it('writes a test’s named files into the job’s artifacts, and says where each landed', async () => {
    const test = 'browser/themes/test/browser_tabs.js';
    const f = await host({
      projectFiles: { [`src/${test}`]: lintClean("add_task(() => ok(true, 'tabs'));\n") },
    });
    const escaped = await f.cli(f.project, ['job', 'run', '--test', test, '--keep-log', '../x']);
    expect(escaped.code).toBe(ExitCode.INVALID_ARGUMENT);
    expect(escaped.stdout + escaped.stderr).toContain('plain relative path');
    const run = await f.cli(f.project, [
      'job',
      'run',
      '--build',
      'full',
      '--test',
      test,
      '--keep-log',
      'logs/harness.log',
    ]);
    expect(run.code, run.stdout + run.stderr).toBe(0);
    const landed = /--keep-log: (\S+)/.exec(run.stderr)?.[1] ?? '';
    expect(landed).toMatch(/artifacts\/[0-9a-f-]+\/step-1-output\/logs\/harness\.log$/);
    expect(await readFile(landed, 'utf8')).not.toBe('');
  }, 300_000);
});
