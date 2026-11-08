// SPDX-License-Identifier: EUPL-1.2
/** What the real-process proof flows share: a host, an agent's worktree, and reading the report back. */
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect } from 'vitest';

import { writeAt } from '../../authored/__tests__/fixtures.js';
import {
  type CliResult,
  type HostFixture,
  hostFixture,
  lintClean,
} from '../../jobs/__tests__/host-fixture.js';
import type { JobRecord } from '../../jobs/schema.js';
import { readJournal } from '../../jobs/store.js';

export interface Report {
  verdict: string;
  complete: boolean;
  obligations: Array<{
    id: string;
    state: string;
    reds: number;
    job?: string;
    detail?: string;
    output?: string;
    /** The verified commit whose evidence met it, when it was carried. */
    carried?: string;
    decision?: { kind: string; evidence?: Array<{ obligation: string; job: string }> };
  }>;
  plan: {
    id: string;
    source: string;
    base: { label: string; narrowed: boolean; tree: string; commit: string };
    notes: string[];
    removedTests: Array<{ path: string; from: string[] }>;
  };
}

export const TEST = 'browser/themes/test/browser_tabs.js';

export function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-C', cwd, '-c', 'user.email=f@example.invalid', '-c', 'user.name=f', ...args],
    { encoding: 'utf8' }
  ).trim();
}

export const parse = (result: CliResult): Report => JSON.parse(result.stdout.trim()) as Report;
export const states = (report: Report): Record<string, string> =>
  Object.fromEntries(report.obligations.map((entry) => [entry.id, entry.state]));

/** Every job the agent caused, oldest first, without the host's own qualification. */
export async function jobs(f: HostFixture): Promise<JobRecord[]> {
  return [...(await readJournal(f.namespace)).values()]
    .filter((job) => job.request.steps[0]?.command !== 'qualify-native')
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
}

/** A host with slots, and an agent's linked worktree on a branch with one CSS edit and one test. */
export async function agent(
  fixtures: HostFixture[],
  options: Parameters<typeof hostFixture>[0] = {},
  slots = 1
): Promise<{ f: HostFixture; worktree: string; marker: string }> {
  const f = await hostFixture(options);
  fixtures.push(f);
  const worktree = join(f.directory, 'worktree');
  git(f.project, 'worktree', 'add', '-q', '-b', 'task', worktree);
  const init = await f.cli(worktree, [
    'host',
    'init',
    '--slots',
    String(slots),
    '--from-engine',
    f.donor,
  ]);
  expect(init.code, init.stdout + init.stderr).toBe(0);
  const override = await f.cli(worktree, [
    'authored',
    'override',
    'browser/themes/shared/tabs.css',
  ]);
  expect(override.code, override.stdout + override.stderr).toBe(0);
  await writeFile(
    join(worktree, 'src/browser/themes/shared/tabs.css'),
    lintClean(':root { --tab-radius: 6px; }\n')
  );
  const marker = join(f.directory, 'red-marker');
  await writeAt(
    worktree,
    `src/${TEST}`,
    lintClean(`// fake-mach-red-while ${marker}\nadd_task(() => ok(true, 'tabs'));\n`)
  );
  return { f, worktree, marker };
}

export const logs = async (f: HostFixture): Promise<string> => {
  const last = (await jobs(f)).at(-1);
  if (last === undefined) return '';
  return `${last.state} ${last.reason ?? ''}\n${(
    await readFile(join(f.namespace, 'logs', `${last.id}.log`), 'utf8').catch(() => '')
  ).slice(-1500)}`;
};
