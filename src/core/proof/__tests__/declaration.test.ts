// SPDX-License-Identifier: EUPL-1.2
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { ProofConfig } from '../../../types/config.js';
import { answeredDeclaration, declarationChange, effectiveProof } from '../declaration.js';

const none = { tests: ['a/browser_a.js', 'a/browser_b.js'], deleted: new Set<string>() };

describe('the declaration a candidate answers to', () => {
  it('keeps a lane the candidate removed, and says so', () => {
    const base: ProofConfig = { gate: { lanes: [{ id: 'l', files: ['a/browser_*.js'] }] } };
    const { proof, notes } = effectiveProof(base, {}, none);
    expect(proof.gate?.lanes?.map((lane) => lane.id)).toEqual(['l']);
    expect(notes.join()).toContain('Lane l is gone from the candidate, and still applies');
  });

  it('takes the wider of a lane in both: files, excludes and scope', () => {
    const base: ProofConfig = {
      gate: {
        lanes: [
          { id: 'l', files: ['a/browser_a.js'], exclude: ['x'], owns: ['a/**'], quiet: true },
        ],
      },
    };
    const candidate: ProofConfig = {
      gate: {
        lanes: [
          { id: 'l', files: ['a/browser_b.js'], exclude: ['x', 'a/browser_a.js'], owns: ['b/**'] },
        ],
      },
    };
    const [lane] = effectiveProof(base, candidate, none).proof.gate?.lanes ?? [];
    expect(lane?.files).toEqual(['a/browser_b.js', 'a/browser_a.js']);
    expect(lane?.exclude).toEqual(['x']);
    expect(lane?.owns).toEqual(['a/**', 'b/**']);
    expect(lane?.quiet).toBe(true);
    // A lane with no scope applies to every change, so a candidate cannot scope it down.
    const unscoped = effectiveProof(
      { gate: { lanes: [{ id: 'l', files: ['a/browser_a.js'] }] } },
      candidate,
      none
    ).proof.gate?.lanes?.[0];
    expect(unscoped?.owns).toBeUndefined();
  });

  it('keeps the larger repeat and the stronger build, control and acceptance', () => {
    const base: ProofConfig = {
      gate: {
        build: 'full',
        check: { quiet: true },
        stress: [{ id: 's', files: ['a/browser_a.js'], repeat: 10, context: ['a/browser_b.js'] }],
        controls: [
          { id: 'c', diff: 'c.diff', test: 'a/browser_a.js', assertions: ['x'], always: true },
        ],
        runs: [{ id: 'r', args: ['--headless'] }],
        acceptance: [{ id: 'p', reason: 'r', evidence: ['run:r'] }],
      },
    };
    const candidate: ProofConfig = {
      gate: {
        build: 'ui',
        stress: [{ id: 's', files: ['a/browser_a.js'], repeat: 1 }],
        controls: [{ id: 'c', diff: 'c.diff', test: 'a/browser_a.js', assertions: ['x'] }],
        acceptance: [{ id: 'p', reason: 'r' }],
      },
    };
    const { gate } = effectiveProof(base, candidate, none).proof;
    expect(gate?.build).toBe('full');
    expect(gate?.check?.quiet).toBe(true);
    expect(gate?.stress?.[0]?.repeat).toBe(10);
    expect(gate?.stress?.[0]?.context).toEqual(['a/browser_b.js']);
    expect(gate?.controls?.[0]?.always).toBe(true);
    expect(gate?.runs?.map((run) => run.id)).toEqual(['r']);
    expect(gate?.acceptance?.[0]?.evidence).toEqual(['run:r']);
  });

  it('keeps a validator the candidate dropped, and lets a recipe change but not vanish', () => {
    const validate = { command: ['node', 'tools/v.mjs'] };
    const base: ProofConfig = {
      gate: { mode: 'release', lanes: [{ id: 'l', files: ['a/browser_a.js'], validate }] },
    };
    const candidate: ProofConfig = { gate: { lanes: [{ id: 'l', files: ['a/browser_a.js'] }] } };
    const { gate } = effectiveProof(base, candidate, none).proof;
    expect(gate?.lanes?.[0]?.validate).toEqual(validate);
    expect(gate?.mode).toBe('release');
    // A run's validator stays the same way.
    const smoke = { id: 's', args: ['--headless'] };
    const kept = effectiveProof(
      { gate: { runs: [{ ...smoke, validate }] } },
      { gate: { runs: [smoke] } },
      none
    ).proof.gate?.runs?.[0];
    expect(kept?.validate).toEqual(validate);
  });

  it('counts a route as having no effect only when both say so', () => {
    const { proof } = effectiveProof(
      { noneRoutes: ['tools/**', 'scripts/**'] },
      { noneRoutes: ['tools/**', 'browser/**'] },
      none
    );
    expect(proof.noneRoutes).toEqual(['tools/**']);
    expect(effectiveProof({}, { noneRoutes: ['tools/**'] }, none).proof.noneRoutes).toBeUndefined();
    expect(effectiveProof({ noneRoutes: ['tools/**'] }, {}, none).proof.noneRoutes).toBeUndefined();
  });

  it('lets go of what is gone with its tests, which the plan discloses', () => {
    const base: ProofConfig = {
      gate: {
        lanes: [
          { id: 'gone', files: ['b/browser_*.js'] },
          { id: 'literal', files: ['a/browser_c.js'] },
          { id: 'kept', files: ['a/browser_c.js', 'a/browser_a.js'] },
        ],
        controls: [{ id: 'c', diff: 'c.diff', test: 'a/browser_c.js', assertions: ['x'] }],
      },
    };
    const files = { ...none, deleted: new Set(['a/browser_c.js']) };
    const { proof, notes } = effectiveProof(base, {}, files);
    expect(proof.gate?.lanes?.map((lane) => [lane.id, lane.files])).toEqual([
      ['kept', ['a/browser_a.js']],
    ]);
    expect(proof.gate?.controls).toEqual([]);
    expect(notes.join()).toContain('Lane gone is gone from the candidate with everything it ran');
  });

  it('notices a change to what decides a gate, in either section', () => {
    expect(
      declarationChange({ proof: { consumerLimit: 3 } }, { proof: { consumerLimit: 3 } })
    ).toEqual([]);
    expect(declarationChange({ proof: {} }, { proof: { mainBranch: 'x' } })).toEqual(['proof']);
    expect(declarationChange({ check: { skip: [] } }, { check: { skip: ['lint'] } })).toEqual([
      'check',
    ]);
    expect(
      declarationChange({ patchLint: { prettier: 'error' } }, { patchLint: { prettier: 'off' } })
    ).toEqual(['patchLint']);
    expect(declarationChange({}, { patchPolicy: { allowGaps: true } })).toEqual(['patchPolicy']);
    expect(declarationChange({ unreadable: 'bad json' }, {})[0]).toContain('bad json');
  });
});

describe('the files a gate is judged by', () => {
  const directories: string[] = [];
  afterAll(async () => {
    await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
  });

  const git = (root: string, ...args: string[]): string =>
    execFileSync(
      'git',
      ['-C', root, '-c', 'user.email=f@example.invalid', '-c', 'user.name=f', ...args],
      { encoding: 'utf8' }
    ).trim();

  /** Commits a base, applies a candidate's edit on top, and reports what the candidate has to answer for. */
  async function changes(
    config: Record<string, unknown>,
    files: Record<string, string>,
    edit: Record<string, string | null>
  ): Promise<string[]> {
    const root = await mkdtemp(join(tmpdir(), 'fireforge-judges-'));
    directories.push(root);
    git(root, 'init', '-q');
    const put = async (path: string, text: string): Promise<void> => {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    };
    await put('fireforge.json', JSON.stringify(config));
    for (const [path, text] of Object.entries(files)) await put(path, text);
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'base');
    const history = git(root, 'rev-parse', 'HEAD');
    for (const [path, text] of Object.entries(edit))
      if (text === null) await rm(join(root, path));
      else await put(path, text);
    git(root, 'add', '-A');
    const tree = git(root, 'write-tree');
    return (await answeredDeclaration(root, history, tree, undefined, none)).changes;
  }

  const validated = (validate: string[]): Record<string, unknown> => ({
    proof: {
      gate: { lanes: [{ id: 'l', files: ['a/browser_a.js'], validate: { command: validate } }] },
    },
  });
  const VALIDATOR = { 'tools/count.mjs': 'process.exit(3);\n' };
  const COUNT = 'the file tools/count.mjs, which judges it';

  it('counts a validator script edited or deleted, and nothing when it is untouched', async () => {
    const config = validated(['node', 'tools/count.mjs', '{artifacts}']);
    expect(await changes(config, VALIDATOR, { 'tools/count.mjs': 'process.exit(0);\n' })).toEqual([
      COUNT,
    ]);
    expect(await changes(config, VALIDATOR, { 'tools/count.mjs': null })).toEqual([COUNT]);
    expect(await changes(config, VALIDATOR, { 'src/other.js': '1;\n' })).toEqual([]);
  });

  it('counts a run validator script edited', async () => {
    const config = {
      proof: {
        gate: {
          runs: [
            { id: 's', args: ['--headless'], validate: { command: ['node', 'tools/count.mjs'] } },
          ],
        },
      },
    };
    expect(await changes(config, VALIDATOR, { 'tools/count.mjs': 'process.exit(0);\n' })).toEqual([
      COUNT,
    ]);
  });

  it('counts a script run by its own path, and one named as a flag value', async () => {
    const config = validated(['./tools/run.sh', '--budget=tools/budget.json']);
    const files = { 'tools/run.sh': '#!/bin/sh\n', 'tools/budget.json': '{}\n' };
    expect(await changes(config, files, { 'tools/run.sh': '#!/bin/sh\nexit 0\n' })).toEqual([
      'the file tools/run.sh, which judges it',
    ]);
    expect(await changes(config, files, { 'tools/budget.json': '{"max":9}\n' })).toEqual([
      'the file tools/budget.json, which judges it',
    ]);
  });

  it('counts a stress validator and a control diff', async () => {
    const stress = {
      proof: {
        gate: {
          stress: [
            {
              id: 's',
              files: ['a/browser_a.js'],
              repeat: 2,
              validate: { command: ['node', 'tools/count.mjs'] },
            },
          ],
        },
      },
    };
    expect(await changes(stress, VALIDATOR, { 'tools/count.mjs': '\n' })).toEqual([COUNT]);
    const control = {
      proof: {
        gate: {
          controls: [
            {
              id: 'c',
              diff: 'tools/controls/c.diff',
              test: 'a/browser_a.js',
              assertions: ['x'],
            },
          ],
        },
      },
    };
    expect(
      await changes(
        control,
        { 'tools/controls/c.diff': 'one\n' },
        { 'tools/controls/c.diff': 'two\n' }
      )
    ).toEqual(['the file tools/controls/c.diff, which judges it']);
  });

  it('counts a file an extra check step names, against its working directory', async () => {
    const step = (command: string, cwd?: string): Record<string, unknown> => ({
      check: { extraSteps: [{ name: 'audit', command, ...(cwd === undefined ? {} : { cwd }) }] },
    });
    const audit = { 'tools/audit.mjs': '1;\n' };
    expect(
      await changes(step('FOO=1 node "tools/audit.mjs" | tee out.txt'), audit, {
        'tools/audit.mjs': '2;\n',
      })
    ).toEqual(['the file tools/audit.mjs, which judges it']);
    expect(
      await changes(step('node audit.mjs', 'tools'), audit, { 'tools/audit.mjs': '2;\n' })
    ).toEqual(['the file tools/audit.mjs, which judges it']);
  });

  it('reads no directory or plain word as a file, so an ordinary edit raises nothing', async () => {
    const config = {
      check: { extraSteps: [{ name: 'lint', command: 'eslint src . --max-warnings 0' }] },
    };
    expect(await changes(config, { 'src/a.js': '1;\n' }, { 'src/a.js': '2;\n' })).toEqual([]);
  });

  it('counts the sections as well, and a file named only by the candidate', async () => {
    const before = { patchLint: { prettier: 'error' } };
    expect(
      await changes(before, {}, { 'fireforge.json': JSON.stringify({ patchLint: {} }) })
    ).toEqual(['patchLint']);
    const added = validated(['node', 'tools/new.mjs']);
    expect(
      await changes({}, {}, { 'fireforge.json': JSON.stringify(added), 'tools/new.mjs': '1;\n' })
    ).toEqual(['proof', 'the file tools/new.mjs, which judges it']);
  });
});
