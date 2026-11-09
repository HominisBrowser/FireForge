// SPDX-License-Identifier: EUPL-1.2
/** What an agent runs, as real processes, from a linked worktree, against a real coordinator and a fake mach. */
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { ExitCode } from '../../../errors/codes.js';
import { writeAt } from '../../authored/__tests__/fixtures.js';
import {
  type HostFixture,
  lintClean,
  removeHostFixture,
} from '../../jobs/__tests__/host-fixture.js';
import { agent as hostAgent, git, jobs, logs, parse, states, TEST } from './prove-fixture.js';

const fixtures: HostFixture[] = [];
// Every test has its own host, so they run side by side. That is what keeps this file from setting the suite's duration.
afterAll(async () => {
  await Promise.all(fixtures.splice(0).map(removeHostFixture));
}, 120_000);

/** A diff that replaces a file's last line, so that the fake harness's guard reddens. */
async function writeControl(worktree: string, target: string): Promise<void> {
  const bytes = await readFile(join(worktree, 'src', target), 'utf8');
  const lines = bytes.split('\n');
  const count = String(lines.length - 1);
  await writeAt(
    worktree,
    'tools/controls/tabs.diff',
    `--- a/${target}\n+++ b/${target}\n@@ -1,${count} +1,${count} @@\n${lines
      .slice(0, -2)
      .map((line) => ` ${line}`)
      .join('\n')}\n-${lines.at(-2) ?? ''}\n+:root { --tab-radius: 99px; }\n`
  );
}

const agent = (
  options?: Parameters<typeof hostAgent>[1],
  slots?: number
): ReturnType<typeof hostAgent> => hostAgent(fixtures, options, slots);

describe.concurrent('fireforge prove', () => {
  it('goes red, reruns only the red step, completes, and survives a commit of the same bytes', async () => {
    const { f, worktree, marker } = await agent();
    await writeFile(marker, 'red');
    const red = await f.cli(worktree, ['prove', '--tier', 'task', '--json']);
    expect(red.code, red.stderr + (await logs(f))).toBe(ExitCode.JOB_FAILED);
    const first = parse(red);
    expect(first.plan.base.label).toMatch(/^merge-base with (?:main|master)$/);
    expect(states(first)).toEqual({
      static: 'passed',
      build: 'passed',
      [`test:${TEST}`]: 'red',
    });
    const [redJob] = await jobs(f);
    expect(redJob?.request.steps.map((step) => step.command)).toEqual(['lint', 'build', 'test']);
    expect(redJob?.request.steps.every((step) => step.quiet !== true)).toBe(true);
    // The claim is refused while the red stands.
    const refused = await f.cli(worktree, ['prove', 'status', '--complete']);
    expect(refused.code).toBe(ExitCode.GENERAL_ERROR);
    expect(refused.stdout + refused.stderr).toContain('proof-incomplete');
    // The only red is the one that decides, so nothing is earlier than it.
    expect(refused.stdout + refused.stderr).not.toContain('earlier-reds');

    await rm(marker);
    const rerun = await f.cli(worktree, ['prove', '--json']);
    expect(rerun.code, rerun.stderr + (await logs(f))).toBe(0);
    expect(parse(rerun).complete).toBe(true);
    const all = await jobs(f);
    expect(all).toHaveLength(2);
    expect(all[1]?.request.steps.map((step) => step.command)).toEqual(['test']);
    // The earlier red stays on the record after the pass that ended it.
    const report = parse(await f.cli(worktree, ['prove', 'status', '--json']));
    expect(report.obligations.find((entry) => entry.id === `test:${TEST}`)?.reds).toBe(1);

    const complete = await f.cli(worktree, ['prove', 'status', '--complete']);
    expect(complete.code, complete.stdout + complete.stderr).toBe(0);
    expect(complete.stdout).toContain('Proof complete: 3 of 3');
    expect(complete.stdout).toContain('earlier-reds=1');

    // Committing the same bytes is the same source, and a further run has nothing to do.
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-qm', 'task');
    const committed = await f.cli(worktree, ['prove', '--json']);
    expect(committed.code).toBe(0);
    expect(parse(committed).complete).toBe(true);
    expect(await jobs(f)).toHaveLength(2);

    // Clean on the branch, naming HEAD compares with nothing, which refuses rather than passes.
    const empty = await f.cli(worktree, ['prove', 'status', '--base', 'HEAD', '--complete']);
    expect(empty.code).toBe(ExitCode.GENERAL_ERROR);
    expect(empty.stdout + empty.stderr).toContain('proof-empty-input');

    // One docs commit on top: a base that hides the runtime commit cannot claim the branch.
    await writeAt(worktree, 'docs/note.md', 'a note\n');
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-qm', 'docs');
    const narrow = await f.cli(worktree, ['prove', '--base', 'HEAD~1', '--json']);
    expect(narrow.code, narrow.stderr).toBe(0);
    expect(parse(narrow).verdict).toBe('narrowed');
    const claim = await f.cli(worktree, ['prove', 'status', '--base', 'HEAD~1', '--complete']);
    expect(claim.code).toBe(ExitCode.GENERAL_ERROR);
    expect(claim.stdout + claim.stderr).toContain('proof-base-narrowed');
    // Without it, the plan is the branch's again, and the docs commit changed the source.
    const branch = parse(await f.cli(worktree, ['prove', 'status', '--json']));
    expect(branch.complete).toBe(false);
    expect(Object.keys(states(branch))).toContain(`test:${TEST}`);
  }, 400_000);

  it('gives every gate obligation a verdict in one job: the check first, past reds, blocked by a red build', async () => {
    const other = 'browser/themes/test/browser_more.js';
    const { f, worktree, marker } = await agent({
      check: {
        skip: ['typecheck', 'furnace-validate', 'token-coverage'],
        extraSteps: [{ name: 'audit', command: 'false', footprint: { static: true } }],
      },
      proof: {
        gate: {
          lanes: [
            { id: 'tabs', files: [TEST] },
            { id: 'more', files: [other] },
          ],
        },
      },
    });
    await writeAt(worktree, `src/${other}`, lintClean("add_task(() => ok(true, 'more'));\n"));
    await writeFile(marker, 'red');
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-qm', 'task');
    const gates = async (): Promise<Awaited<ReturnType<typeof jobs>>> =>
      (await jobs(f)).filter((job) => job.request.finalGate === true);

    // A sample never stands for a gate, from the command line down.
    const sampled = await f.cli(worktree, ['prove', 'plan', '--tier', 'gate', '--sample', '3']);
    expect(sampled.code).toBe(ExitCode.GENERAL_ERROR);
    expect(sampled.stdout + sampled.stderr).toContain('proof-sample-gate');

    // A red check and a red lane, and the rest passes: all of it from one job.
    const red = await f.cli(worktree, ['prove', '--tier', 'gate', '--json']);
    expect(red.code, red.stderr + (await logs(f))).toBe(ExitCode.JOB_FAILED);
    expect(states(parse(red))).toEqual({
      check: 'red',
      build: 'passed',
      'lane:more': 'passed',
      'lane:tabs': 'red',
    });
    // The red lane reads what this change's own commit touched, and the report says so.
    const attributed = (
      JSON.parse(red.stdout) as {
        range: { label: string; total: number; onMain: number };
        attribution: Array<{ obligation: string; path?: string; commits: Array<{ own: boolean }> }>;
      }
    ).attribution.find((entry) => entry.obligation === 'lane:tabs');
    expect(attributed).toMatchObject({ path: TEST, verdict: 'touched' });
    expect(attributed?.commits.every((entry) => entry.own)).toBe(true);
    expect(parse(red).plan.base.label).toMatch(/^merge-base with/);
    const [first] = await gates();
    expect(await gates()).toHaveLength(1);
    // The check runs first: it needs no build, so a static red costs none.
    expect(first?.request.steps.map((step) => step.command)).toEqual([
      'check',
      'build',
      'test',
      'test',
    ]);
    expect(first?.state).toBe('failed');
    expect(first?.stepVerdicts?.map((verdict) => verdict.state)).toEqual(['red', 'red']);

    // A red build: the lanes have nothing to run on, so they are blocked, not red.
    await writeFile(
      join(worktree, 'src/browser/themes/shared/tabs.css'),
      lintClean(':root { --tab-radius: 6px; }\n/* fake-mach-build-red */\n')
    );
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-qm', 'break the build');
    const broken = await f.cli(worktree, ['prove', '--tier', 'gate', '--json']);
    expect(broken.code, broken.stderr + (await logs(f))).toBe(ExitCode.JOB_FAILED);
    const report = parse(broken);
    expect(states(report)).toEqual({
      check: 'red',
      build: 'red',
      'lane:more': 'blocked',
      'lane:tabs': 'blocked',
    });
    const lane = report.obligations.find((entry) => entry.id === 'lane:tabs');
    expect(lane?.reds).toBe(0);
    expect(lane?.detail).toMatch(/^Blocked by step 1 \(build\), which went red/);
    const status = await f.cli(worktree, ['prove', 'status', '--tier', 'gate']);
    expect(status.stdout).toMatch(
      /^ {2}blocked {5}lane:tabs {2}job=\S+ Blocked by step 1 \(build\)/m
    );
    expect(status.stdout).toContain('Proof incomplete: 0 of 4 obligations');
    // An incomplete gate publishes nothing, and says what is missing.
    const publish = await f.cli(worktree, ['prove', 'publish']);
    expect(publish.code).toBe(ExitCode.GENERAL_ERROR);
    expect(publish.stdout + publish.stderr).toContain('lane:tabs (blocked)');
    expect(() => git(worktree, 'rev-parse', '--verify', '-q', 'refs/fireforge/verified')).toThrow();
  }, 600_000);

  it('combines evidence from jobs on two slots, and only under one identity', async () => {
    const { f, worktree } = await agent({}, 2);
    const other = 'browser/themes/test/browser_more.js';
    await writeAt(worktree, `src/${other}`, lintClean("add_task(() => ok(true, 'more'));\n"));
    // Any job contributes: this one is not a proof command and runs on another slot.
    const one = await f.cli(worktree, [
      'job',
      'run',
      '--slot',
      'a',
      '--build',
      'full',
      '--test',
      TEST,
    ]);
    expect(one.code, one.stdout + one.stderr + (await logs(f))).toBe(0);
    const two = await f.cli(worktree, [
      'job',
      'run',
      '--slot',
      'b',
      '--build',
      'full',
      '--test',
      other,
    ]);
    expect(two.code, two.stdout + two.stderr + (await logs(f))).toBe(0);
    const before = (await jobs(f)).length;
    const report = parse(await f.cli(worktree, ['prove', 'status', '--json']));
    expect(states(report)).toMatchObject({
      build: 'passed',
      [`test:${TEST}`]: 'passed',
      [`test:${other}`]: 'passed',
      static: 'outstanding',
    });
    // Different job IDs, execution roots and slots, one evidence key.
    const receipts = (await jobs(f)).map((job) => job.receipt);
    expect(receipts[0]?.environmentDigest).toBe(receipts[1]?.environmentDigest);
    expect(receipts[0]?.steps[1]?.runtimeAfter?.build).toEqual(
      receipts[1]?.steps[1]?.runtimeAfter?.build
    );
    const finish = await f.cli(worktree, ['prove', '--json']);
    expect(finish.code, finish.stderr + (await logs(f))).toBe(0);
    expect(parse(finish).complete).toBe(true);
    const all = await jobs(f);
    expect(all).toHaveLength(before + 1);
    expect(all.at(-1)?.request.steps.map((step) => step.command)).toEqual(['lint']);
  }, 400_000);

  it('invalidates on a source change, a changed recipe and a changed toolchain', async () => {
    const { f, worktree } = await agent();
    const proved = await f.cli(worktree, ['prove', '--json']);
    expect(proved.code, proved.stderr + (await logs(f))).toBe(0);
    expect(parse(proved).complete).toBe(true);

    // A recipe nothing was built with proves nothing, and the claim for it is refused.
    const recipe = await f.cli(worktree, ['prove', 'status', '--mode', 'debug', '--json']);
    expect(states(parse(recipe))).toEqual({
      static: 'passed',
      build: 'stale',
      [`test:${TEST}`]: 'stale',
    });
    const claim = await f.cli(worktree, ['prove', 'status', '--mode', 'debug', '--complete']);
    expect(claim.code).toBe(ExitCode.GENERAL_ERROR);
    // Building the other recipe proves that recipe's build, and disturbs nothing of the first.
    await writeFile(
      join(f.directory, 'debug.json'),
      JSON.stringify({
        steps: [{ command: 'build', args: [] }],
        build: { mode: 'debug', brand: 'fixture' },
      })
    );
    const snapshotFile = join(f.directory, 'debug-snapshot.json');
    const capture = await f.cli(worktree, ['authored', 'capture', '--out', snapshotFile]);
    expect(capture.code, capture.stdout + capture.stderr).toBe(0);
    const submitted = await f.cli(worktree, [
      'job',
      'submit',
      join(f.directory, 'debug.json'),
      '--snapshot',
      snapshotFile,
      '--json',
    ]);
    expect(submitted.code, submitted.stdout + submitted.stderr).toBe(0);
    const debug = await f.cli(worktree, [
      'job',
      'wait',
      (JSON.parse(submitted.stdout) as { id: string }).id,
      '--timeout',
      '120',
    ]);
    expect(debug.code, debug.stdout + debug.stderr + (await logs(f))).toBe(0);
    expect(
      states(parse(await f.cli(worktree, ['prove', 'status', '--mode', 'debug', '--json'])))
    ).toEqual({
      static: 'passed',
      build: 'passed',
      [`test:${TEST}`]: 'stale',
    });
    expect((await f.cli(worktree, ['prove', 'status', '--complete'])).code).toBe(0);

    // The host's toolchain moves: what was built with the old one no longer counts.
    await writeAt(f.home, '.mozbuild/clang/bin/llvm-ar', '#!/bin/sh\necho changed tool\n', true);
    const init = await f.cli(worktree, ['host', 'init', '--slots', '1', '--from-engine', f.donor]);
    expect(init.code, init.stdout + init.stderr).toBe(0);
    const tools = parse(await f.cli(worktree, ['prove', 'status', '--json']));
    expect(tools.complete).toBe(false);
    expect(states(tools)).toMatchObject({ build: 'stale', [`test:${TEST}`]: 'stale' });
    expect(tools.obligations.find((entry) => entry.id === `test:${TEST}`)?.detail).toContain(
      'toolchain'
    );
    expect((await f.cli(worktree, ['prove', 'status', '--complete'])).code).toBe(
      ExitCode.GENERAL_ERROR
    );
    // The same request as before is new work now, and it brings the proof back.
    const rebuilt = await f.cli(worktree, ['prove', '--json']);
    expect(rebuilt.code, rebuilt.stderr + (await logs(f))).toBe(0);
    expect(parse(rebuilt).complete).toBe(true);
    // And again: an identical request to a passed job is still new work when its evidence went stale.
    await writeAt(f.home, '.mozbuild/clang/bin/llvm-ar', '#!/bin/sh\necho changed again\n', true);
    const again = await f.cli(worktree, ['host', 'init', '--slots', '1', '--from-engine', f.donor]);
    expect(again.code, again.stdout + again.stderr).toBe(0);
    const repeated = await f.cli(worktree, ['prove', '--json']);
    expect(repeated.code, repeated.stderr + (await logs(f))).toBe(0);
    expect(parse(repeated).complete).toBe(true);

    // Any source change is another source, with no evidence at all.
    await writeFile(
      join(worktree, 'src/browser/themes/shared/tabs.css'),
      lintClean(':root { --tab-radius: 7px; }\n')
    );
    const changed = parse(await f.cli(worktree, ['prove', 'status', '--json']));
    expect(new Set(Object.values(states(changed)))).toEqual(new Set(['outstanding']));
  }, 400_000);

  it('runs a declared gate, takes human decisions as such, and publishes the exact tree', async () => {
    const { f, worktree } = await agent({
      proof: {
        noneRoutes: ['tools/**'],
        gate: {
          lanes: [
            { id: 'themes', files: ['browser/themes/test/browser_*.js'], dispatch: 'one-browser' },
            {
              id: 'scenes',
              files: ['browser/scenes/test/browser_scene.js'],
              dispatch: 'standalone',
            },
            { id: 'quiet', files: ['browser/scenes/test/browser_timing.js'], quiet: true },
            { id: 'unowned', files: ['browser/upstream/test/browser_up.js'], owns: ['toolkit/**'] },
          ],
          stress: [
            {
              id: 'tabs',
              files: [TEST],
              context: ['browser/scenes/test/browser_timing.js'],
              repeat: 3,
            },
          ],
          controls: [
            {
              id: 'tabs-caught',
              diff: 'tools/controls/tabs.diff',
              test: 'browser/scenes/test/browser_guard.js',
              assertions: ['ok'],
            },
          ],
          runs: [{ id: 'smoke', args: ['--headless', '--smoke-exit', '1'] }],
          acceptance: [{ id: 'tab-scene', reason: 'A person looks at the tab strip.' }],
        },
      },
    });
    for (const name of ['scene', 'timing'])
      await writeAt(
        worktree,
        `src/browser/scenes/test/browser_${name}.js`,
        lintClean(`add_task(() => ok(true, '${name}'));\n`)
      );
    await writeAt(
      worktree,
      'src/browser/scenes/test/browser_guard.js',
      lintClean(
        "// fake-mach-red-if browser/themes/shared/tabs.css 99px\nadd_task(() => ok(true, 'guard'));\n"
      )
    );
    await writeControl(worktree, 'browser/themes/shared/tabs.css');
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-qm', 'task');
    const commit = git(worktree, 'rev-parse', 'HEAD');

    const preview = parse(await f.cli(worktree, ['prove', 'plan', '--tier', 'gate', '--json']));
    expect(Object.keys(states(preview)).sort()).toEqual(
      [
        // The control's diff arrives with this candidate, and a person answers for what judges it.
        'accept:proof-config',
        'accept:tab-scene',
        'build',
        'check',
        'control:tabs-caught',
        'lane:quiet',
        'lane:scenes',
        'lane:themes',
        'run:smoke',
        'stress:tabs',
        'test:browser/scenes/test/browser_guard.js',
      ].sort()
    );
    expect(await jobs(f)).toHaveLength(0);

    // Nothing but a person satisfies the scene, however green the machine work is.
    const gate = await f.cli(worktree, ['prove', '--tier', 'gate', '--json']);
    expect(gate.code, gate.stderr + (await logs(f))).toBe(ExitCode.GENERAL_ERROR);
    expect(states(parse(gate))).toMatchObject({
      'accept:tab-scene': 'outstanding',
      check: 'passed',
      'control:tabs-caught': 'passed',
      'lane:quiet': 'passed',
      'lane:scenes': 'passed',
      'lane:themes': 'passed',
      'run:smoke': 'passed',
      'stress:tabs': 'passed',
    });
    const [job] = await jobs(f);
    expect(job?.request.finalGate).toBe(true);
    const byId = (needle: string): { args: string[]; quiet?: boolean } | undefined =>
      job?.request.steps.find((step) => step.args.includes(needle));
    expect(byId('--no-shard')?.args).toContain('browser/themes/test/browser_tabs.js');
    expect(byId('--restart-between-tests')?.args).toContain('browser/scenes/test/browser_scene.js');
    expect(byId('--repeat')?.args).toEqual(expect.arrayContaining(['--repeat', '3', '--no-shard']));
    // Quiet comes only from what declared it: the lane that asked, and the control the core requires.
    expect(
      job?.request.steps.filter((step) => step.quiet === true).map((step) => step.args.at(-1))
    ).toEqual(['browser/scenes/test/browser_guard.js', 'browser/scenes/test/browser_timing.js']);
    const refused = await f.cli(worktree, ['prove', 'publish']);
    expect(refused.code).toBe(ExitCode.GENERAL_ERROR);
    expect(refused.stdout + refused.stderr).toContain('accept:tab-scene');
    const machine = await f.cli(worktree, [
      'prove',
      'accept',
      'lane:themes',
      '--tier',
      'gate',
      '--note',
      'no',
    ]);
    expect(machine.stdout + machine.stderr).toContain('proof-accept-machine-obligation');
    // One obligation alone answers for itself, not for the incomplete plan, and the gate's evidence meets it.
    const submitted = (await jobs(f)).length;
    const lane = await f.cli(worktree, ['prove', '--tier', 'gate', '--lane', 'scenes', '--json']);
    expect(lane.code, lane.stdout + lane.stderr).toBe(0);
    expect(states(parse(lane))['lane:scenes']).toBe('passed');
    expect(await jobs(f)).toHaveLength(submitted);
    const person = await f.cli(worktree, ['prove', '--tier', 'gate', '--lane', 'accept:tab-scene']);
    expect(person.stdout + person.stderr).toContain('proof-lane-acceptance');
    const task = await f.cli(worktree, ['prove', '--lane', 'scenes']);
    expect(task.code).toBe(ExitCode.INVALID_ARGUMENT);
    const judged = await f.cli(worktree, [
      'prove',
      'accept',
      'accept:proof-config',
      '--tier',
      'gate',
      '--note',
      'Read the control.',
    ]);
    expect(judged.code, judged.stderr).toBe(0);
    const accepted = await f.cli(worktree, [
      'prove',
      'accept',
      'accept:tab-scene',
      '--tier',
      'gate',
      '--note',
      'Looked at the tab strip in both densities.',
      '--json',
    ]);
    expect(accepted.code, accepted.stderr).toBe(0);
    const report = parse(accepted);
    expect(report.complete).toBe(true);
    expect(states(report)['accept:tab-scene']).toBe('accepted');

    const published = await f.cli(worktree, ['prove', 'publish']);
    expect(published.code, published.stdout + published.stderr).toBe(0);
    expect(published.stdout).toContain('accepted by');
    expect(git(worktree, 'rev-parse', 'refs/fireforge/verified')).toBe(commit);

    // A commit with another tree has no evidence, and publishing it refuses.
    await writeAt(worktree, 'docs/later.md', 'later\n');
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-qm', 'later');
    const later = await f.cli(worktree, ['prove', 'publish']);
    expect(later.code).toBe(ExitCode.GENERAL_ERROR);
    expect(later.stdout + later.stderr).toContain('proof-publish-no-evidence');
    expect(git(worktree, 'rev-parse', 'refs/fireforge/verified')).toBe(commit);

    // A rewrite leaves verified on a commit outside the branch: refused until stated.
    const rewritten = join(f.directory, 'rewritten');
    git(worktree, 'worktree', 'add', '-q', '--detach', rewritten, commit);
    git(rewritten, 'commit', '-q', '--amend', '-m', 'task, reworded');
    const same = await f.cli(rewritten, ['prove', 'publish']);
    expect(same.code).toBe(ExitCode.GENERAL_ERROR);
    expect(same.stdout + same.stderr).toContain('proof-verified-not-ancestor');
    const forced = await f.cli(rewritten, ['prove', 'publish', '--allow-rewrite']);
    expect(forced.code, forced.stdout + forced.stderr).toBe(0);
    expect(forced.stdout).toContain('history rewrite');
    expect(git(worktree, 'rev-parse', 'refs/fireforge/verified')).toBe(
      git(rewritten, 'rev-parse', 'HEAD')
    );
  }, 600_000);

  it('does not take a check that skipped lint as a gate, whatever its configuration says', async () => {
    const { f, worktree } = await agent({
      check: {
        skip: ['lint', 'typecheck', 'furnace-validate', 'token-coverage'],
        extraSteps: [{ name: 'audit', command: 'true', footprint: { static: true } }],
      },
    });
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-qm', 'task');
    const gate = await f.cli(worktree, ['prove', '--tier', 'gate', '--json']);
    expect(gate.code, gate.stderr + (await logs(f))).toBe(ExitCode.GENERAL_ERROR);
    const check = parse(gate).obligations.find((entry) => entry.id === 'check');
    expect(check?.state).toBe('stale');
    expect(check?.detail).toContain('lint');
  }, 300_000);

  it('shows a waiver as a waiver in status and in the completion claim', async () => {
    const { f, worktree } = await agent();
    const waived = await f.cli(worktree, [
      'prove',
      'waive',
      `test:${TEST}`,
      '--allow-machine',
      '--tier',
      'task',
      '--note',
      'Blocked on an upstream harness bug.',
    ]);
    expect(waived.code, waived.stdout + waived.stderr).toBe(0);
    expect((await f.cli(worktree, ['prove'])).code, await logs(f)).toBe(0);
    const claim = await f.cli(worktree, ['prove', 'status', '--complete']);
    expect(claim.code).toBe(0);
    expect(claim.stdout).toMatch(/waived\s+test:/);
    expect(claim.stdout).toContain('Blocked on an upstream harness bug.');
    expect(claim.stdout).toContain('waived by');
    expect(claim.stdout).toContain('Proof complete-with-waivers');
    // The waiver is why that test never ran.
    expect((await jobs(f)).flatMap((job) => job.request.steps.map((step) => step.command))).toEqual(
      ['lint', 'build']
    );
  }, 400_000);

  it('runs a task-tier control named on the command line, and refuses one unrelated to the change', async () => {
    const { f, worktree } = await agent();
    const guard = 'browser/scenes/test/browser_guard.js';
    await writeAt(
      worktree,
      `src/${guard}`,
      lintClean(
        "// fake-mach-red-if browser/themes/shared/tabs.css 99px\nadd_task(() => ok(true, 'guard'));\n"
      )
    );
    await writeControl(worktree, 'browser/themes/shared/tabs.css');
    const control = ['--control', 'tools/controls/tabs.diff', '--control-test', guard];
    const proved = await f.cli(worktree, ['prove', ...control, '--expect', 'ok', '--json']);
    expect(proved.code, proved.stderr + (await logs(f))).toBe(0);
    const report = parse(proved);
    expect(report.complete).toBe(true);
    expect(states(report)['control:tools/controls/tabs.diff']).toBe('passed');
    const steps = (await jobs(f)).flatMap((job) => job.request.steps);
    expect(steps.find((step) => step.controlAssertions !== undefined)?.quiet).toBe(true);
    // The slot's source came back: the same source proves itself with no further job.
    const count = (await jobs(f)).length;
    const again = await f.cli(worktree, ['prove', ...control, '--expect', 'ok', '--json']);
    expect(parse(again).complete).toBe(true);
    expect(await jobs(f)).toHaveLength(count);

    // Expecting an assertion it does not redden is a red, and it stays one.
    const wrong = await f.cli(worktree, ['prove', ...control, '--expect', 'another', '--json']);
    expect(wrong.code).toBe(ExitCode.JOB_FAILED);
    expect(states(parse(wrong))['control:tools/controls/tabs.diff']).toBe('red');
    // The step judged the labels as the proof does: no caught verdict, and the labels it saw.
    const log = await logs(f);
    expect(log).toContain('control=inconclusive');
    expect(log).not.toContain('control=caught');
    expect(log).toContain('expected "another"; the reds were labelled "ok"');
  }, 300_000);

  it('runs a headed lane with its declared environment, under --no-wait, and an always control', async () => {
    const record = 'browser/scenes/test/browser_window.js';
    const notes = 'browser/scenes/notes.md';
    const guard = 'browser/scenes/test/browser_guard.js';
    const { f, worktree } = await agent({
      proof: {
        noneRoutes: ['tools/**'],
        gate: {
          lanes: [
            {
              id: 'window',
              files: [record],
              headed: true,
              dispatch: 'one-browser',
              uploadDir: true,
              env: { PROJECT_FIGURES: '{artifacts}/figures.json' },
              machArgs: ['--setpref=focusmanager.testmode=true'],
              keepAwake: false,
            },
          ],
          controls: [
            {
              id: 'always-notes',
              diff: 'tools/controls/tabs.diff',
              test: guard,
              assertions: ['ok'],
              always: true,
            },
          ],
        },
      },
    });
    const seen = join(f.directory, 'window.json');
    await writeAt(
      worktree,
      `src/${record}`,
      lintClean(`// fake-mach-record ${seen}\nadd_task(() => ok(true, 'window'));\n`)
    );
    await writeAt(
      worktree,
      `src/${guard}`,
      lintClean(`// fake-mach-red-if ${notes} 99px\nadd_task(() => ok(true, 'guard'));\n`)
    );
    await writeAt(worktree, `src/${notes}`, ':root { --tab-radius: 1px; }\n');
    // The mutation touches a document, so nothing but `always` could retain this control.
    await writeControl(worktree, notes);
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-qm', 'task');

    const queued = await f.cli(worktree, ['prove', '--tier', 'gate', '--no-wait']);
    expect(queued.code, queued.stdout + queued.stderr).toBe(0);
    const id = queued.stdout.split(' ')[0] ?? '';
    expect(id).toMatch(/^[a-f0-9-]{36}$/);
    const wait = await f.cli(worktree, ['job', 'wait', id, '--timeout', '200']);
    expect(wait.code, wait.stdout + wait.stderr + (await logs(f))).toBe(0);

    // The control's diff arrives with this candidate, and a person answers for what judges it.
    const judged = await f.cli(worktree, [
      'prove',
      'accept',
      'accept:proof-config',
      '--tier',
      'gate',
      '--note',
      'Read the control.',
      '--json',
    ]);
    expect(judged.code, judged.stderr).toBe(0);
    const report = parse(judged);
    expect(report.complete).toBe(true);
    expect(states(report)['control:always-notes']).toBe('passed');
    const window = report.obligations.find((entry) => entry.id === 'lane:window') as
      { output?: string } | undefined;
    expect(window?.output).toContain(join('artifacts', id));
    const harness = JSON.parse(await readFile(seen, 'utf8')) as {
      env: Record<string, string>;
      args: string[];
    };
    expect(harness.env['MOZ_UPLOAD_DIR']).toBe(window?.output);
    expect(harness.env['PROJECT_FIGURES']).toBe(`${window?.output ?? ''}/figures.json`);
    expect(harness.args).toContain('--setpref=focusmanager.testmode=true');
    expect(harness.args).not.toContain('--headless');
    const [job] = await jobs(f);
    const lane = job?.request.steps.find((step) => step.args.includes(record));
    expect(lane?.args).not.toContain('--headless');
    expect(job?.stepResources?.[job.request.steps.indexOf(lane as never)]?.display).toBe(1);
  }, 400_000);

  it('an always control that catches nothing leaves the gate unmet', async () => {
    const guard = 'browser/scenes/test/browser_guard.js';
    const notes = 'browser/scenes/notes.md';
    const { f, worktree } = await agent({
      proof: {
        noneRoutes: ['tools/**'],
        gate: {
          controls: [
            {
              id: 'blind',
              diff: 'tools/controls/tabs.diff',
              test: guard,
              assertions: ['ok'],
              always: true,
            },
          ],
        },
      },
    });
    // This test reads nothing the mutation changes.
    await writeAt(worktree, `src/${guard}`, lintClean("add_task(() => ok(true, 'guard'));\n"));
    await writeAt(worktree, `src/${notes}`, ':root { --tab-radius: 1px; }\n');
    await writeControl(worktree, notes);
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-qm', 'task');
    const gate = await f.cli(worktree, ['prove', '--tier', 'gate', '--json']);
    expect(gate.code, gate.stderr + (await logs(f))).toBe(ExitCode.JOB_FAILED);
    const report = parse(gate);
    expect(report.complete).toBe(false);
    expect(states(report)['control:blind']).toBe('red');
  }, 300_000);
});
