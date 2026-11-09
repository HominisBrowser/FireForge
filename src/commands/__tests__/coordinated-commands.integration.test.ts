// SPDX-License-Identifier: EUPL-1.2
/**
 * The commands an agent runs, in this process, against a real coordinator and a
 * fake mach. The end-to-end suites run the same flows as subprocesses, which proves
 * them and leaves these modules unmeasured; this one is what the coverage gate reads.
 */
import { execFileSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { writeAt } from '../../core/authored/__tests__/fixtures.js';
import {
  type HostFixture,
  hostFixture,
  lintClean,
  removeHostFixture,
} from '../../core/jobs/__tests__/host-fixture.js';
import { CommandError, GeneralError, InvalidArgumentError } from '../../errors/base.js';
import { ExitCode } from '../../errors/codes.js';
import { registerAuthored } from '../authored.js';
import { registerHost } from '../host.js';
import { registerJob } from '../job.js';
import { registerProve } from '../prove.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const TEST = 'browser/themes/test/browser_tabs.js';
const GUARD = 'browser/scenes/test/browser_guard.js';
const CSS = 'browser/themes/shared/tabs.css';

let f: HostFixture;
const argv = process.argv;

function git(...args: string[]): string {
  return execFileSync(
    'git',
    ['-C', f.project, '-c', 'user.email=f@example.invalid', '-c', 'user.name=f', ...args],
    { encoding: 'utf8' }
  ).trim();
}

/** Runs the CLI in this process, returning what it printed and how it ended. */
async function run(...args: string[]): Promise<{ out: string; code: number; error?: Error }> {
  const program = new Command().exitOverride();
  program.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
  const context = {
    getProjectRoot: () => f.project,
    withErrorHandling:
      <T extends unknown[]>(handler: (...values: T) => Promise<void>) =>
      (...values: T) =>
        handler(...values),
  };
  registerHost(program, context);
  registerJob(program, context);
  registerProve(program, context);
  registerAuthored(program, context);
  const writes: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  process.argv = ['node', 'fireforge', ...args];
  try {
    await program.parseAsync(['node', 'fireforge', ...args]);
    return { out: writes.join(''), code: 0 };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const code = error instanceof CommandError ? error.exitCode : 1;
    return { out: writes.join(''), code, error };
  } finally {
    process.argv = argv;
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

const passed = async (...args: string[]): Promise<string> => {
  const result = await run(...args);
  expect(result.code, `${args.join(' ')}\n${result.out}\n${String(result.error)}`).toBe(0);
  return result.out;
};

const report = async (
  ...args: string[]
): Promise<{
  complete: boolean;
  verdict: string;
  obligations: Array<{ id: string; state: string; output?: string }>;
}> => JSON.parse((await passed(...args, '--json')).trim()) as never;

const state = (value: Awaited<ReturnType<typeof report>>, id: string): string | undefined =>
  value.obligations.find((entry) => entry.id === id)?.state;

beforeAll(async () => {
  f = await hostFixture({
    proof: {
      noneRoutes: ['tools/**'],
      gate: {
        lanes: [
          {
            id: 'tabs',
            files: ['browser/themes/test/browser_*.js'],
            dispatch: 'one-browser',
            uploadDir: true,
            env: { PROJECT_FIGURES: '{artifacts}/figures.json' },
          },
        ],
        controls: [
          { id: 'guard', diff: 'tools/guard.diff', test: GUARD, assertions: ['ok'], always: true },
        ],
        runs: [{ id: 'smoke', args: ['--headless', '--smoke-exit', '1'], uploadDir: true }],
        acceptance: [{ id: 'scene', reason: 'A person looks at the tab strip.' }],
      },
    },
  });
  vi.stubEnv('FIREFORGE_COORDINATOR', f.namespace);
  vi.stubEnv('FIREFORGE_TOOLCHAINS', f.toolchains);
  await writeAt(
    f.project,
    'tools/guard.diff',
    '--- a/browser/scenes/notes.md\n+++ b/browser/scenes/notes.md\n@@ -1 +1 @@\n-note\n+99px\n'
  );
  git('add', '-A');
  git('commit', '-qm', 'the control');
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await removeHostFixture(f);
});

describe('the coordinated commands, in order', () => {
  it('host init readies a slot, and refuses a bad count', async () => {
    const init = await passed('host', 'init', '--slots', '1', '--from-engine', f.donor);
    expect(init).toContain('Coordinator');
    expect(init).toContain('Toolchain');
    expect(init).toContain('Slot a:');
    const again = await passed(
      'host',
      'init',
      '--from-engine',
      f.donor,
      '--cpu',
      '4',
      '--memory',
      '4'
    );
    expect(again).toContain('reused');
    const zero = await run('host', 'init', '--slots', 'x');
    expect(zero.error?.message).toContain('--slots');
    const restored = await passed('host', 'init', '--cpu', '14', '--memory', '28');
    expect(restored).toContain('cpu=14');
  });

  it('job run says what it refuses, passes and fails', async () => {
    expect((await run('job', 'run', '--build', 'fast')).error).toBeInstanceOf(InvalidArgumentError);
    expect((await run('job', 'run', '--timeout', '0')).error?.message).toContain('--timeout');
    const env = await run('job', 'run', '--test', TEST, '--env', 'PATH=/x');
    expect(env.error?.message).toContain('executor owns');
    for (const shape of [['--headed'], ['--no-shard'], ['--upload-dir'], ['--env', 'PROJECT_A=1']])
      expect((await run('job', 'run', '--check', ...shape)).error).toBeInstanceOf(
        InvalidArgumentError
      );

    await passed('authored', 'override', CSS);
    await writeFile(join(f.project, 'src', CSS), lintClean(':root { --tab-radius: 6px; }\n'));
    const marker = join(f.directory, 'red');
    await writeAt(
      f.project,
      `src/${TEST}`,
      lintClean(`// fake-mach-red-while ${marker}\nadd_task(() => ok(true, 'tabs'));\n`)
    );
    const full = await passed('job', 'run', '--build', 'full', '--owner', 'me');
    expect(full).toContain(' passed ');
    expect(full).toContain('owner=me');

    await writeFile(marker, 'red');
    const red = await run(
      'job',
      'run',
      '--test',
      TEST,
      '--no-shard',
      '--headed',
      '--no-keep-awake',
      '--upload-dir',
      '--env',
      'PROJECT_CAPTURE=1',
      '--mach-arg',
      '--setpref=a.b=1',
      '--slot',
      'a',
      '--timeout',
      '200',
      '--path',
      'configs/common.mozconfig'
    );
    expect(red.code).toBe(ExitCode.JOB_FAILED);
    expect(red.out).toContain(' failed ');
    expect(red.out).toContain('output=');
    await rm(marker);
    expect(await passed('job', 'run', '--check', '--json')).toContain('"state":"passed"');
  });

  it('job run --run opens the browser in a slot, streams it, and keeps a profile only where it may', async () => {
    const refused = async (args: string[], says: string): Promise<void> => {
      const result = await run('job', 'run', ...args);
      expect(result.error, args.join(' ')).toBeInstanceOf(InvalidArgumentError);
      expect(result.error?.message, args.join(' ')).toContain(says);
    };
    await refused(['--run', '--test', TEST], 'name no --test, --check or --release');
    await refused(['--run', '--check'], 'name no --test, --check or --release');
    await refused(['--run', '--release'], 'name no --test, --check or --release');
    await refused(['--run', '--timeout', '5'], 'drop --timeout');
    await refused(['--run', '--headed'], 'name them with --test');
    await refused(['--profile', join(f.directory, 'p')], 'name it with --run');
    await refused(['--check', '--', 'about:blank'], 'name them with --run');
    await refused(['--run', '--profile', 'relative/p'], 'absolute directory');
    await refused(['--run', '--profile', join(f.project, 'src', 'p')], 'tracked source');
    const namespaced = await run('job', 'run', '--run', '--profile', join(f.namespace, 'p'));
    expect(namespaced.error?.message).toContain('inside the coordinator namespace');

    const profile = join(f.directory, 'profiles', 'in-process');
    const opened = await passed(
      'job',
      'run',
      '--run',
      '--build',
      'none',
      '--no-keep-awake',
      '--profile',
      profile,
      '--',
      'about:blank'
    );
    expect(opened).toContain('--- step 0: run -- about:blank');
    expect(opened).toContain('ran the browser');
    expect(opened).toContain('profile sessions 1');
    expect(opened.trim().split('\n').at(-1)).toContain(' passed ');
    const machine = await passed('job', 'run', '--run', '--build', 'none', '--json');
    expect(JSON.parse(machine.trim())).toMatchObject({ state: 'passed' });
  });

  it('job reads say what is there, and a client never needs the supervisor for them', async () => {
    const listed = (await passed('job', 'list')).trim().split('\n');
    expect(listed.length).toBeGreaterThan(2);
    const id = listed.at(-1)?.split(' ')[0] ?? '';
    const newest = listed[0]?.split(' ')[0] ?? '';
    expect(await passed('job', 'status', newest)).toContain('passed');
    expect(JSON.parse(await passed('job', 'status', newest, '--json'))).toMatchObject({
      id: newest,
    });
    expect(
      (JSON.parse(await passed('job', 'list', '--json')) as { jobs: unknown[] }).jobs
    ).toHaveLength(listed.length);
    expect(await passed('job', 'wait', newest, '--timeout', '5')).toContain('passed');
    expect((await run('job', 'wait', newest, '--timeout', 'soon')).error?.message).toContain(
      '--timeout must be a non-negative whole number'
    );
    expect(await passed('job', 'logs', id, '--limit', '64')).not.toBe('');
    expect(JSON.parse(await passed('job', 'logs', id, '--json'))).toHaveProperty('nextOffset');
    expect(await passed('job', 'cancel', newest)).toContain('passed');
    expect(await passed('job', 'host-clear')).toContain('nothing to clear');
    expect(JSON.parse(await passed('job', 'host-clear', '--json'))).toEqual({
      schemaVersion: 1,
      cleared: [],
    });
    expect(JSON.parse(await passed('host', 'init', '--json'))).toHaveProperty('namespace');
    expect((await run('host', 'init', '--cpu', 'many')).error).toBeInstanceOf(InvalidArgumentError);
  });

  it('job submit takes a hand-written request against a captured snapshot', async () => {
    const snapshot = join(f.directory, 'snapshot.json');
    await passed('authored', 'capture', '--out', snapshot);
    const request = join(f.directory, 'request.json');
    await writeFile(request, JSON.stringify({ steps: [{ command: 'verify', args: [] }] }));
    const submitted = await passed(
      'job',
      'submit',
      request,
      '--snapshot',
      snapshot,
      '--owner',
      'hand',
      '--json'
    );
    const { id } = JSON.parse(submitted) as { id: string };
    expect(await passed('job', 'wait', id, '--timeout', '120')).toContain('passed');
  });

  it('prove runs what has no evidence, plans, queries, decides and refuses', async () => {
    expect((await run('prove', 'run', '--tier', 'nope')).error).toBeInstanceOf(
      InvalidArgumentError
    );
    expect((await run('prove', 'run', '--mode', 'nope')).error).toBeInstanceOf(
      InvalidArgumentError
    );
    expect((await run('prove', 'run', '--control', 'x')).error).toBeInstanceOf(
      InvalidArgumentError
    );

    const planned = await passed('prove', 'plan');
    expect(planned).toContain('would run:');
    expect(planned).toContain(`test:${TEST}`);
    const incomplete = await run('prove', 'status', '--complete');
    expect(incomplete.error?.message).toContain('proof-incomplete');
    const machine = await run('prove', 'status', '--complete', '--json');
    expect(machine.error?.message).toContain('proof-incomplete');

    const proved = await report('prove', 'run');
    expect(proved.complete).toBe(true);
    expect(state(proved, `test:${TEST}`)).toBe('passed');
    expect(await passed('prove', 'status', '--complete')).toContain('Proof complete');
    // A second run has nothing to do.
    expect((await report('prove', 'run')).complete).toBe(true);
    const narrowed = await report('prove', 'status', '--base', 'HEAD');
    expect(narrowed.verdict).toBeDefined();
    expect((await run('prove', 'run', '--base', 'no-such-ref')).code).not.toBe(0);

    // Decisions read as decisions.
    expect((await run('prove', 'accept', 'nothing', '--note', 'x')).error?.message).toContain(
      'proof-unknown-obligation'
    );
    expect((await run('prove', 'accept', 'static', '--note', 'x')).error?.message).toContain(
      'proof-accept-machine-obligation'
    );
    expect((await run('prove', 'waive', 'static', '--note', 'x')).error?.message).toContain(
      'proof-waive-machine-obligation'
    );
    expect(
      (await run('prove', 'waive', 'static', '--allow-machine', '--note', ' ')).error
    ).toBeInstanceOf(InvalidArgumentError);
    expect(
      await passed('prove', 'waive', 'static', '--allow-machine', '--note', 'Blocked upstream.')
    ).toContain('Proof');
  });

  it('the gate runs declared work, a person decides, and publish moves the ref', async () => {
    await writeAt(
      f.project,
      `src/${GUARD}`,
      lintClean(
        `// fake-mach-red-if browser/scenes/notes.md 99px\nadd_task(() => ok(true, 'g'));\n`
      )
    );
    await writeAt(f.project, 'src/browser/scenes/notes.md', 'note\n');
    git('add', '-A');
    git('commit', '-qm', 'candidate');
    const unmet = await run('prove', 'publish');
    expect(unmet.error).toBeInstanceOf(GeneralError);
    expect(unmet.error?.message).toContain('proof-publish-no-evidence');

    const queued = await passed('prove', 'run', '--tier', 'gate', '--no-wait');
    const id = queued.split(' ')[0] ?? '';
    expect(await passed('job', 'wait', id, '--timeout', '250')).toContain('passed');
    const waiting = await report('prove', 'status', '--tier', 'gate');
    expect(waiting.complete).toBe(false);
    expect(state(waiting, 'lane:tabs')).toBe('passed');
    expect(state(waiting, 'control:guard')).toBe('passed');
    expect(state(waiting, 'accept:scene')).toBe('outstanding');
    expect(waiting.obligations.find((entry) => entry.id === 'lane:tabs')?.output).toContain(id);
    const stopped = await run('prove', 'publish');
    expect(stopped.error?.message).toContain('accept:scene');

    const accepted = await passed(
      'prove',
      'accept',
      'accept:scene',
      '--tier',
      'gate',
      '--note',
      'Looked at it.'
    );
    expect(accepted).toContain('accepted by');
    const published = await passed('prove', 'publish');
    expect(published).toContain('refs/fireforge/verified created at');
    expect(git('rev-parse', 'refs/fireforge/verified')).toBe(git('rev-parse', 'HEAD'));
    expect(await passed('prove', 'publish')).toContain('moved from');
    expect(await readFile(join(f.project, 'fireforge.json'), 'utf8')).toContain('"proof"');
  });
});
