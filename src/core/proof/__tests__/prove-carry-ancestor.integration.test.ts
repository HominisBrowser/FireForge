// SPDX-License-Identifier: EUPL-1.2
/** What a gate owes for documents on top of an unpublished commit whose gate is complete, as real processes. */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { writeAt } from '../../authored/__tests__/fixtures.js';
import {
  type CliResult,
  type HostFixture,
  lintClean,
  removeHostFixture,
} from '../../jobs/__tests__/host-fixture.js';
import { agent, git, jobs, logs, parse, type Report, states } from './prove-fixture.js';

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

const NOTHING_CARRIED = {
  build: 'outstanding',
  'lane:themes': 'outstanding',
  check: 'outstanding',
};

describe('documents on top of an unpublished complete gate', () => {
  it('carry from the nearest complete ancestor, and from nothing else', async () => {
    const { f, worktree } = await hostAgent();
    const plan = async (): Promise<Report> =>
      parse(await f.cli(worktree, ['prove', 'plan', '--tier', 'gate', '--json']));
    const task = commit(worktree, 'task');
    git(worktree, 'branch', 'peer');

    // Part of the gate on the task commit: incomplete evidence carries nothing.
    const part = await f.cli(worktree, ['prove', '--tier', 'gate', '--lane', 'themes', '--json']);
    expect(part.code, said(part) + (await logs(f))).toBe(0);
    await writeAt(worktree, 'docs/findings/findings.json', '{"findings":[]}\n');
    const ledger = commit(worktree, 'ledger');
    const incomplete = await plan();
    expect(states(incomplete)).toEqual(NOTHING_CARRIED);
    expect(incomplete.obligations.every((entry) => entry.carried === undefined)).toBe(true);

    // The task commit finishes its gate unpublished, then the ledger commit carries it.
    git(worktree, 'checkout', '-q', '--detach', task);
    const rest = await f.cli(worktree, ['prove', '--tier', 'gate', '--json']);
    expect(rest.code, said(rest) + (await logs(f))).toBe(0);
    git(worktree, 'checkout', '-q', 'task');
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(ledger);
    const carried = await plan();
    expect(states(carried)).toEqual({
      build: 'passed',
      'lane:themes': 'passed',
      check: 'outstanding',
    });
    expect(carriedFrom(carried, 'build')).toBe(task);
    expect(carriedFrom(carried, 'lane:themes')).toBe(task);
    expect(carriedFrom(carried, 'check')).toBeUndefined();
    const before = (await jobs(f)).length;
    const run = await f.cli(worktree, ['prove', '--tier', 'gate', '--json']);
    expect(run.code, said(run) + (await logs(f))).toBe(0);
    const all = await jobs(f);
    expect(all).toHaveLength(before + 1);
    expect(all.at(-1)?.request.steps.map((step) => step.command)).toEqual(['check']);
    const status = await f.cli(worktree, ['prove', 'status', '--tier', 'gate', '--complete']);
    expect(status.code, said(status)).toBe(0);
    expect(status.stdout).toContain(`carried-from=${task.slice(0, 12)}`);

    // Two documents commits back: the ledger commit ran only a check, so the task commit carries.
    await writeAt(worktree, 'FRICTIONS.md', '- one more\n');
    const second = commit(worktree, 'second ledger');
    const twoBack = await plan();
    expect(states(twoBack)).toEqual({
      build: 'passed',
      'lane:themes': 'passed',
      check: 'outstanding',
    });
    expect(carriedFrom(twoBack, 'lane:themes')).toBe(task);

    // A source change between them carries nothing.
    await writeFile(
      join(worktree, 'src/browser/themes/shared/tabs.css'),
      lintClean(':root { --tab-radius: 8px; }\n')
    );
    commit(worktree, 'a style');
    const styled = await plan();
    expect(states(styled)).toEqual(NOTHING_CARRIED);
    expect(styled.obligations.every((entry) => entry.carried === undefined)).toBe(true);
    git(worktree, 'reset', '-q', '--hard', second);

    // The same tree and a document on a branch the task commit is not on carries nothing.
    git(worktree, 'checkout', '-q', 'peer');
    git(worktree, 'reset', '-q', '--hard', `${task}~1`);
    git(worktree, 'checkout', task, '--', '.');
    await writeAt(worktree, 'docs/side.md', 'side\n');
    commit(worktree, 'side');
    const side = await plan();
    expect(states(side)).toEqual(NOTHING_CARRIED);
    expect(side.obligations.every((entry) => entry.carried === undefined)).toBe(true);
    git(worktree, 'checkout', '-q', 'task');

    // Publishing the ledger commit records the carry and moves the ref straight to it.
    const published = await f.cli(worktree, ['prove', 'publish', '--commit', ledger]);
    expect(published.code, said(published)).toBe(0);
    expect(published.stdout).toContain(`carried-from=${task.slice(0, 12)}`);
    expect(git(worktree, 'rev-parse', 'refs/fireforge/verified')).toBe(ledger);
    const record = JSON.parse(
      git(worktree, 'cat-file', 'blob', `refs/fireforge/verified-carries/${ledger}`)
    ) as { commit: string; from: string; carried: string[] };
    expect(record).toMatchObject({ commit: ledger, from: task });
    expect(record.carried.sort()).toEqual(['build', 'lane:themes']);
  }, 900_000);
});

const hostAgent = (): ReturnType<typeof agent> => agent(fixtures, OPTIONS);
