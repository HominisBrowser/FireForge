// SPDX-License-Identifier: EUPL-1.2
/** What a lane or an ad hoc job declares about its process, seen from inside a real job with a fake mach. */
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { ExitCode } from '../../../errors/codes.js';
import { writeAt } from '../../authored/__tests__/fixtures.js';
import { readJournal } from '../store.js';
import { type HostFixture, hostFixture, lintClean, removeHostFixture } from './host-fixture.js';

const fixtures: HostFixture[] = [];
// Every test has its own host, so they run side by side. That is what keeps this file from setting the suite's duration.
afterAll(async () => {
  await Promise.all(fixtures.splice(0).map(removeHostFixture));
}, 120_000);

const TEST = 'browser/themes/test/browser_tabs.js';

interface Recorded {
  env: Record<string, string>;
  args: string[];
}

/** A host with slots, and a test that records what its harness process saw. */
async function host(
  options: Parameters<typeof hostFixture>[0] = {},
  slots = 1
): Promise<{ f: HostFixture; record: string }> {
  const f = await hostFixture(options);
  fixtures.push(f);
  const init = await f.cli(f.project, [
    'host',
    'init',
    '--slots',
    String(slots),
    '--from-engine',
    f.donor,
  ]);
  expect(init.code, init.stdout + init.stderr).toBe(0);
  const record = join(f.directory, 'harness.json');
  await writeAt(
    f.project,
    `src/${TEST}`,
    lintClean(`// fake-mach-record ${record}\nadd_task(() => ok(true, 'tabs'));\n`)
  );
  return { f, record };
}

const recorded = async (path: string): Promise<Recorded> =>
  JSON.parse(await readFile(path, 'utf8')) as Recorded;

const output = (line: string): string => /output=(\S+)/.exec(line)?.[1] ?? '';

describe.concurrent('a declared step environment', () => {
  it('reaches the harness, and a mach pref with it, with the upload directory private per slot', async () => {
    const { f, record } = await host({}, 2);
    const run = (slot: string): Promise<{ code: number; stdout: string; stderr: string }> =>
      f.cli(f.project, [
        'job',
        'run',
        '--slot',
        slot,
        '--build',
        'full',
        '--test',
        TEST,
        '--env',
        'PROJECT_CAPTURE=1',
        'PROJECT_FIGURES={artifacts}/figures.json',
        '--upload-dir',
        '--mach-arg',
        '--setpref=focusmanager.testmode=true',
      ]);
    const first = await run('a');
    expect(first.code, first.stdout + first.stderr).toBe(0);
    const seen = await recorded(record);
    expect(seen.env['PROJECT_CAPTURE']).toBe('1');
    expect(seen.args).toContain('--setpref=focusmanager.testmode=true');
    const pathA = output(first.stdout);
    expect(pathA).toContain(join('artifacts', first.stdout.split(' ')[0] ?? ''));
    expect(seen.env['MOZ_UPLOAD_DIR']).toBe(pathA);
    expect(seen.env['PROJECT_FIGURES']).toBe(`${pathA}/figures.json`);
    expect(await readFile(join(pathA, 'modifiedPrefs.json'), 'utf8')).toContain('slots/a');

    const second = await run('b');
    expect(second.code, second.stdout + second.stderr).toBe(0);
    const pathB = output(second.stdout);
    expect(pathB).not.toBe(pathA);
    expect(await readFile(join(pathB, 'modifiedPrefs.json'), 'utf8')).toContain('slots/b');
    // The other slot's census is still its own.
    expect(await readFile(join(pathA, 'modifiedPrefs.json'), 'utf8')).toContain('slots/a');

    const job = second.stdout.split(' ')[0] ?? '';
    const status = await f.cli(f.project, ['job', 'status', job]);
    expect(status.stdout).toContain(`output=${pathB}`);
    const machine = JSON.parse(
      (await f.cli(f.project, ['job', 'status', job, '--json'])).stdout
    ) as { outputs: Array<{ step: number; path: string }> };
    expect(machine.outputs).toEqual([{ step: 1, path: pathB }]);
    // The receipt says what the step declared, with no path in it.
    const sealed = (await readJournal(f.namespace)).get(job)?.receipt?.steps[1];
    expect(sealed?.env).toEqual({
      PROJECT_CAPTURE: '1',
      PROJECT_FIGURES: '{artifacts}/figures.json',
    });
  }, 300_000);

  it('never carries an owned or foreign value into the harness when nothing is declared', async () => {
    const { f, record } = await host();
    const run = await f.cli(f.project, ['job', 'run', '--build', 'full', '--test', TEST], {
      MOZ_UPLOAD_DIR: '/tmp/a-callers-directory',
      PROJECT_CAPTURE: 'from-the-caller',
    });
    expect(run.code, run.stdout + run.stderr).toBe(0);
    const seen = await recorded(record);
    expect(seen.env['MOZ_UPLOAD_DIR']).toBeUndefined();
    expect(seen.env['PROJECT_CAPTURE']).toBeUndefined();
    expect(run.stdout).not.toContain('output=');
  }, 300_000);

  it('refuses at submit a name, value or mach argument that would subvert the executor', async () => {
    const { f } = await host();
    const refused = [
      ['--env', 'FIREFORGE_JOB_ID=x'],
      ['--env', 'PATH=/tmp'],
      ['--env', 'NODE_OPTIONS=--require=x'],
      ['--env', 'MOZ_UPLOAD_DIR=x'],
      ['--env', 'DYLD_INSERT_LIBRARIES=x'],
      ['--env', 'lower=x'],
      ['--env', 'NOEQUALS'],
      ['--env', 'PROJECT_DIR=/etc'],
      ['--env', 'PROJECT_DIR=../outside'],
      ['--env', 'PROJECT_DIR={artifacts}/../outside'],
      ['--mach-arg', '--log-raw=x.json'],
      ['--mach-arg', '--setenv=PATH=x'],
      ['--mach-arg', '--setpref=marionette.port=2828'],
      ['--mach-arg', '--setpref=a=/etc/passwd'],
    ];
    for (const args of refused) {
      const run = await f.cli(f.project, ['job', 'run', '--test', TEST, ...args]);
      expect(run.code, args.join(' ')).not.toBe(0);
      expect(run.code, args.join(' ')).not.toBe(ExitCode.JOB_FAILED);
      expect(run.stdout + run.stderr).toMatch(/refused|must be|takes NAME|outside|Unsupported/);
    }
    expect((await readJournal(f.namespace)).size).toBe(1);

    // By hand too: a request naming env on a build would change a binary its anchor cannot see.
    const snapshot = join(f.directory, 'snapshot.json');
    expect((await f.cli(f.project, ['authored', 'capture', '--out', snapshot])).code).toBe(0);
    const request = join(f.directory, 'request.json');
    await writeFile(
      request,
      JSON.stringify({ steps: [{ command: 'build', args: [], env: { PROJECT_CAPTURE: '1' } }] })
    );
    const build = await f.cli(f.project, ['job', 'submit', request, '--snapshot', snapshot]);
    expect(build.code).not.toBe(0);
    expect(build.stdout + build.stderr).toContain('apply to a test or run');
  }, 300_000);

  it('binds evidence: a test under other environment proves nothing about this lane', async () => {
    const { f } = await host({
      proof: {
        gate: {
          lanes: [
            {
              id: 'captures',
              files: [TEST],
              env: { PROJECT_CAPTURE: '1' },
              uploadDir: true,
              machArgs: ['--setpref=focusmanager.testmode=true'],
            },
          ],
        },
      },
    });
    const state = async (): Promise<string | undefined> => {
      const report = JSON.parse((await f.cli(f.project, ['prove', 'status', '--json'])).stdout) as {
        obligations: Array<{ id: string; state: string; output?: string }>;
      };
      return report.obligations.find((entry) => entry.id === `test:${TEST}`)?.state;
    };
    const declared = [
      '--env',
      'PROJECT_CAPTURE=1',
      '--upload-dir',
      '--mach-arg',
      '--setpref=focusmanager.testmode=true',
    ];
    // The lane's shape applies to its file by itself, so a bare run of it counts for nothing.
    const bare = await f.cli(f.project, ['job', 'run', '--build', 'full', '--test', TEST]);
    expect(bare.code, bare.stdout + bare.stderr).toBe(0);
    expect(await state()).toBe('outstanding');
    const other = await f.cli(f.project, [
      'job',
      'run',
      '--test',
      TEST,
      '--build',
      'none',
      ...declared.map((arg) => (arg === 'PROJECT_CAPTURE=1' ? 'PROJECT_CAPTURE=2' : arg)),
    ]);
    expect(other.code, other.stdout + other.stderr).toBe(0);
    expect(await state()).toBe('outstanding');
    const same = await f.cli(f.project, [
      'job',
      'run',
      '--test',
      TEST,
      '--build',
      'none',
      ...declared,
    ]);
    expect(same.code, same.stdout + same.stderr).toBe(0);
    expect(await state()).toBe('passed');
    // Whichever slot and job proved it, the report names where its output went.
    const report = await f.cli(f.project, ['prove', 'status']);
    expect(report.stdout).toContain(`output=${output(same.stdout)}`);
  }, 300_000);
});

const onDarwin = process.platform === 'darwin' ? describe.concurrent : describe.skip;

onDarwin('keep-awake', () => {
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  /** The assertion processes a job's log names. */
  const holds = async (f: HostFixture, job: string): Promise<number[]> =>
    [
      ...(await readFile(join(f.namespace, 'logs', `${job}.log`), 'utf8').catch(() => '')).matchAll(
        /FIREFORGE-KEEP-AWAKE: pid=(\d+)/g
      ),
    ].map((match) => Number(match[1]));

  /** What a check first yields once it yields anything. A concurrent test has no `expect.poll`. */
  async function settled<T>(check: () => Promise<T>): Promise<NonNullable<T>> {
    for (let attempt = 0; attempt < 1_200; attempt += 1) {
      const value = await check();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Timed out waiting for the phase');
  }

  const quarantined = async (f: HostFixture): Promise<string | null> =>
    (
      JSON.parse(await readFile(join(f.namespace, 'slots', 'a', 'slot.json'), 'utf8')) as {
        quarantined: string | null;
      }
    ).quarantined;

  it('a headed step holds it by default, and it is gone when the phase ends', async () => {
    const { f } = await host();
    const run = async (...args: string[]): Promise<number[]> => {
      const result = await f.cli(f.project, ['job', 'run', ...args, '--test', TEST]);
      expect(result.code, result.stdout + result.stderr).toBe(0);
      return holds(f, result.stdout.split(' ')[0] ?? '');
    };
    // The build step has no window, so only the test holds it.
    const headed = await run('--build', 'full', '--headed');
    expect(headed).toHaveLength(1);
    expect(alive(headed[0] ?? 0)).toBe(false);
    // Not a survivor of the phase: the census was clean and the slot needs no restore.
    expect(await quarantined(f)).toBeNull();
    expect(await run('--build', 'none', '--headed', '--no-keep-awake')).toHaveLength(0);
    expect(await run('--build', 'none')).toHaveLength(0);
    const asked = await run('--build', 'none', '--keep-awake');
    expect(asked).toHaveLength(1);
    expect(alive(asked[0] ?? 0)).toBe(false);
  }, 300_000);

  it('holds it while the phase runs, on its executor, and a cancel takes it down with the phase', async () => {
    const { f } = await host();
    const built = await f.cli(f.project, ['job', 'run', '--build', 'full']);
    expect(built.code, built.stdout + built.stderr).toBe(0);
    const hold = join(f.directory, 'hold');
    await writeFile(hold, 'hold');
    await writeAt(
      f.project,
      `src/${TEST}`,
      lintClean(`// fake-mach-hold ${hold}\nadd_task(() => ok(true, 'tabs'));\n`)
    );
    const running = f.cli(f.project, ['job', 'run', '--build', 'ui', '--headed', '--test', TEST]);
    const live = async (): Promise<string | undefined> =>
      [...(await readJournal(f.namespace)).values()].find(
        (entry) => entry.state === 'running' && entry.phase?.index === 1
      )?.id;
    const job = await settled(live);
    await settled(async () => (await holds(f, job)).length > 0);
    const pid = (await holds(f, job))[0] ?? 0;
    expect(alive(pid)).toBe(true);
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
    }).trim();
    expect(command).toMatch(/caffeinate -disu -w \d+$/);
    const executor = (await readJournal(f.namespace)).get(job)?.process?.pid;
    expect(command.endsWith(`-w ${String(executor)}`)).toBe(true);

    expect((await f.cli(f.project, ['job', 'cancel', job])).code).toBe(0);
    const stopped = await running;
    expect(stopped.code, stopped.stdout + stopped.stderr).toBe(ExitCode.JOB_STOPPED);
    expect(alive(pid)).toBe(false);
    expect(await quarantined(f)).toBeNull();
  }, 300_000);
});
