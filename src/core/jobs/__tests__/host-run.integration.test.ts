// SPDX-License-Identifier: EUPL-1.2
/** The two commands an agent actually runs, as real processes, from a linked worktree, against a fake mach. */
import { execFileSync } from 'node:child_process';
import { lstat, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { ExitCode } from '../../../errors/codes.js';
import { getPackageRoot } from '../../../utils/package-root.js';
import type { SlotRecord } from '../slot-types.js';
import { readJson, slotDirectory } from '../store.js';
import {
  type HostFixture,
  hostFixture,
  lintClean,
  MOZCONFIG,
  removeHostFixture,
} from './host-fixture.js';

const fixtures: HostFixture[] = [];
// Every test has its own host, so they run side by side. That is what keeps this file from setting the suite's duration.
afterAll(async () => {
  await Promise.all(fixtures.splice(0).map(removeHostFixture));
}, 120_000);

/** The tail of the newest job log, so a red names its cause. */
async function jobLogs(f: HostFixture): Promise<string> {
  const directory = join(f.namespace, 'logs');
  const names = await readdir(directory).catch(() => [] as string[]);
  const dated = await Promise.all(
    names.map(async (name) => ({ name, at: (await lstat(join(directory, name))).mtimeMs }))
  );
  const newest = dated.sort((x, y) => y.at - x.at)[0];
  return newest === undefined
    ? ''
    : (await readFile(join(directory, newest.name), 'utf8'))
        .split('\n')
        .filter((line) => !line.includes('NOTICE') && line.length < 400)
        .join('\n')
        .slice(-2_000);
}

async function initialized(
  slots = 1,
  options: Parameters<typeof hostFixture>[0] = {}
): Promise<{
  f: HostFixture;
  worktree: string;
}> {
  const f = await hostFixture(options);
  fixtures.push(f);
  const worktree = join(f.directory, 'worktree');
  execFileSync('git', ['-C', f.project, 'worktree', 'add', '-q', '--detach', worktree]);
  const init = await f.cli(worktree, [
    'host',
    'init',
    '--slots',
    String(slots),
    '--from-engine',
    f.donor,
  ]);
  expect(init.code, `${init.stdout}${init.stderr}${await jobLogs(f)}`).toBe(0);
  return { f, worktree };
}

const slotOf = (f: HostFixture, id: string): Promise<SlotRecord> =>
  readJson<SlotRecord>(join(slotDirectory(f.namespace, id), 'slot.json'));

describe.concurrent('fireforge host init', () => {
  it('takes one command from nothing to qualified slots, from a linked worktree, and is repeatable', async () => {
    const { f, worktree } = await initialized(2);
    const manifest = await readJson<{ digest: string; native: { executables: { CC: string } } }>(
      join(f.namespace, 'toolchain.json')
    );
    expect(manifest.native.executables.CC).toContain(f.toolchains);
    for (const id of ['a', 'b']) {
      const slot = await slotOf(f, id);
      expect(slot.quarantined).toBeNull();
      const qualified = await readJson<{ toolchainDigest: string; sites: unknown[] }>(
        join(slot.root, '.fireforge', 'native-qualified.json')
      );
      expect(qualified.toolchainDigest).toBe(manifest.digest);
      expect(qualified.sites).toHaveLength(3);
      // Configure ran, with the frozen tools, and agreed with the manifest.
      expect(
        await readFile(join(slot.root, 'engine/obj-fake/config.statusd/substs/CC'), 'utf8')
      ).toContain(f.toolchains);
    }
    const again = await f.cli(worktree, ['host', 'init', '--slots', '2', '--from-engine', f.donor]);
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toContain('reused');
    expect(again.stdout).not.toContain('Slot a: created');
  }, 300_000);

  it('refuses a project still on a patch queue before routing its builds anywhere', async () => {
    const f = await hostFixture();
    fixtures.push(f);
    const config = join(f.project, 'fireforge.json');
    const parsed = JSON.parse(await readFile(config, 'utf8')) as { sources?: unknown };
    delete parsed.sources;
    await writeFile(config, JSON.stringify(parsed));
    const init = await f.cli(f.project, ['host', 'init', '--slots', '1']);
    expect(init.code).not.toBe(0);
    expect(init.stdout + init.stderr).toContain('authored migrate');
    const stored = await readJson<{ projects: string[] }>(join(f.namespace, 'config.json'));
    expect(stored.projects).toEqual([]);
  }, 120_000);

  it('refuses every prove command in a queue project, naming the migration, before capturing', async () => {
    const f = await hostFixture();
    fixtures.push(f);
    const config = join(f.project, 'fireforge.json');
    const parsed = JSON.parse(await readFile(config, 'utf8')) as { sources?: unknown };
    delete parsed.sources;
    await writeFile(config, JSON.stringify(parsed));
    for (const command of [
      ['prove'],
      ['prove', 'plan'],
      ['prove', 'status'],
      ['prove', 'accept', 'accept:x', '--note', 'n'],
      ['prove', 'waive', 'x', '--note', 'n'],
      ['prove', 'publish'],
    ]) {
      const refused = await f.cli(f.project, command);
      expect(refused.code, command.join(' ')).toBe(ExitCode.INVALID_ARGUMENT);
      expect(refused.stdout + refused.stderr, command.join(' ')).toContain(
        'fireforge authored migrate'
      );
    }
    // A flag that cannot mean anything is a usage error before any question about the project.
    for (const flags of [
      ['--tier', 'bogus'],
      ['--mode', 'bogus'],
    ]) {
      const usage = await f.cli(f.project, ['prove', ...flags]);
      expect(usage.code).toBe(ExitCode.INVALID_ARGUMENT);
      expect(usage.stdout + usage.stderr).toContain(flags[0]);
    }
    await expect(lstat(join(f.project, '.git/refs/fireforge/snapshots'))).rejects.toThrow();
  }, 120_000);

  it('runs the README flow: a test on a host with no build refuses, naming the build that fixes it', async () => {
    const TEST = 'browser/browser_tabs.js';
    const f = await hostFixture({
      projectFiles: { [`src/${TEST}`]: lintClean("add_task(() => ok(true, 'a'));\n") },
    });
    fixtures.push(f);
    const readme = await readFile(join(getPackageRoot(), 'README.md'), 'utf8');
    expect(readme).toContain('npx fireforge job run --build full ');
    expect(readme).toMatch(/npx fireforge job run --test \S+/);
    const init = await f.cli(f.project, ['host', 'init', '--slots', '1', '--from-engine', f.donor]);
    expect(init.code, init.stdout + init.stderr).toBe(0);
    const refused = await f.cli(f.project, ['job', 'run', '--test', TEST]);
    expect(refused.code).toBe(ExitCode.GENERAL_ERROR);
    expect(refused.stdout + refused.stderr).toContain('fireforge job run --build full');
    expect(refused.stdout + refused.stderr).toContain(
      `fireforge job run --build full --test ${TEST}`
    );
    const built = await f.cli(f.project, ['job', 'run', '--build', 'full']);
    expect(built.code, built.stdout + built.stderr).toBe(0);
    const tested = await f.cli(f.project, ['job', 'run', '--test', TEST]);
    expect(tested.code, tested.stdout + tested.stderr).toBe(0);
  }, 300_000);

  it('prints the exact mozconfig change, makes none, and still leaves static work usable', async () => {
    const f = await hostFixture({
      mozconfig: 'ac_add_options --enable-bootstrap\nac_add_options --enable-application=browser\n',
    });
    fixtures.push(f);
    const before = await readFile(join(f.project, 'configs/common.mozconfig'), 'utf8');
    const init = await f.cli(f.project, ['host', 'init', '--from-engine', f.donor]);
    expect(init.code).toBe(ExitCode.GENERAL_ERROR);
    expect(init.stdout + init.stderr).toContain(
      'configs/common.mozconfig:1: replace "ac_add_options --enable-bootstrap" with "ac_add_options --disable-bootstrap"'
    );
    expect(await readFile(join(f.project, 'configs/common.mozconfig'), 'utf8')).toBe(before);
    // Under --json the blocked host answers with one error envelope, and progress stays on stderr.
    const machine = await f.cli(f.project, ['host', 'init', '--from-engine', f.donor, '--json']);
    expect(machine.code).toBe(ExitCode.GENERAL_ERROR);
    expect(JSON.parse(machine.stdout)).toMatchObject({
      schemaVersion: 1,
      code: 'general',
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest asymmetric matcher
      error: expect.stringContaining('configs/common.mozconfig:1'),
    });
    expect(machine.stderr).toContain('Coordinator ');
    expect((await slotOf(f, 'a')).quarantined).toBeNull();
    const refused = await f.cli(f.project, ['job', 'run', '--build', 'full']);
    expect(refused.code).toBe(ExitCode.GENERAL_ERROR);
    expect(refused.stdout + refused.stderr).toContain('configs/common.mozconfig:1');
    // Fixing it and rerunning finishes the job.
    await writeFile(join(f.project, 'configs/common.mozconfig'), MOZCONFIG);
    execFileSync('git', ['-C', f.project, 'add', '-A']);
    execFileSync('git', [
      '-C',
      f.project,
      '-c',
      'user.email=f@example.invalid',
      '-c',
      'user.name=F',
      'commit',
      '-qm',
      'disable bootstrap',
    ]);
    const finished = await f.cli(f.project, ['host', 'init', '--from-engine', f.donor]);
    expect(finished.code, `${finished.stdout}${finished.stderr}`).toBe(0);
  }, 300_000);

  it('catches a tool configure picks that the manifest lacks at qualification, not at seal', async () => {
    const f = await hostFixture();
    fixtures.push(f);
    // The donor's configure never ran with this tool, but the slot's does.
    await rm(join(f.donor, 'obj-real/config.statusd/substs/STRIP'));
    const init = await f.cli(f.project, ['host', 'init', '--from-engine', f.donor], {});
    expect(init.code, `${init.stdout}${init.stderr}${await jobLogs(f)}`).toBe(0);
    const slot = await slotOf(f, 'a');
    const manifestPath = join(f.namespace, 'toolchain.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      native: { environment: Record<string, string> };
    };
    const rogue = join(f.home, '.mozbuild/clang/bin/llvm-strip');
    manifest.native.environment['STRIP'] = rogue;
    await writeFile(manifestPath, JSON.stringify(manifest));
    execFileSync('chmod', ['-R', 'u+rwX', join(slot.root, '.fireforge')]);
    await rm(join(slot.root, '.fireforge', 'native-qualified.json'));
    const qualify = await f.cli(f.project, ['slot', 'qualify-native', 'a']);
    expect(qualify.code).toBe(ExitCode.JOB_FAILED);
    expect(await jobLogs(f)).toMatch(/STRIP/);
    await expect(readFile(join(slot.root, '.fireforge', 'native-qualified.json'))).rejects.toThrow(
      /ENOENT/
    );
  }, 300_000);
});

describe.concurrent('a job that needs a built slot', () => {
  const TEST = 'browser/browser_tabs.js';
  const body = lintClean('add_task(async function () {\n  ok(true);\n});\n');

  it('waits for a peer holding the good slot rather than failing on the cold one', async () => {
    const { f, worktree } = await initialized(2);
    await writeFile(join(worktree, 'src', TEST), body);
    execFileSync('git', ['-C', worktree, 'add', '-A']);
    expect((await f.cli(worktree, ['job', 'run', '--build', 'full', '--slot', 'a'])).code).toBe(0);
    // A peer's test, held open while a file exists, so slot a stays busy for as long as this needs.
    const hold = join(f.directory, 'hold');
    await writeFile(hold, '');
    const held = 'browser/browser_held.js';
    await writeFile(join(worktree, 'src', held), lintClean(`// fake-mach-hold ${hold}\n`));
    execFileSync('git', ['-C', worktree, 'add', '-A']);
    const peer = f.cli(worktree, ['job', 'run', '--test', held, '--slot', 'a']);
    await vi.waitFor(
      async () => {
        const list = await f.cli(worktree, ['job', 'list']);
        expect(list.stdout).toMatch(/running slot=a step=2\/2/);
      },
      { timeout: 60_000, interval: 200 }
    );
    const waiting = f.cli(worktree, ['job', 'run', '--test', held]);
    await vi.waitFor(
      async () => {
        const list = await f.cli(worktree, ['job', 'list']);
        expect(list.stdout).toMatch(/queued.*blocked=Waiting for slot a, which has the build/);
      },
      { timeout: 60_000, interval: 300 }
    );
    await rm(hold);
    const [first, second] = await Promise.all([peer, waiting]);
    expect(first.code, first.stdout + first.stderr).toBe(0);
    expect(second.code, second.stdout + second.stderr).toBe(0);
    expect(second.stdout).toMatch(/passed slot=a/);
    // Nothing was refused and the cold slot was never touched.
    expect(second.stderr).toMatch(/waiting: Waiting for slot a/);
    expect((await slotOf(f, 'b')).fullBuildAnchor).toBeUndefined();
  }, 300_000);

  it('a test on a cold host refuses, naming the build, and the command it names works', async () => {
    const f = await hostFixture();
    fixtures.push(f);
    await writeFile(join(f.project, 'src', TEST), body);
    execFileSync('git', ['-C', f.project, 'add', '-A']);
    const init = await f.cli(f.project, ['host', 'init', '--slots', '1', '--from-engine', f.donor]);
    expect(init.code, init.stdout + init.stderr).toBe(0);
    expect(init.stdout).toContain('No slot is built yet');
    expect(init.stdout).toContain('fireforge job run --build full');
    const refused = await f.cli(f.project, ['job', 'run', '--test', TEST, '--json']);
    expect(refused.code).toBe(ExitCode.GENERAL_ERROR);
    expect(refused.stdout).toContain('"job-cannot-run"');
    const said = refused.stdout + refused.stderr;
    expect(said).toContain(`fireforge job run --build full --test ${TEST}`);
    expect(said).toContain('hours');
    // Nothing started, so nothing holds the host's build lane.
    expect((await f.cli(f.project, ['job', 'list'])).stdout).not.toMatch(/build/);
    const run = await f.cli(f.project, ['job', 'run', '--build', 'full', '--test', TEST]);
    expect(run.code, `${run.stdout}${run.stderr}${await jobLogs(f)}`).toBe(0);
    const again = await f.cli(f.project, [
      'host',
      'init',
      '--slots',
      '1',
      '--from-engine',
      f.donor,
    ]);
    expect(again.stdout).toContain('Ready. Run: fireforge job run --test <path>');
    // Once a slot holds a binary of this source's inputs, a test needs no flag.
    expect((await f.cli(f.project, ['job', 'run', '--test', TEST])).code).toBe(0);
  }, 300_000);

  it('a job that can never run says why at submit, and leaves no job or red behind', async () => {
    const { f, worktree } = await initialized();
    for (const args of [
      ['job', 'run', '--build', 'ui'],
      ['job', 'run', '--build', 'none', '--test', TEST],
    ]) {
      const refused = await f.cli(worktree, args);
      expect(refused.code).toBe(ExitCode.GENERAL_ERROR);
      expect(refused.stdout + refused.stderr).toContain('fireforge job run --build');
    }
    const refused = await f.cli(worktree, ['job', 'run', '--build', 'ui', '--slot', 'a', '--json']);
    expect(refused.stdout).toContain('"job-cannot-run"');
    expect((await f.cli(worktree, ['job', 'list'])).stdout).not.toMatch(/failed/);
  }, 300_000);
});

describe.concurrent('the package a test runs from', () => {
  const TEST = 'browser/browser_tabs.js';

  it('is bound to the build: a replaced binary is refused, needs a build, and earns no evidence', async () => {
    const { f, worktree } = await initialized();
    await writeFile(
      join(worktree, 'src', TEST),
      lintClean('add_task(async function () {\n  ok(true);\n});\n')
    );
    execFileSync('git', ['-C', worktree, 'add', '-A']);
    expect((await f.cli(worktree, ['job', 'run', '--build', 'full'])).code).toBe(0);
    const slot = await slotOf(f, 'a');
    const anchored = slot.fullBuildAnchor;
    expect(anchored).toBeDefined();
    expect(slot.packageSignature).toBeDefined();
    await writeFile(
      join(slot.root, 'engine/obj-fake/dist/bin/fixture'),
      'code from no captured source\n'
    );
    const run = await f.cli(worktree, [
      'job',
      'run',
      '--build',
      'none',
      '--test',
      TEST,
      '--slot',
      'a',
    ]);
    expect(run.code, run.stdout + run.stderr).toBe(ExitCode.JOB_FAILED);
    expect(run.stdout).toMatch(/package changed after the build.*dist\/bin\/fixture/);
    const after = await slotOf(f, 'a');
    expect(after.quarantined).toBeNull();
    expect(after.fullBuildAnchor).toBeUndefined();
    expect(after.requiresFullBuild).toBe(true);
    expect(after.trustedBuild).toBeUndefined();
    const job = JSON.parse(
      (await f.cli(worktree, ['job', 'status', run.stdout.split(' ')[0] ?? '', '--json'])).stdout
    ) as { refused?: boolean; process?: unknown };
    expect(job.refused).toBe(true);
    expect(job.process).toBeUndefined();
    // A rebuild is all it takes, and a test alone says which.
    const stuck = await f.cli(worktree, ['job', 'run', '--test', TEST]);
    expect(stuck.code).toBe(ExitCode.GENERAL_ERROR);
    expect(stuck.stdout + stuck.stderr).toContain(`job run --build full --test ${TEST}`);
    expect((await f.cli(worktree, ['job', 'run', '--build', 'full', '--test', TEST])).code).toBe(0);
  }, 300_000);

  it('is checked at seal: a step that overwrites it leaves no passing receipt', async () => {
    const hook = join('obj-fake', 'dist', 'bin', 'fixture');
    const { f, worktree } = await initialized(1, {
      check: {
        skip: ['typecheck', 'furnace-validate', 'token-coverage'],
        extraSteps: [
          {
            name: 'scribbler',
            command: `sh -c 'if [ -f engine/${hook} ]; then echo tampered > engine/${hook}; fi'`,
            footprint: { static: true },
          },
        ],
      },
    });
    expect((await f.cli(worktree, ['job', 'run', '--build', 'full'])).code).toBe(0);
    const run = await f.cli(worktree, ['job', 'run', '--check']);
    expect(run.code, run.stdout + run.stderr).toBe(ExitCode.JOB_FAILED);
    expect(run.stdout).toMatch(/package changed/);
    const after = await slotOf(f, 'a');
    expect(after.requiresFullBuild).toBe(true);
    expect(after.fullBuildAnchor).toBeUndefined();
  }, 300_000);
});

describe.concurrent('what a refusal says', () => {
  it('names the kind of refusal and what shows the alternatives', async () => {
    const { f, worktree } = await initialized();
    const job = await f.cli(worktree, ['job', 'status', 'nope', '--json']);
    expect(job.code).toBe(ExitCode.GENERAL_ERROR);
    expect(job.stdout + job.stderr).toContain('"unknown-job"');
    expect(job.stdout + job.stderr).toContain('fireforge job list');
    const slot = await f.cli(worktree, ['slot', 'remove', 'nope', '--json']);
    expect(slot.stdout + slot.stderr).toContain('"unknown-slot"');
    expect(slot.stdout + slot.stderr).toContain('fireforge slot list');
    const green = await f.cli(worktree, ['job', 'run']);
    expect(green.code, green.stdout + green.stderr).toBe(0);
    const logs = await f.cli(worktree, [
      'job',
      'logs',
      green.stdout.split(' ')[0] ?? '',
      '--offset',
      'x',
      '--json',
    ]);
    expect(logs.stdout + logs.stderr).toContain('"invalid-log-range"');
    expect(logs.stdout + logs.stderr).toContain('1048576');
  }, 300_000);

  it('before any host exists, says to set one up rather than to retry', async () => {
    const f = await hostFixture();
    fixtures.push(f);
    await rm(join(f.namespace, 'config.json'));
    const started = Date.now();
    const run = await f.cli(f.project, ['job', 'run', '--check']);
    expect(run.code).toBe(ExitCode.GENERAL_ERROR);
    expect(run.stdout + run.stderr).toContain('fireforge host init');
    expect(run.stdout + run.stderr).not.toContain('retry with the same key');
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 120_000);

  it('a supervisor that cannot start says why at once, naming what is wrong', async () => {
    const { f, worktree } = await initialized();
    await vi.waitFor(() => expect(lstat(join(f.namespace, 'endpoint.json'))).rejects.toThrow(), {
      timeout: 30_000,
      interval: 100,
    });
    await writeFile(join(f.namespace, 'epoch.json'), '{"epoch":-1}\n');
    const started = Date.now();
    const run = await f.cli(worktree, ['job', 'run', '--check']);
    expect(run.code).toBe(ExitCode.GENERAL_ERROR);
    expect(run.stdout + run.stderr).toContain('Invalid supervisor epoch');
    expect(run.stdout + run.stderr).not.toContain('retry with the same key');
    expect(Date.now() - started).toBeLessThan(15_000);
    await writeFile(join(f.namespace, 'epoch.json'), '{"epoch":5}\n');
  }, 300_000);

  it('a damaged journal row does not stop the host, and leaves a record of itself', async () => {
    const { f, worktree } = await initialized();
    const first = await f.cli(worktree, ['job', 'run']);
    expect(first.code, first.stdout + first.stderr).toBe(0);
    await vi.waitFor(() => expect(lstat(join(f.namespace, 'endpoint.json'))).rejects.toThrow(), {
      timeout: 30_000,
      interval: 100,
    });
    const journal = join(f.namespace, 'journal.jsonl');
    const rows = (await readFile(journal, 'utf8')).split('\n');
    rows.splice(1, 0, '{not a row');
    await writeFile(journal, rows.join('\n'));
    expect((await f.cli(worktree, ['job', 'list'])).code).toBe(0);
    await writeFile(join(worktree, 'src/browser/new.js'), lintClean('export const value = 9;\n'));
    const next = await f.cli(worktree, ['job', 'run']);
    expect(next.code, next.stdout + next.stderr).toBe(0);
    expect(await readFile(join(f.namespace, 'journal.damaged.jsonl'), 'utf8')).toContain(
      '{not a row'
    );
  }, 300_000);
});

describe.concurrent('fireforge job run', () => {
  it('a harness that leaves its helper server behind: the helper is stopped and the slot stays usable', async () => {
    const { f, worktree } = await initialized();
    expect((await f.cli(worktree, ['job', 'run', '--build', 'full'])).code).toBe(0);
    const pidfile = join(f.directory, 'helper.pid');
    await writeFile(
      join(worktree, 'src/browser/test_orphan.js'),
      lintClean(`// fake-mach-orphan-helper ${pidfile} ${process.execPath}\nadd_task(() => {});\n`)
    );
    const run = await f.cli(worktree, ['job', 'run', '--test', 'browser/test_orphan.js']);
    expect(run.code, `${run.stdout}${run.stderr}${await jobLogs(f)}`).toBe(ExitCode.JOB_FAILED);
    const helper = Number(await readFile(pidfile, 'utf8'));
    const alive = (): boolean => {
      try {
        process.kill(helper, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      expect(run.stdout).not.toMatch(/cleanup uncertain/);
      expect((await slotOf(f, 'a')).quarantined).toBeNull();
      expect(alive()).toBe(false);
    } finally {
      if (alive()) process.kill(helper, 'SIGKILL');
    }
  }, 300_000);

  it('a one-line CSS change: override, edit, run. One verdict line, correct exit code, no flags', async () => {
    const { f, worktree } = await initialized();
    const full = await f.cli(worktree, ['job', 'run', '--build', 'full']);
    expect(full.code).toBe(0);
    // The object directory qualification configured is these tools' own: nothing to clobber.
    const artifacts = await readdir(
      join(f.namespace, 'artifacts', full.stdout.split(' ')[0] ?? '')
    );
    expect(artifacts.filter((name) => name.startsWith('clean-'))).toEqual([]);
    const override = await f.cli(worktree, [
      'authored',
      'override',
      'browser/themes/shared/tabs.css',
    ]);
    expect(override.code, override.stdout + override.stderr).toBe(0);
    const css = join(worktree, 'src/browser/themes/shared/tabs.css');
    await writeFile(css, (await readFile(css, 'utf8')).replace('4px', '6px'));
    await writeFile(
      join(worktree, 'src/browser/browser_tabs.js'),
      lintClean('add_task(async function () {\n  ok(true);\n});\n')
    );
    const run = await f.cli(worktree, ['job', 'run', '--test', 'browser/browser_tabs.js']);
    expect(run.code, `${run.stdout}${run.stderr}${await jobLogs(f)}`).toBe(0);
    const lines = run.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^[a-f0-9-]{36} passed slot=a/);
    const job = JSON.parse(
      (await f.cli(worktree, ['job', 'status', lines[0]?.split(' ')[0] ?? '', '--json'])).stdout
    ) as { request: { steps: Array<{ command: string; args: string[] }>; slot?: string } };
    expect(job.request.steps.map((step) => step.command)).toEqual(['build', 'test']);
    expect(job.request.steps[0]?.args).toEqual(['--ui']);
    expect(job.request.slot).toBeUndefined();
    // The materialized source is the edit, and only the edit moved.
    const slot = await slotOf(f, 'a');
    expect(
      await readFile(join(slot.root, 'engine/browser/themes/shared/tabs.css'), 'utf8')
    ).toContain('6px');
  }, 300_000);

  it('exits by verdict: a red check fails with its code and the next run still has its slot', async () => {
    const { f, worktree } = await initialized();
    const config = join(worktree, 'fireforge.json');
    const parsed = JSON.parse(await readFile(config, 'utf8')) as {
      check: { extraSteps: Array<{ command: string }> };
    };
    const [step] = parsed.check.extraSteps;
    if (step === undefined) throw new Error('fixture has an extra step');
    step.command = 'false';
    await writeFile(config, JSON.stringify(parsed));
    execFileSync('git', ['-C', worktree, 'add', '-A']);
    const red = await f.cli(worktree, ['job', 'run', '--check']);
    expect(red.code, red.stdout + red.stderr).toBe(ExitCode.JOB_FAILED);
    expect(red.stdout).toMatch(/failed slot=a .*logs="fireforge job logs/);
    expect((await slotOf(f, 'a')).quarantined).toBeNull();
    step.command = 'true';
    await writeFile(config, JSON.stringify(parsed));
    execFileSync('git', ['-C', worktree, 'add', '-A']);
    const green = await f.cli(worktree, ['job', 'run']);
    expect(green.code, green.stdout + green.stderr).toBe(0);
    // Unchanged source and a derived key: a repeat attaches rather than running again.
    const repeat = await f.cli(worktree, ['job', 'run']);
    expect(repeat.stdout.split(' ')[0]).toBe(green.stdout.split(' ')[0]);
  }, 300_000);

  it('a check with a project step of unknown footprint is refused at submit, naming it and the fix', async () => {
    const { f, worktree } = await initialized(1, {
      check: {
        skip: ['typecheck', 'furnace-validate', 'token-coverage'],
        extraSteps: [{ name: 'mystery', command: 'true' }],
      },
    });
    const refused = await f.cli(worktree, ['job', 'run', '--check']);
    expect(refused.code).toBe(ExitCode.GENERAL_ERROR);
    expect(refused.stdout + refused.stderr).toContain(
      'Declare "footprint": { "static": true } on: mystery'
    );
  }, 300_000);

  it('with no slot named, picks the slot whose anchor matches', async () => {
    const { f, worktree } = await initialized(2);
    expect((await f.cli(worktree, ['job', 'run', '--build', 'full', '--slot', 'b'])).code).toBe(0);
    expect((await slotOf(f, 'b')).fullBuildAnchor).toBeDefined();
    await writeFile(
      join(worktree, 'src/browser/new.js'),
      lintClean('/** A value. */\nexport const value = 2;\n')
    );
    const run = await f.cli(worktree, ['job', 'run', '--build', 'ui']);
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toMatch(/passed slot=b/);
  }, 300_000);

  it('quality tools do not bind the compiled anchor: an ESLint config edit keeps it and a --ui build runs', async () => {
    const { f, worktree } = await initialized();
    expect((await f.cli(worktree, ['job', 'run', '--build', 'full'])).code).toBe(0);
    const { fullBuildAnchor } = await slotOf(f, 'a');
    await writeFile(join(worktree, 'eslint.config.mjs'), 'export default [];\n');
    execFileSync('git', ['-C', worktree, 'add', '-A']);
    const run = await f.cli(worktree, [
      'job',
      'run',
      '--build',
      'ui',
      '--path',
      'eslint.config.mjs',
    ]);
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect((await slotOf(f, 'a')).fullBuildAnchor).toEqual(fullBuildAnchor);
  }, 300_000);

  it('a UI-only source change leaves the mozconfig’s mtime alone, so nothing re-runs configure', async () => {
    const { f, worktree } = await initialized();
    expect((await f.cli(worktree, ['job', 'run', '--build', 'full'])).code).toBe(0);
    const slot = await slotOf(f, 'a');
    const mozconfig = join(slot.root, 'engine/mozconfig');
    const before = (await lstat(mozconfig)).mtimeMs;
    await writeFile(
      join(worktree, 'src/browser/new.js'),
      lintClean('/** A value. */\nexport const value = 2;\n')
    );
    const run = await f.cli(worktree, ['job', 'run', '--build', 'ui']);
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect((await lstat(mozconfig)).mtimeMs).toBe(before);
    expect(await realpath(mozconfig)).toBe(mozconfig.replace(/^\/var\//, '/private/var/'));
  }, 300_000);

  it('clones a built slot, inherits its anchor because the tools match, and relocates on qualifying', async () => {
    const { f, worktree } = await initialized();
    expect((await f.cli(worktree, ['job', 'run', '--build', 'full'])).code).toBe(0);
    const source = await slotOf(f, 'a');
    const created = await f.cli(worktree, ['slot', 'create', 'b', '--from', 'a']);
    expect(created.code, created.stdout + created.stderr).toBe(0);
    const clone = await slotOf(f, 'b');
    expect(clone.fullBuildAnchor).toEqual(source.fullBuildAnchor);
    expect(clone.requiresBuild).toBe(true);
    const mtimes = await Promise.all(
      [source, clone].map(
        async (slot) => (await lstat(join(slot.root, 'engine/obj-fake/dist/bin/fixture'))).mtimeMs
      )
    );
    expect(mtimes[1]).toBe(mtimes[0]);
    const qualified = await f.cli(worktree, ['slot', 'qualify-native', 'b']);
    expect(qualified.code, qualified.stdout + qualified.stderr).toBe(0);
    const mozinfo = await readJson<{ topsrcdir: string }>(
      join(clone.root, 'engine/obj-fake/mozinfo.json')
    );
    expect(await realpath(mozinfo.topsrcdir)).toBe(await realpath(join(clone.root, 'engine')));
    await writeFile(
      join(worktree, 'src/browser/new.js'),
      lintClean('/** A value. */\nexport const value = 3;\n')
    );
    const ui = await f.cli(worktree, ['job', 'run', '--build', 'ui', '--slot', 'b']);
    expect(ui.code, ui.stdout + ui.stderr).toBe(0);
  }, 300_000);
});
