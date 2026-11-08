// SPDX-License-Identifier: EUPL-1.2
/** Which ancestor a documents-only gate asks for complete evidence, in process. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { FireForgeConfig } from '../../../types/config.js';
import { commitFixture, writeAt } from '../../authored/__tests__/fixtures.js';
import { digest, sourceGit } from '../../authored/git.js';
import { snapshotIdentityOfTree } from '../../authored/provider.js';
import type { AuthoredSnapshot } from '../../authored/types.js';
import { type CleanGateProbe, planCapturedSource } from '../snapshot.js';

const SOURCE = 'browser/base/content/thing.js';

const directories: string[] = [];
afterAll(async () => {
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

const CONFIG: FireForgeConfig = {
  name: 'Fixture',
  vendor: 'Example',
  binaryName: 'fixture',
  appId: 'invalid.example.fixture',
  firefox: { version: '153.6.0esr', product: 'firefox-esr', sha256: 'a'.repeat(64) },
  sources: {
    schemaVersion: 1,
    mode: 'authored',
    root: 'src',
    metadataRoot: '.fireforge-sources',
    pristineCommit: '1'.repeat(40),
  },
  proof: { gate: { lanes: [{ id: 'smoke', files: ['browser/base/test/browser_smoke.js'] }] } },
};

const git = async (root: string, ...args: string[]): Promise<string> =>
  (await sourceGit(root, args)).toString('utf8').trim();

/** A main branch, and a task branch with one source change: the commit whose gate ran. */
async function history(): Promise<{ root: string; main: string; task: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'fireforge-proof-carry-walk-'));
  directories.push(directory);
  const root = join(directory, 'project');
  await sourceGit(directory, ['init', '-q', '-b', 'main', root]);
  await writeAt(root, 'fireforge.json', JSON.stringify(CONFIG));
  await writeAt(root, `src/${SOURCE}`, 'export const thing = 1;\n');
  await commitFixture(root);
  const main = await git(root, 'rev-parse', 'HEAD');
  await sourceGit(root, ['checkout', '-q', '-b', 'task']);
  await writeAt(root, `src/${SOURCE}`, 'export const thing = 2;\n');
  await commitFixture(root);
  return { root, main, task: await git(root, 'rev-parse', 'HEAD') };
}

async function commitWith(root: string, path: string, content: string): Promise<string> {
  await writeAt(root, path, content);
  await commitFixture(root);
  return git(root, 'rev-parse', 'HEAD');
}

/** The checked-out commit, captured the way a gate reads it. */
async function capture(root: string): Promise<AuthoredSnapshot> {
  const tree = await git(root, 'rev-parse', 'HEAD^{tree}');
  const listed = (await git(root, 'ls-tree', '-r', '--format=%(objectname) %(path)', 'HEAD'))
    .split('\n')
    .map((line) => {
      const [blob = '', path = ''] = line.split(' ');
      return { path, blob, mode: '100644' as const };
    });
  return {
    schemaVersion: 1,
    id: digest({ tree }),
    repository: root,
    tree,
    objectFormat: 'sha1',
    pin: { firefox: CONFIG.firefox, commit: '1'.repeat(40), digest: 'd'.repeat(64) },
    config: CONFIG,
    inputs: listed.filter(({ path }) => !path.startsWith('src/')),
    files: listed
      .filter(({ path }) => path.startsWith('src/'))
      .map(({ path, blob, mode }) => ({ path: path.slice(4), kind: 'created', blob, mode })),
  };
}

/** A probe that answers yes for these commits, and records what it was asked. */
function probe(complete: readonly string[]): { asked: string[]; cleanGate: CleanGateProbe } {
  const asked: string[] = [];
  return {
    asked,
    cleanGate: (commit) => {
      asked.push(commit);
      return Promise.resolve(complete.includes(commit));
    },
  };
}

const gate = async (
  root: string,
  cleanGate: CleanGateProbe,
  base?: string
): ReturnType<typeof planCapturedSource> =>
  planCapturedSource({
    root,
    snapshot: await capture(root),
    tier: 'gate',
    cleanGate,
    ...(base === undefined ? {} : { base }),
  });

describe.concurrent('a documents-only gate with no verified base', () => {
  it('carries from the nearest ancestor whose own gate is complete, two documents commits back', async () => {
    const { root, task } = await history();
    const first = await commitWith(root, 'docs/findings.json', '{}\n');
    await commitWith(root, 'FRICTIONS.md', '- one\n');
    const { asked, cleanGate } = probe([task]);
    const plan = await gate(root, cleanGate);
    expect(asked).toEqual([first, task]);
    const tree = await git(root, 'rev-parse', `${task}^{tree}`);
    expect(plan.carry).toEqual({
      commit: task,
      tree,
      source: snapshotIdentityOfTree(await capture(root), tree),
    });
    expect(plan.obligations.filter((entry) => entry.carried === true).map(({ id }) => id)).toEqual(
      expect.arrayContaining(['build', 'lane:smoke'])
    );
    expect(plan.obligations.find(({ id }) => id === 'check')?.carried).toBeUndefined();
  });

  it('carries nothing when no ancestor is complete, and never asks past a source change', async () => {
    const { root, task } = await history();
    await commitWith(root, 'docs/findings.json', '{}\n');
    const { asked, cleanGate } = probe([]);
    const plan = await gate(root, cleanGate);
    expect(asked).toEqual([task]);
    expect(plan.carry).toBeUndefined();
  });

  it('asks nothing when the candidate changes source since its parent', async () => {
    const { root, task } = await history();
    await commitWith(root, 'docs/findings.json', '{}\n');
    await commitWith(root, `src/${SOURCE}`, 'export const thing = 3;\n');
    const { asked, cleanGate } = probe([task]);
    const plan = await gate(root, cleanGate);
    expect(asked).toEqual([]);
    expect(plan.carry).toBeUndefined();
    expect(plan.obligations.some((entry) => entry.carried === true)).toBe(false);
  });

  it('asks nothing with a named base', async () => {
    const { root, task } = await history();
    await commitWith(root, 'docs/findings.json', '{}\n');
    const { asked, cleanGate } = probe([task]);
    const plan = await gate(root, cleanGate, task);
    expect(asked).toEqual([]);
    expect(plan.carry).toBeUndefined();
  });

  it('never walks a side branch, even to the same tree', async () => {
    const { root, main, task } = await history();
    await sourceGit(root, ['checkout', '-q', '-b', 'side', main]);
    await sourceGit(root, ['checkout', task, '--', '.']);
    await commitWith(root, 'docs/side.md', 'side\n');
    const { asked, cleanGate } = probe([task, main]);
    const plan = await gate(root, cleanGate);
    expect(asked).toEqual([]);
    expect(plan.carry).toBeUndefined();
  });
});
