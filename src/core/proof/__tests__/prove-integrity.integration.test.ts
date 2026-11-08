// SPDX-License-Identifier: EUPL-1.2
/** Every way a proof could read green without meaning it, as real processes against a fake mach. */
import { chmod, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { ExitCode } from '../../../errors/codes.js';
import { writeAt } from '../../authored/__tests__/fixtures.js';
import {
  type CliResult,
  type HostFixture,
  lintClean,
  removeHostFixture,
} from '../../jobs/__tests__/host-fixture.js';
import { readHostToolchain } from '../../jobs/native-tools.js';
import { agent as hostAgent, git, jobs, logs, parse, states, TEST } from './prove-fixture.js';

const fixtures: HostFixture[] = [];
afterAll(async () => {
  await Promise.all(fixtures.splice(0).map(removeHostFixture));
}, 120_000);

const agent = (
  options?: Parameters<typeof hostAgent>[1],
  slots?: number
): ReturnType<typeof hostAgent> => hostAgent(fixtures, options, slots);

const said = (result: CliResult): string => result.stdout + result.stderr;

const commit = (worktree: string, message: string): string => {
  git(worktree, 'add', '-A');
  git(worktree, 'commit', '-qm', message);
  return git(worktree, 'rev-parse', 'HEAD');
};

const editConfig = async (
  worktree: string,
  edit: (config: Record<string, unknown>) => void
): Promise<void> => {
  const path = join(worktree, 'fireforge.json');
  const config = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  edit(config);
  await writeFile(path, JSON.stringify(config));
};

const LANE = { id: 'themes', files: ['browser/themes/test/browser_*.js'] };

describe.concurrent('what a proof is compared with', () => {
  it('asks a person when a candidate rewrites the script its lane validator runs', async () => {
    const { f, worktree } = await agent({
      proof: {
        gate: {
          lanes: [
            {
              ...LANE,
              uploadDir: true,
              validate: { command: ['node', 'tools/count.mjs', '{artifacts}'] },
            },
          ],
        },
      },
      projectFiles: { 'tools/count.mjs': 'process.exit(3);\n' },
    });
    commit(worktree, 'task');
    const red = await f.cli(worktree, ['prove', '--tier', 'gate', '--json']);
    expect(red.code, red.stderr + (await logs(f))).toBe(ExitCode.JOB_FAILED);
    expect(states(parse(red))['lane:themes']).toBe('red');

    // The declaration stays as it was, and only what it points at changes.
    await writeFile(join(worktree, 'tools/count.mjs'), 'process.exit(0);\n');
    commit(worktree, 'gut the validator');
    const run = await f.cli(worktree, ['prove', '--tier', 'gate', '--json']);
    expect(run.code, run.stderr + (await logs(f))).toBe(ExitCode.GENERAL_ERROR);
    const report = parse(run);
    expect(states(report)).toMatchObject({
      'lane:themes': 'passed',
      'accept:proof-config': 'outstanding',
    });
    expect(said(run)).toContain('tools/count.mjs');
    const complete = await f.cli(worktree, ['prove', 'status', '--complete', '--tier', 'gate']);
    expect(complete.code).toBe(ExitCode.GENERAL_ERROR);
    const publish = await f.cli(worktree, ['prove', 'publish']);
    expect(publish.code).toBe(ExitCode.GENERAL_ERROR);
    expect(said(publish)).toContain('accept:proof-config');
    expect(() => git(worktree, 'rev-parse', '--verify', '-q', 'refs/fireforge/verified')).toThrow();

    // A person can still say yes, and by the short name a declaration's acceptance goes by.
    const accepted = await f.cli(worktree, [
      'prove',
      'accept',
      'proof-config',
      '--tier',
      'gate',
      '--note',
      'The validator was wrong, and this is right.',
    ]);
    expect(accepted.code, said(accepted)).toBe(0);
    const published = await f.cli(worktree, ['prove', 'publish']);
    expect(published.code, said(published)).toBe(0);
  }, 300_000);

  it('asks a person when a candidate turns off what the final lint enforces', async () => {
    const { f, worktree } = await agent({ proof: { gate: { lanes: [LANE] } } });
    await editConfig(worktree, (config) => {
      config['patchLint'] = { prettier: 'off' };
    });
    commit(worktree, 'relax lint');
    const plan = parse(await f.cli(worktree, ['prove', 'plan', '--tier', 'gate', '--json']));
    expect(states(plan)['accept:proof-config']).toBe('outstanding');
  }, 300_000);

  it('asks a person when a candidate loosens a type shim or the type settings', async () => {
    const options = {
      config: {
        proof: { gate: { lanes: [LANE] } },
        patchLint: { checkJsExtraShim: 'tools/shim.d.ts' },
      },
      projectFiles: { 'tools/shim.d.ts': 'declare const strict: string;\n' },
    };
    const shimmed = await agent(options);
    const asked = async (worktree: string, f: typeof shimmed.f): Promise<string | undefined> =>
      states(parse(await f.cli(worktree, ['prove', 'plan', '--tier', 'gate', '--json'])))[
        'accept:proof-config'
      ];
    commit(shimmed.worktree, 'task');
    expect(await asked(shimmed.worktree, shimmed.f)).toBeUndefined();

    await writeFile(join(shimmed.worktree, 'tools/shim.d.ts'), 'declare const strict: any;\n');
    commit(shimmed.worktree, 'loosen the shim');
    expect(await asked(shimmed.worktree, shimmed.f)).toBe('outstanding');

    const typed = await agent({ config: { proof: { gate: { lanes: [LANE] } } } });
    await editConfig(typed.worktree, (config) => {
      config['typecheck'] = { projects: ['jsconfig.json'] };
    });
    commit(typed.worktree, 'declare the type projects');
    expect(await asked(typed.worktree, typed.f)).toBe('outstanding');
  }, 300_000);

  it('holds evidence to the present tools, by kind at task tier and whole at a gate', async () => {
    const { f, worktree } = await agent({ proof: { gate: { lanes: [LANE] } } });
    commit(worktree, 'task');
    const task = await f.cli(worktree, ['prove', '--json']);
    expect(task.code, task.stderr + (await logs(f))).toBe(0);
    const gate = await f.cli(worktree, ['prove', '--tier', 'gate', '--json']);
    expect(gate.code, gate.stderr + (await logs(f))).toBe(0);
    expect(parse(gate).complete).toBe(true);
    const before = (await jobs(f)).length;

    // A dev tool changes in the slot, as an upgrade or a hand edit would.
    const modules = join(f.namespace, 'slots/a/root/node_modules');
    const tool = join(modules, 'some-linter/package.json');
    await mkdir(dirname(tool), { recursive: true });
    await writeFile(tool, '{"name":"some-linter","version":"2.0.0"}\n');
    const moved = parse(await f.cli(worktree, ['prove', 'status', '--json']));
    expect(states(moved)).toEqual({
      static: 'stale',
      build: 'passed',
      [`test:${TEST}`]: 'passed',
    });
    expect(moved.obligations.find((entry) => entry.id === 'static')?.detail).toContain(
      'quality tools'
    );
    const claim = await f.cli(worktree, ['prove', 'status', '--complete']);
    expect(claim.code).toBe(ExitCode.GENERAL_ERROR);
    expect(said(claim)).toContain('proof-incomplete');
    const gated = parse(await f.cli(worktree, ['prove', 'status', '--tier', 'gate', '--json']));
    expect(new Set(Object.values(states(gated)))).toEqual(new Set(['stale']));
    const refused = await f.cli(worktree, ['prove', 'publish']);
    expect(refused.code).toBe(ExitCode.GENERAL_ERROR);
    expect(said(refused)).toContain('proof-incomplete');
    expect(() => git(worktree, 'rev-parse', '--verify', 'refs/fireforge/verified')).toThrow();

    // Putting the tool back is the identity the evidence was made with.
    await rm(modules, { recursive: true });
    const restored = await f.cli(worktree, ['prove', 'status', '--tier', 'gate', '--complete']);
    expect(restored.code, said(restored)).toBe(0);

    // A changed locale reaches what ran in a browser and a project script, and not lint.
    const configPath = join(f.namespace, 'config.json');
    const config = await readFile(configPath, 'utf8');
    const parsed = JSON.parse(config) as { runtime: { environment: Record<string, string> } };
    parsed.runtime.environment['TZ'] = 'Asia/Tokyo';
    await writeFile(configPath, JSON.stringify(parsed));
    expect(states(parse(await f.cli(worktree, ['prove', 'status', '--json'])))).toEqual({
      static: 'passed',
      build: 'passed',
      [`test:${TEST}`]: 'stale',
    });
    await writeFile(configPath, config);
    // Measuring ran nothing.
    expect(await jobs(f)).toHaveLength(before);
  }, 400_000);

  it('reads tool bytes for a gate claim, which a stat signature cannot see', async () => {
    const { f, worktree } = await agent({ proof: { gate: { lanes: [LANE] } } });
    commit(worktree, 'task');
    const gate = await f.cli(worktree, ['prove', '--tier', 'gate', '--json']);
    expect(gate.code, gate.stderr + (await logs(f))).toBe(0);
    // Same size and same times, as a restore from backup or `cp -p` leaves them.
    const manifest = await readHostToolchain(f.namespace);
    const tool = manifest.native.executables['AR'] ?? '';
    const before = await stat(tool);
    const bytes = await readFile(tool);
    await chmod(tool, 0o755);
    await writeFile(tool, Buffer.alloc(bytes.length, 'x'));
    // Midway through the millisecond the signature compares, since a Date rounds it.
    const seconds = (Math.floor(before.mtimeMs) + 0.5) / 1000;
    await utimes(tool, seconds, seconds);
    await chmod(tool, before.mode & 0o777);
    // A report compares the signature, as a job does.
    expect(
      parse(await f.cli(worktree, ['prove', 'status', '--tier', 'gate', '--json'])).complete
    ).toBe(true);
    const claim = await f.cli(worktree, ['prove', 'status', '--tier', 'gate', '--complete']);
    expect(claim.code).toBe(ExitCode.GENERAL_ERROR);
    expect(said(claim)).toContain('Native tool bytes changed');
    const publish = await f.cli(worktree, ['prove', 'publish']);
    expect(publish.code).toBe(ExitCode.GENERAL_ERROR);
    expect(() => git(worktree, 'rev-parse', '--verify', 'refs/fireforge/verified')).toThrow();
    // A size change moves the signature, which any report sees.
    await chmod(tool, 0o755);
    await writeFile(tool, Buffer.concat([bytes, Buffer.from('x')]));
    const task = parse(await f.cli(worktree, ['prove', 'status', '--json']));
    expect(states(task)[`test:${TEST}`]).toBe('stale');
  }, 400_000);

  it('asks a slot on this source, and brings one there instead of rerunning everything', async () => {
    const { f, worktree } = await agent({}, 1);
    const proved = await f.cli(worktree, ['prove', '--json']);
    expect(proved.code, proved.stderr + (await logs(f))).toBe(0);
    const first = (await jobs(f)).length;
    const source = commit(worktree, 'task');
    // Another agent's source takes the only slot, and its root configuration differs.
    const other = join(f.directory, 'other');
    git(worktree, 'worktree', 'add', '-q', '--detach', other, source);
    await writeFile(join(other, 'package.json'), '{"name":"fixture","private":true,"x":1}\n');
    const peer = await f.cli(other, ['job', 'run', '--check']);
    expect(peer.code, said(peer) + (await logs(f))).toBe(0);
    const unknown = parse(await f.cli(worktree, ['prove', 'status', '--json']));
    expect(states(unknown)).toMatchObject({ static: 'stale', build: 'passed' });
    expect(unknown.obligations.find((entry) => entry.id === 'static')?.detail).toContain(
      'No slot holds this source'
    );
    const refused = await f.cli(worktree, ['prove', 'status', '--complete']);
    expect(refused.code).toBe(ExitCode.GENERAL_ERROR);
    // One cheap job to measure, and the evidence stands.
    const again = await f.cli(worktree, ['prove', '--json']);
    expect(again.code, again.stderr + (await logs(f))).toBe(0);
    expect(parse(again).complete).toBe(true);
    const added = (await jobs(f)).slice(first + 1);
    expect(added.flatMap((job) => job.request.steps.map((step) => step.command))).toEqual([
      'status',
    ]);
  }, 400_000);
});

describe.concurrent('a candidate and its own gate', () => {
  const gate = {
    lanes: [LANE],
    stress: [{ id: 'soak', files: [TEST], repeat: 2 }],
    acceptance: [{ id: 'scene', reason: 'A person looks at the tab strip.' }],
  };

  it('keeps what it removes until that removal is itself verified', async () => {
    const { f, worktree, marker } = await agent({ proof: { noneRoutes: ['tools/**'], gate } });
    commit(worktree, 'task');
    await writeFile(marker, 'red');
    await editConfig(worktree, (config) => {
      delete config['proof'];
    });
    commit(worktree, 'drop the gate that went red');

    const plan = parse(await f.cli(worktree, ['prove', 'plan', '--tier', 'gate', '--json']));
    expect(Object.keys(states(plan))).toEqual(
      expect.arrayContaining([
        'lane:themes',
        'stress:soak',
        'accept:scene',
        'accept:proof-config',
        'check',
        'build',
      ])
    );
    expect(plan.plan.base.narrowed).toBe(false);
    expect(plan.plan.notes.join('\n')).toContain('Lane themes is gone from the candidate');
    expect(plan.plan.notes.join('\n')).toContain('Stress soak is gone from the candidate');

    // It still goes red on what it tried to remove.
    const red = await f.cli(worktree, ['prove', '--tier', 'gate', '--json']);
    expect(red.code).toBe(ExitCode.JOB_FAILED);
    expect(states(parse(red))['lane:themes']).toBe('red');
    await rm(marker);

    const run = await f.cli(worktree, ['prove', '--tier', 'gate', '--json']);
    expect(run.code, run.stderr + (await logs(f))).toBe(ExitCode.GENERAL_ERROR);
    expect(states(parse(run))).toMatchObject({
      'lane:themes': 'passed',
      'stress:soak': 'passed',
      'accept:proof-config': 'outstanding',
    });
    const publish = await f.cli(worktree, ['prove', 'publish']);
    expect(publish.code).toBe(ExitCode.GENERAL_ERROR);
    expect(said(publish)).toContain('accept:proof-config');
    // Nothing but a person's acceptance satisfies it.
    const waive = await f.cli(worktree, [
      'prove',
      'waive',
      'accept:proof-config',
      '--allow-machine',
      '--tier',
      'gate',
      '--note',
      'no',
    ]);
    expect(said(waive)).toContain('proof-waive-acceptance');
    for (const id of ['accept:scene', 'accept:proof-config']) {
      const accepted = await f.cli(worktree, [
        'prove',
        'accept',
        id,
        '--tier',
        'gate',
        '--note',
        'Reviewed the gate change.',
      ]);
      expect(accepted.code, said(accepted)).toBe(0);
    }
    const landed = await f.cli(worktree, ['prove', 'publish']);
    expect(landed.code, said(landed)).toBe(0);

    // Now the base holds the smaller gate, so the next candidate answers to that.
    await writeAt(worktree, 'docs/note.md', 'a note\n');
    commit(worktree, 'docs');
    const next = parse(await f.cli(worktree, ['prove', 'plan', '--tier', 'gate', '--json']));
    expect(next.plan.base.label).toBe('refs/fireforge/verified');
    expect(Object.keys(states(next))).toEqual(['check']);
  }, 600_000);

  it('takes an addition at once, and does not take a route out of the plan until it lands', async () => {
    const { f, worktree } = await agent({ proof: { gate: {} } });
    await writeAt(worktree, 'tools/script.mjs', '// a tool\n');
    await editConfig(worktree, (config) => {
      config['proof'] = {
        noneRoutes: ['tools/**'],
        gate: { lanes: [{ id: 'added', files: [TEST] }] },
      };
    });
    commit(worktree, 'task');
    const plan = parse(await f.cli(worktree, ['prove', 'plan', '--tier', 'gate', '--json']));
    expect(Object.keys(states(plan))).toEqual(
      expect.arrayContaining(['lane:added', 'accept:proof-config'])
    );
    const tool = (
      JSON.parse((await f.cli(worktree, ['prove', 'plan', '--tier', 'gate', '--json'])).stdout) as {
        plan: { changed: Array<{ path: string; route: string }> };
      }
    ).plan.changed.find((entry) => entry.path === 'tools/script.mjs');
    expect(tool?.route).toBe('unknown');
  }, 300_000);

  it('does not let a candidate name its own branch as the main one', async () => {
    const { f, worktree } = await agent({});
    commit(worktree, 'runtime change');
    await editConfig(worktree, (config) => {
      config['proof'] = { mainBranch: 'task' };
    });
    commit(worktree, 'I am the main branch now');
    const report = parse(await f.cli(worktree, ['prove', 'plan', '--tier', 'gate', '--json']));
    expect(report.plan.base.label).toMatch(/^merge-base with (?:main|master)$/);
    expect(states(report)['accept:proof-config']).toBe('outstanding');
    const task = parse(await f.cli(worktree, ['prove', 'plan', '--json']));
    expect(task.plan.base.label).toMatch(/^merge-base with (?:main|master)$/);
    expect(Object.keys(states(task))).toContain(`test:${TEST}`);
  }, 300_000);

  it('asks a person about a check section that changed, such as a grown skip', async () => {
    const { f, worktree } = await agent({ proof: { gate: {} } });
    await editConfig(worktree, (config) => {
      (config['check'] as { skip: string[] }).skip.push('status');
    });
    commit(worktree, 'task');
    const report = parse(await f.cli(worktree, ['prove', 'plan', '--tier', 'gate', '--json']));
    expect(states(report)['accept:proof-config']).toBe('outstanding');
  }, 300_000);

  it('names a deleted test, in a lane or not, and a declared one that is gone stays red', async () => {
    const other = 'browser/themes/test/browser_other.js';
    const named = 'browser/scenes/test/browser_literal.js';
    const { f, worktree } = await agent({
      proof: { gate: { lanes: [LANE, { id: 'literal', files: [named] }] } },
    });
    await writeAt(worktree, `src/${other}`, lintClean("add_task(() => ok(true, 'other'));\n"));
    await writeAt(worktree, `src/${named}`, lintClean("add_task(() => ok(true, 'literal'));\n"));
    commit(worktree, 'tests');
    git(f.project, 'merge', '-q', '--ff-only', 'task');
    await rm(join(worktree, 'src', other));
    await rm(join(worktree, 'src', named));
    const report = parse(await f.cli(worktree, ['prove', 'plan', '--tier', 'gate', '--json']));
    expect(report.plan.removedTests).toEqual(
      expect.arrayContaining([
        { path: other, from: ['lane:themes'] },
        { path: named, from: ['lane:literal'] },
      ])
    );
    const text = await f.cli(worktree, ['prove', 'plan', '--tier', 'gate']);
    expect(text.stdout).toContain(`removed test: ${other} (was in lane:themes)`);
    const task = await f.cli(worktree, ['prove', 'plan']);
    expect(task.stdout).toContain(`removed test: ${other}`);
    // The literal stays on the roster, so it reads red: only the declaration can take it off.
    const ran = await f.cli(worktree, ['prove', '--tier', 'gate', '--json']);
    expect(ran.code).toBe(ExitCode.JOB_FAILED);
    expect(states(parse(ran))['lane:literal']).toBe('red');
  }, 300_000);
});

describe.concurrent('waivers', () => {
  it('lapse across tiers, refuse by default, and never move the base', async () => {
    const { f, worktree } = await agent({ proof: { gate: { lanes: [LANE] } } });
    const head = commit(worktree, 'task');
    const waive = (id: string, ...rest: string[]): Promise<CliResult> =>
      f.cli(worktree, ['prove', 'waive', id, ...rest, '--note', 'later']);

    expect(said(await waive('build', '--tier', 'task'))).toContain(
      'proof-waive-machine-obligation'
    );
    const task = await waive('build', '--tier', 'task', '--allow-machine');
    expect(task.code, said(task)).toBe(0);
    // A waiver of the task's UI build says nothing about what the gate asks.
    const gate = parse(await f.cli(worktree, ['prove', 'status', '--tier', 'gate', '--json']));
    expect(states(gate)['build']).toBe('outstanding');
    expect(said(await f.cli(worktree, ['prove', 'publish']))).toContain(
      'proof-publish-no-evidence'
    );

    // The only job that ever touched this source goes red, so a retained snapshot exists.
    const red = await f.cli(worktree, ['job', 'run', '--check', '--slot', 'nowhere']);
    expect(red.code).not.toBe(0);
    await f.cli(worktree, ['job', 'run', '--check']);
    for (const id of ['build', 'lane:themes', 'check'])
      expect((await waive(id, '--tier', 'gate', '--allow-machine')).code).toBe(0);
    const all = parse(await f.cli(worktree, ['prove', 'status', '--tier', 'gate', '--json']));
    expect(all.verdict).toBe('complete-with-waivers');
    const claim = await f.cli(worktree, ['prove', 'status', '--tier', 'gate', '--complete']);
    expect(claim.code).toBe(ExitCode.GENERAL_ERROR);
    expect(said(claim)).toContain('proof-waived');
    const refused = await f.cli(worktree, ['prove', 'publish']);
    expect(refused.code).toBe(ExitCode.GENERAL_ERROR);
    expect(said(refused)).toContain('proof-waived');
    expect(() => git(worktree, 'rev-parse', '--verify', 'refs/fireforge/verified')).toThrow();
    const unstated = await f.cli(worktree, ['prove', 'publish', '--allow-waived']);
    expect(unstated.code).toBe(ExitCode.INVALID_ARGUMENT);

    const stated = await f.cli(worktree, [
      'prove',
      'publish',
      '--allow-waived',
      '--note',
      'Shipping past a broken lab machine.',
    ]);
    expect(stated.code, said(stated)).toBe(0);
    expect(git(worktree, 'rev-parse', 'refs/fireforge/verified')).toBe(head);
    const record = JSON.parse(
      git(worktree, 'cat-file', 'blob', `refs/fireforge/verified-waivers/${head}`)
    ) as { note: string; waived: Array<{ obligation: string }> };
    expect(record.note).toContain('broken lab machine');
    expect(record.waived.map((entry) => entry.obligation).sort()).toEqual(
      ['build', 'check', 'lane:themes'].sort()
    );

    // The next gate compares with what was last clean, so the waived work is planned again.
    await writeAt(worktree, 'docs/note.md', 'a note\n');
    const next = commit(worktree, 'docs');
    const planned = parse(await f.cli(worktree, ['prove', 'plan', '--tier', 'gate', '--json']));
    expect(planned.plan.base.label).toMatch(/^merge-base with (?:main|master)$/);
    expect(planned.plan.notes.join('\n')).toContain('published with waived obligations');
    expect(Object.keys(states(planned))).toEqual(expect.arrayContaining(['build', 'lane:themes']));

    // A clean publication discharges them.
    const proved = await f.cli(worktree, ['prove', '--tier', 'gate', '--json']);
    expect(proved.code, proved.stderr + (await logs(f))).toBe(0);
    const clean = await f.cli(worktree, ['prove', 'publish']);
    expect(clean.code, said(clean)).toBe(0);
    expect(git(worktree, 'rev-parse', 'refs/fireforge/verified')).toBe(next);
    await writeAt(worktree, 'docs/more.md', 'more\n');
    commit(worktree, 'more docs');
    const after = parse(await f.cli(worktree, ['prove', 'plan', '--tier', 'gate', '--json']));
    expect(after.plan.base.label).toBe('refs/fireforge/verified');
  }, 600_000);
});

describe.concurrent('what a lane produces', () => {
  const CHECKER = 'tools/check-census.mjs';
  const script = (marker: string): string =>
    [
      "import { existsSync, readFileSync } from 'node:fs';",
      'const census = JSON.parse(readFileSync(process.argv[2], "utf8"));',
      `if (!census.from || existsSync(${JSON.stringify(marker)})) process.exit(3);`,
      '',
    ].join('\n');
  const validated = {
    noneRoutes: ['tools/**'],
    gate: {
      lanes: [
        {
          id: 'census',
          files: [TEST],
          uploadDir: true,
          validate: {
            command: ['node', CHECKER, '{artifacts}/modifiedPrefs.json'],
            footprint: { memory: 6 },
          },
        },
      ],
    },
  };

  it('reddens a passing harness when its validator exits nonzero, and keys evidence on it', async () => {
    const { f, worktree, marker } = await agent({ proof: validated });
    const leak = `${marker}-leak`;
    await writeAt(worktree, CHECKER, script(leak));
    commit(worktree, 'task');
    // The same step by hand, without the validator, is not the step the lane asks for.
    const hand = await f.cli(worktree, [
      'job',
      'run',
      '--build',
      'full',
      '--test',
      TEST,
      '--upload-dir',
    ]);
    expect(hand.code, said(hand) + (await logs(f))).toBe(0);
    const unjudged = parse(await f.cli(worktree, ['prove', 'status', '--tier', 'gate', '--json']));
    expect(states(unjudged)['lane:census']).toBe('outstanding');
    await writeFile(leak, 'a pref leaked');
    const red = await f.cli(worktree, ['prove', '--tier', 'gate', '--json']);
    expect(red.code).toBe(ExitCode.JOB_FAILED);
    const report = parse(red);
    expect(states(report)['lane:census']).toBe('red');
    // The check ran first, before the build and the lane, and its pass stands beside the red.
    expect(states(report)['check']).toBe('passed');
    expect(
      said(await f.cli(worktree, ['job', 'logs', (await jobs(f)).at(-1)?.id ?? '']))
    ).toContain('Validator node tools/check-census.mjs');
    await rm(leak);
    // The validator's script is this candidate's own, which a person answers for.
    expect(states(report)['accept:proof-config']).toBe('outstanding');
    const accepted = await f.cli(worktree, [
      'prove',
      'accept',
      'accept:proof-config',
      '--tier',
      'gate',
      '--note',
      'Read the new validator.',
    ]);
    expect(accepted.code, said(accepted)).toBe(0);
    const passed = await f.cli(worktree, ['prove', '--tier', 'gate', '--json']);
    expect(passed.code, passed.stderr + (await logs(f))).toBe(0);
    expect(states(parse(passed))['lane:census']).toBe('passed');
    const step = (await jobs(f)).at(-1)?.request.steps.find((entry) => entry.command === 'test');
    expect(step?.validate?.command[2]).toBe('{artifacts}/modifiedPrefs.json');
    const finished = (await jobs(f)).at(-1);
    expect(finished?.stepResources?.[0]?.memory ?? 0).toBeGreaterThan(0);
  }, 400_000);

  it('runs a captured script directly, refuses a bare program name, and reports a perf sample', async () => {
    const samples = {
      gate: {
        lanes: [{ id: 'perf', files: [TEST], args: ['--perf-samples', '{artifacts}/perf.json'] }],
      },
    };
    const { f, worktree } = await agent({ proof: samples });
    const seen = join(f.directory, 'seen.json');
    await writeAt(
      worktree,
      `src/${TEST}`,
      lintClean(`// fake-mach-record ${seen}\nadd_task(() => ok(true, 'tabs'));\n`)
    );
    commit(worktree, 'task');
    const gate = await f.cli(worktree, ['prove', '--tier', 'gate', '--json']);
    expect(gate.code, gate.stderr + (await logs(f))).toBe(0);
    const output = parse(gate).obligations.find((entry) => entry.id === 'lane:perf')?.output;
    expect(output).toContain(join('artifacts'));
    const harness = JSON.parse(await readFile(seen, 'utf8')) as { env: Record<string, string> };
    expect(harness.env['FIXTURE_PERF_SAMPLE_JSON']).toBe(`${output ?? ''}/perf.json`);
    await editConfig(worktree, (config) => {
      config['proof'] = {
        gate: { lanes: [{ ...LANE, validate: { command: ['sh', '-c', 'x'] } }] },
      };
    });
    const refused = await f.cli(worktree, ['prove', 'plan', '--tier', 'gate']);
    expect(refused.code).not.toBe(0);
    expect(said(refused)).toContain('not a program name');
  }, 400_000);
});

describe.concurrent('an acceptance and a gate recipe', () => {
  it('refuses until what it looks at has passed on this source, and names the job', async () => {
    const proof = {
      gate: {
        lanes: [{ id: 'captures', files: [TEST], uploadDir: true, owns: ['toolkit/**'] }],
        acceptance: [{ id: 'scene', reason: 'A person looks.', evidence: ['lane:captures'] }],
      },
    };
    const { f, worktree } = await agent({ proof });
    commit(worktree, 'task');
    git(f.project, 'merge', '-q', '--ff-only', 'task');
    // Only the CSS differs from the base now, so nothing but the acceptance keeps the lane.
    await writeFile(
      join(worktree, 'src/browser/themes/shared/tabs.css'),
      lintClean(':root { --tab-radius: 8px; }\n')
    );
    commit(worktree, 'restyle');
    const accept = (): Promise<CliResult> =>
      f.cli(worktree, [
        'prove',
        'accept',
        'accept:scene',
        '--tier',
        'gate',
        '--note',
        'Looked at them.',
        '--json',
      ]);
    const early = await accept();
    expect(early.code).toBe(ExitCode.GENERAL_ERROR);
    expect(said(early)).toContain('proof-accept-evidence');
    // The acceptance keeps a lane its `owns` would have left out.
    const gate = await f.cli(worktree, ['prove', '--tier', 'gate', '--json']);
    expect(gate.code).toBe(ExitCode.GENERAL_ERROR);
    const lane = parse(gate).obligations.find((entry) => entry.id === 'lane:captures');
    expect(lane?.state).toBe('passed');
    const accepted = await accept();
    expect(accepted.code, said(accepted)).toBe(0);
    expect(accepted.stderr).toContain(`job=${lane?.job ?? ''} output=${lane?.output ?? ''}`);
    const decision = parse(accepted).obligations.find(
      (entry) => entry.id === 'accept:scene'
    )?.decision;
    expect(decision?.evidence).toEqual([{ obligation: 'lane:captures', job: lane?.job }]);
    expect((await f.cli(worktree, ['prove', 'publish'])).code).toBe(0);
  }, 400_000);

  it('publishes a gate of the recipe it declares', async () => {
    const { f, worktree } = await agent({ proof: { gate: { mode: 'debug', lanes: [LANE] } } });
    const head = commit(worktree, 'task');
    const gate = await f.cli(worktree, ['prove', '--tier', 'gate', '--json']);
    expect(gate.code, gate.stderr + (await logs(f))).toBe(0);
    expect((await jobs(f)).at(-1)?.request.build?.mode).toBe('debug');
    const publish = await f.cli(worktree, ['prove', 'publish']);
    expect(publish.code, said(publish)).toBe(0);
    expect(git(worktree, 'rev-parse', 'refs/fireforge/verified')).toBe(head);
  }, 400_000);
});

describe.concurrent('static feedback', () => {
  it('predicts the proof: one line on warnings, the project own', async () => {
    // An override with no licence header is a warning: nothing says a project has to hold it.
    const bare = 'src/browser/themes/shared/tabs.css';
    const line = {
      skip: ['typecheck', 'furnace-validate', 'token-coverage'],
      maxWarnings: { lint: 0 },
    };
    const held = await agent({ check: line });
    await writeFile(join(held.worktree, bare), ':root { --tab-radius: 6px; }\n');
    const lint = await held.f.cli(held.worktree, ['authored', 'lint']);
    expect(lint.code).not.toBe(0);
    expect(said(lint)).toContain('over check.maxWarnings.lint 0');
    const proved = await held.f.cli(held.worktree, ['prove', '--json']);
    expect(proved.code).toBe(ExitCode.JOB_FAILED);
    expect(states(parse(proved))['static']).toBe('red');

    const open = await agent({});
    await writeFile(join(open.worktree, bare), ':root { --tab-radius: 6px; }\n');
    const free = await open.f.cli(open.worktree, ['authored', 'lint']);
    expect(free.code, said(free)).toBe(0);
    const clean = await open.f.cli(open.worktree, ['prove', '--json']);
    expect(clean.code, clean.stderr + (await logs(open.f))).toBe(0);
    expect(states(parse(clean))['static']).toBe('passed');
  }, 400_000);

  it('lets a lane run by hand with its standalone dispatch', async () => {
    const proof = { gate: { lanes: [{ id: 'scenes', files: [TEST], dispatch: 'standalone' }] } };
    const { f, worktree } = await agent({ proof });
    commit(worktree, 'task');
    const hand = await f.cli(worktree, [
      'job',
      'run',
      '--build',
      'full',
      '--test',
      TEST,
      '--standalone',
    ]);
    expect(hand.code, said(hand) + (await logs(f))).toBe(0);
    const report = parse(await f.cli(worktree, ['prove', 'status', '--tier', 'gate', '--json']));
    expect(states(report)['lane:scenes']).not.toBe('outstanding');
    const both = await f.cli(worktree, [
      'job',
      'run',
      '--test',
      TEST,
      '--standalone',
      '--no-shard',
    ]);
    expect(both.code).toBe(ExitCode.INVALID_ARGUMENT);
  }, 300_000);
});
