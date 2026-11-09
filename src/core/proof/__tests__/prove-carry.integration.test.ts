// SPDX-License-Identifier: EUPL-1.2
/** What a gate owes for a commit that changes only documents on top of a verified one, as real processes. */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { ExitCode } from '../../../errors/codes.js';
import { writeAt } from '../../authored/__tests__/fixtures.js';
import {
  type CliResult,
  type HostFixture,
  lintClean,
  removeHostFixture,
} from '../../jobs/__tests__/host-fixture.js';
import {
  agent as hostAgent,
  git,
  jobs,
  logs,
  parse,
  type Report,
  states,
} from './prove-fixture.js';

const fixtures: HostFixture[] = [];
afterAll(async () => {
  await Promise.all(fixtures.splice(0).map(removeHostFixture));
}, 120_000);

const said = (result: CliResult): string => result.stdout + result.stderr;

const commit = (worktree: string, message: string): string => {
  git(worktree, 'add', '-A');
  git(worktree, 'commit', '-qm', message);
  return git(worktree, 'rev-parse', 'HEAD');
};

const carriedFrom = (report: Report, id: string): string | undefined =>
  report.obligations.find((entry) => entry.id === id)?.carried;

/** A lane with no `owns`, so it applies to every candidate, judged by a validator under a none route. */
const OPTIONS = {
  proof: {
    noneRoutes: ['tools/**'],
    gate: {
      lanes: [
        {
          id: 'themes',
          files: ['browser/themes/test/browser_*.js'],
          uploadDir: true,
          validate: { command: ['node', 'tools/count.mjs', '{artifacts}'] },
        },
      ],
    },
  },
  projectFiles: { 'tools/count.mjs': 'process.exit(0);\n' },
};

describe.concurrent('a documents-only candidate', () => {
  it('carries the verified evidence and runs only the check, along a chain, and nothing else', async () => {
    const { f, worktree } = await hostAgent(fixtures, OPTIONS);
    const verified = commit(worktree, 'task');
    const gate = await f.cli(worktree, ['prove', '--tier', 'gate', '--json']);
    expect(gate.code, said(gate) + (await logs(f))).toBe(0);
    const first = await f.cli(worktree, ['prove', 'publish']);
    expect(first.code, said(first)).toBe(0);
    expect(git(worktree, 'rev-parse', 'refs/fireforge/verified')).toBe(verified);
    const before = (await jobs(f)).length;

    // Ledger entries at the root and under docs/: nothing a build or a test reads.
    await writeAt(worktree, 'FRICTIONS.md', '- the gate took two hours for a typo\n');
    await writeAt(worktree, 'docs/findings/findings.json', '{"findings":[]}\n');
    const ledger = commit(worktree, 'ledger');
    const planned = parse(await f.cli(worktree, ['prove', 'plan', '--tier', 'gate', '--json']));
    expect(states(planned)).toEqual({
      build: 'passed',
      'lane:themes': 'passed',
      check: 'outstanding',
    });
    expect(carriedFrom(planned, 'lane:themes')).toBe(verified);
    expect(carriedFrom(planned, 'build')).toBe(verified);
    expect(carriedFrom(planned, 'check')).toBeUndefined();

    // The check still runs on this tree, since a static check reads documents too.
    const carried = await f.cli(worktree, ['prove', '--tier', 'gate', '--json']);
    expect(carried.code, said(carried) + (await logs(f))).toBe(0);
    const all = await jobs(f);
    expect(all).toHaveLength(before + 1);
    expect(all.at(-1)?.request.steps.map((step) => step.command)).toEqual(['check']);
    const status = await f.cli(worktree, ['prove', 'status', '--tier', 'gate', '--complete']);
    expect(status.code, said(status)).toBe(0);
    expect(status.stdout).toContain(`carried-from=${verified.slice(0, 12)}`);
    const published = await f.cli(worktree, ['prove', 'publish']);
    expect(published.code, said(published)).toBe(0);
    expect(published.stdout).toContain(`carried-from=${verified.slice(0, 12)}`);
    expect(git(worktree, 'rev-parse', 'refs/fireforge/verified')).toBe(ledger);
    const record = JSON.parse(
      git(worktree, 'cat-file', 'blob', `refs/fireforge/verified-carries/${ledger}`)
    ) as { commit: string; from: string; carried: string[] };
    expect(record).toMatchObject({ commit: ledger, from: verified });
    expect(record.carried.sort()).toEqual(['build', 'lane:themes']);

    // A further ledger entry carries from the evidence itself, not from the carried commit.
    await writeAt(worktree, 'FORGE.md', '- one more\n');
    commit(worktree, 'another ledger');
    const chained = parse(await f.cli(worktree, ['prove', 'plan', '--tier', 'gate', '--json']));
    expect(states(chained)).toEqual({
      build: 'passed',
      'lane:themes': 'passed',
      check: 'outstanding',
    });
    expect(carriedFrom(chained, 'lane:themes')).toBe(verified);
    const chainRun = await f.cli(worktree, ['prove', '--tier', 'gate', '--json']);
    expect(chainRun.code, said(chainRun) + (await logs(f))).toBe(0);
    expect((await jobs(f)).at(-1)?.request.steps.map((step) => step.command)).toEqual(['check']);
    expect((await f.cli(worktree, ['prove', 'publish'])).code).toBe(0);

    // A runtime file beside a document: the full obligations again.
    await writeAt(worktree, 'docs/more.md', 'more\n');
    await writeFile(
      join(worktree, 'src/browser/themes/shared/tabs.css'),
      lintClean(':root { --tab-radius: 8px; }\n')
    );
    commit(worktree, 'docs and a style');
    const mixed = parse(await f.cli(worktree, ['prove', 'plan', '--tier', 'gate', '--json']));
    expect(states(mixed)).toEqual({
      build: 'outstanding',
      'lane:themes': 'outstanding',
      check: 'outstanding',
    });
    expect(mixed.obligations.every((entry) => entry.carried === undefined)).toBe(true);
    git(worktree, 'reset', '-q', '--hard', 'HEAD~1');

    // A validator under a none route is a judge: changing it carries nothing.
    await writeFile(join(worktree, 'tools/count.mjs'), 'process.exit(0); // loosened\n');
    commit(worktree, 'touch the validator');
    const judged = parse(await f.cli(worktree, ['prove', 'plan', '--tier', 'gate', '--json']));
    expect(states(judged)).toMatchObject({
      build: 'outstanding',
      'lane:themes': 'outstanding',
      check: 'outstanding',
      'accept:proof-config': 'outstanding',
    });
    expect(judged.obligations.every((entry) => entry.carried === undefined)).toBe(true);
    git(worktree, 'reset', '-q', '--hard', 'HEAD~1');

    // A named base carries nothing, and publish takes nothing a carried run did not show.
    await writeAt(worktree, 'docs/named.md', 'named\n');
    commit(worktree, 'docs again');
    const named = parse(
      await f.cli(worktree, ['prove', 'plan', '--tier', 'gate', '--base', 'HEAD~1', '--json'])
    );
    expect(states(named)['lane:themes']).toBe('outstanding');
    const unrun = await f.cli(worktree, ['prove', 'publish']);
    expect(unrun.code).toBe(ExitCode.GENERAL_ERROR);
    expect(said(unrun)).toContain('proof-publish-no-evidence');
  }, 600_000);

  it('carries nothing past a base published with waivers', async () => {
    const { f, worktree } = await hostAgent(fixtures, OPTIONS);
    commit(worktree, 'task');
    expect((await f.cli(worktree, ['prove', '--tier', 'gate'])).code, await logs(f)).toBe(0);
    expect((await f.cli(worktree, ['prove', 'publish'])).code).toBe(0);

    // A style change published with everything waived is no base, so nothing of it carries.
    await writeFile(
      join(worktree, 'src/browser/themes/shared/tabs.css'),
      lintClean(':root { --tab-radius: 9px; }\n')
    );
    const waivedCommit = commit(worktree, 'style');
    for (const id of ['build', 'lane:themes', 'check'])
      expect(
        (
          await f.cli(worktree, [
            'prove',
            'waive',
            id,
            '--tier',
            'gate',
            '--allow-machine',
            '--note',
            'later',
          ])
        ).code
      ).toBe(0);
    // Waivers alone leave no snapshot to publish from, so one cheap job captures this tree.
    await f.cli(worktree, ['job', 'run', '--check']);
    const waived = await f.cli(worktree, ['prove', 'publish', '--allow-waived', '--note', 'later']);
    expect(waived.code, said(waived)).toBe(0);
    expect(git(worktree, 'rev-parse', 'refs/fireforge/verified')).toBe(waivedCommit);

    await writeAt(worktree, 'FRICTIONS.md', '- a ledger entry\n');
    commit(worktree, 'ledger');
    const planned = parse(await f.cli(worktree, ['prove', 'plan', '--tier', 'gate', '--json']));
    expect(planned.plan.base.commit).not.toBe(waivedCommit);
    expect(states(planned)).toEqual({
      build: 'outstanding',
      'lane:themes': 'outstanding',
      check: 'outstanding',
    });
    expect(planned.obligations.every((entry) => entry.carried === undefined)).toBe(true);
  }, 600_000);
});
