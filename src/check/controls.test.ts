// SPDX-License-Identifier: EUPL-1.2
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadProject, type Project } from '../project/index.js';
import {
  type ControlOutcome,
  type ControlResult,
  readControlRuns,
  recordControlRun,
} from '../test/index.js';
import { makeEngineProject } from '../testing/engine.js';
import { commitAll, git, initRepo } from '../testing/git.js';
import { useTempDir, writeTree } from '../testing/temp.js';
import { lightChange, owedControls } from './controls.js';

const dir = useTempDir();

const CONTROL_A = {
  id: 'a',
  diff: 'controls/a.diff',
  test: 'browser/a.js',
  assertions: ['A holds'],
};
const CONTROL_B = {
  id: 'b',
  diff: 'controls/b.diff',
  test: 'browser/b.js',
  assertions: ['B holds'],
};

interface Fixture {
  root: string;
  /** The project as the working tree now declares it. */
  project: () => Promise<Project>;
  /** Rewrites `fireforge.json` with `gate` merged over what it has. */
  declare: (gate: Record<string, unknown>) => Promise<void>;
}

/** A committed patch-mode project declaring two controls and `docs/**` as documents. */
async function fixture(gate: Record<string, unknown> = {}): Promise<Fixture> {
  const made = await makeEngineProject(dir(), {
    config: {
      gate: { documents: ['docs/**'], controls: [CONTROL_A, CONTROL_B], ...gate },
    },
    files: {
      '.gitignore': 'engine/\n.fireforge/\n',
      'controls/a.diff': 'diff a\n',
      'controls/b.diff': 'diff b\n',
      'docs/guide.txt': 'words\n',
      'tools/script.mjs': 'export {};\n',
    },
  });
  await initRepo(made.root);
  const env = { FIREFORGE_HOME: join(dir(), 'home') };
  return {
    root: made.root,
    project: () => loadProject(made.root, env),
    async declare(next) {
      const raw = JSON.parse(await readFile(join(made.root, 'fireforge.json'), 'utf8')) as {
        gate: Record<string, unknown>;
      };
      await writeTree(made.root, {
        'fireforge.json': JSON.stringify({ ...raw, gate: { ...raw.gate, ...next } }),
      });
    },
  };
}

const head = async (root: string): Promise<{ commit: string; tree: string }> => ({
  commit: (await git(root, ['rev-parse', 'HEAD'])).trim(),
  tree: (await git(root, ['rev-parse', 'HEAD^{tree}'])).trim(),
});

const result = (outcome: ControlOutcome, extra: Partial<ControlResult> = {}): ControlResult => ({
  outcome,
  targets: ['x'],
  engine: 'engine-tree',
  red: [],
  unexpected: [],
  ...extra,
});

async function ran(
  f: Fixture,
  control: typeof CONTROL_A,
  outcome: ControlOutcome,
  extra: Partial<ControlResult> = {}
): Promise<void> {
  await recordControlRun(await f.project(), {
    source: 'gate',
    id: control.id,
    diff: control.diff,
    tests: [control.test],
    expect: control.assertions,
    result: result(outcome, extra),
  });
}

describe('lightChange', () => {
  it('carries the proof over documents and over nothing at all', async () => {
    const f = await fixture();
    const first = await head(f.root);
    expect(await lightChange(await f.project(), first.commit, first.commit)).toEqual({
      rerun: [],
      documentsOnly: true,
    });
    await writeTree(f.root, { 'docs/guide.txt': 'more words\n' });
    const second = await commitAll(f.root, 'docs');
    expect(await lightChange(await f.project(), first.commit, second)).toEqual({
      rerun: [],
      documentsOnly: true,
    });
  });

  it('reruns the control whose diff changed and nothing else', async () => {
    const f = await fixture();
    const first = await head(f.root);
    await writeTree(f.root, { 'controls/a.diff': 'diff a, edited\n', 'docs/guide.txt': 'x\n' });
    const second = await commitAll(f.root, 'edit a control');
    expect(await lightChange(await f.project(), first.commit, second)).toEqual({
      rerun: ['a'],
      documentsOnly: false,
    });
  });

  it('reruns an added control and a control whose declaration changed, and accepts a removed one', async () => {
    const f = await fixture();
    const first = await head(f.root);
    const added = { id: 'c', diff: 'controls/c.diff', test: 'browser/c.js', assertions: ['C'] };
    await writeTree(f.root, { 'controls/c.diff': 'diff c\n' });
    await f.declare({
      controls: [CONTROL_A, { ...CONTROL_B, assertions: ['B holds, differently'] }, added],
    });
    const second = await commitAll(f.root, 'declare');
    expect(await lightChange(await f.project(), first.commit, second)).toEqual({
      rerun: ['b', 'c'],
      documentsOnly: false,
    });

    await f.declare({ controls: [CONTROL_A] });
    await git(f.root, ['rm', '-q', 'controls/b.diff', 'controls/c.diff']);
    const third = await commitAll(f.root, 'drop two');
    expect(await lightChange(await f.project(), second, third)).toEqual({
      rerun: [],
      documentsOnly: false,
    });
  });

  it('refuses anything else: product files, other configuration, diffs the build reads', async () => {
    const f = await fixture();
    const first = await head(f.root);
    await writeTree(f.root, { 'tools/script.mjs': 'export const x = 1;\n' });
    const product = await commitAll(f.root, 'product');
    expect(await lightChange(await f.project(), first.commit, product)).toBeUndefined();

    await git(f.root, ['reset', '-q', '--hard', first.commit]);
    await f.declare({ build: 'full' });
    const configured = await commitAll(f.root, 'build full');
    expect(await lightChange(await f.project(), first.commit, configured)).toBeUndefined();

    await git(f.root, ['reset', '-q', '--hard', first.commit]);
    await f.declare({
      controls: [{ ...CONTROL_A, diff: 'components/a.diff' }, CONTROL_B],
    });
    await writeTree(f.root, { 'components/a.diff': 'diff a\n' });
    const inComponents = await commitAll(f.root, 'diff among the components');
    expect(await lightChange(await f.project(), first.commit, inComponents)).toBeUndefined();

    await git(f.root, ['reset', '-q', '--hard', first.commit]);
    await f.declare({
      lanes: [
        {
          id: 'l',
          files: ['browser/a.js'],
          validate: { command: ['node', 'controls//a.diff'] },
        },
      ],
    });
    const declared = await commitAll(f.root, 'a lane reads the diff');
    await writeTree(f.root, { 'controls/a.diff': 'diff a, edited\n' });
    const edited = await commitAll(f.root, 'the diff a lane reads changes');
    expect(await lightChange(await f.project(), declared, edited)).toBeUndefined();
  });
});

describe('owedControls', () => {
  it('names a control that never ran, and one that was caught on this tree is not owed', async () => {
    const f = await fixture();
    const now = await head(f.root);
    expect(await owedControls(await f.project(), now)).toMatchObject([
      { id: 'a', reason: 'never-run' },
      { id: 'b', reason: 'never-run' },
    ]);
    await ran(f, CONTROL_A, 'caught');
    await ran(f, CONTROL_B, 'caught');
    expect(await owedControls(await f.project(), now)).toEqual([]);
    const [run] = await readControlRuns(await f.project());
    expect(run).toMatchObject({
      id: 'a',
      source: 'gate',
      diff: { path: 'controls/a.diff' },
      tests: ['browser/a.js'],
      expect: ['A holds'],
      against: { commit: now.commit, tree: now.tree, engine: 'engine-tree' },
      outcome: 'caught',
    });
    expect(run?.diff.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reads the last run: green is missed, red beyond the expectation is wrong-red', async () => {
    const f = await fixture();
    const now = await head(f.root);
    await ran(f, CONTROL_A, 'missed');
    await ran(f, CONTROL_B, 'wrong-red', {
      red: ['B holds', 'C breaks'],
      unexpected: ['C breaks'],
    });
    expect(await owedControls(await f.project(), now)).toMatchObject([
      { id: 'a', reason: 'missed' },
      { id: 'b', reason: 'wrong-red', detail: expect.stringContaining('"C breaks"') as string },
    ]);
    await ran(f, CONTROL_A, 'caught');
    await ran(f, CONTROL_B, 'baseline-red');
    expect(await owedControls(await f.project(), now)).toMatchObject([
      { id: 'b', reason: 'not-caught' },
    ]);
  });

  it('owes a control whose diff or declaration changed since it last ran', async () => {
    const f = await fixture();
    await ran(f, CONTROL_A, 'caught');
    await ran(f, CONTROL_B, 'caught');
    await writeTree(f.root, { 'controls/a.diff': 'diff a, edited\n' });
    await f.declare({ controls: [CONTROL_A, { ...CONTROL_B, assertions: ['B differently'] }] });
    const now = await commitAll(f.root, 'edit');
    expect(
      await owedControls(await f.project(), {
        tree: (await git(f.root, ['rev-parse', `${now}^{tree}`])).trim(),
      })
    ).toMatchObject([
      { id: 'a', reason: 'changed', detail: expect.stringContaining('diff') as string },
      { id: 'b', reason: 'changed', detail: expect.stringContaining('declaration') as string },
    ]);
  });

  it('owes every control for a changed tree, but not for documents or for another control', async () => {
    const f = await fixture();
    await ran(f, CONTROL_A, 'caught');
    await ran(f, CONTROL_B, 'caught');
    await writeTree(f.root, { 'docs/guide.txt': 'more\n' });
    await commitAll(f.root, 'docs');
    expect(await owedControls(await f.project(), await head(f.root))).toEqual([]);

    await writeTree(f.root, { 'controls/b.diff': 'diff b, edited\n' });
    await commitAll(f.root, 'edit b');
    expect(await owedControls(await f.project(), await head(f.root))).toMatchObject([
      { id: 'b', reason: 'changed' },
    ]);

    await writeTree(f.root, { 'tools/script.mjs': 'export const x = 1;\n' });
    await commitAll(f.root, 'product');
    expect(await owedControls(await f.project(), await head(f.root))).toMatchObject([
      { id: 'a', reason: 'tree-changed' },
      { id: 'b', reason: 'changed' },
    ]);
    // Without a clean tree there is nothing to compare.
    expect(await owedControls(await f.project())).toMatchObject([{ id: 'b', reason: 'changed' }]);
  });

  it('counts an ad hoc run of exactly the declared diff, tests and labels', async () => {
    const f = await fixture();
    await recordControlRun(await f.project(), {
      source: 'test',
      diff: join(f.root, 'controls/a.diff'),
      tests: ['browser/a.js'],
      expect: ['A holds'],
      result: result('caught'),
    });
    await recordControlRun(await f.project(), {
      source: 'test',
      diff: join(f.root, 'controls/b.diff'),
      tests: ['browser/b.js'],
      expect: ['something else'],
      result: result('caught'),
    });
    expect(await owedControls(await f.project(), await head(f.root))).toMatchObject([
      { id: 'b', reason: 'never-run' },
    ]);
  });

  it('keeps the record bounded and carries on when it cannot be read', async () => {
    const f = await fixture();
    for (let index = 0; index < 5; index += 1) await ran(f, CONTROL_A, 'caught');
    expect((await readControlRuns(await f.project())).length).toBe(3);
    await writeTree(f.root, { '.fireforge/gate/controls.json': '{ not json' });
    expect(await readControlRuns(await f.project())).toEqual([]);
    await ran(f, CONTROL_A, 'caught');
    expect(await readControlRuns(await f.project())).toHaveLength(1);
  });
});
