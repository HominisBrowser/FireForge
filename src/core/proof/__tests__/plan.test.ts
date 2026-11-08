// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import type { ProofConfig } from '../../../types/config.js';
import { createProofPlan, type PlanInput, stepFingerprint } from '../plan.js';
import { rootRoute, runtimeRoute } from '../route.js';
import { declaredInputs } from '../snapshot.js';
import type { ChangedPath, Obligation, ProofPlan } from '../types.js';

/** A real project's inventory, by directory: 717 tests in 12 directories. */
const INVENTORY: ReadonlyArray<readonly [string, number]> = [
  ['browser/base/content/test/hominis-tiles', 485],
  ['browser/modules/hominis/test/unit', 167],
  ['browser/base/content/test/hominis-webext', 38],
  ['browser/base/content/test/hominis', 19],
  ['browser/base/content/test/about', 1],
  ['browser/base/content/test/contextMenu', 1],
  ['browser/base/content/test/static', 1],
  ['browser/base/content/test/sync', 1],
  ['browser/components/aboutwelcome/tests/browser', 1],
  ['browser/components/preferences/tests/home', 1],
  ['devtools/client/aboutdebugging/test/browser', 1],
  ['devtools/client/responsive/test/browser', 1],
];
const tests = INVENTORY.flatMap(([directory, count]) =>
  Array.from({ length: count }, (_, index) => ({
    path: `${directory}/browser_${String(index)}.js`,
    content: '// A test of something else.\n',
  }))
);

function change(path: string, tree: ChangedPath['tree'] = 'engine', deleted = false): ChangedPath {
  return {
    path,
    tree,
    route: tree === 'engine' ? runtimeRoute(path) : rootRoute(path),
    deleted,
  };
}

function plan(overrides: Partial<PlanInput> = {}): ProofPlan {
  return createProofPlan({
    tier: 'task',
    source: 'a'.repeat(64),
    base: {
      commit: 'b'.repeat(40),
      tree: 'c'.repeat(40),
      label: 'merge-base with main',
      narrowed: false,
    },
    compiled: 'd'.repeat(64),
    changed: [],
    tests,
    touched: [],
    named: [],
    controlTargets: {},
    ...overrides,
  });
}

const ids = (obligations: readonly Obligation[]): string[] => obligations.map((entry) => entry.id);
const css = 'browser/themes/shared/hominis-foo.css';

describe('task tier proportionality', () => {
  it('a one-line CSS change against a 717-test inventory is two obligations, needing no binding', () => {
    const result = plan({
      changed: [change(css)],
      touched: [{ path: css, content: '.a { color: red; }\n' }],
    });
    expect(ids(result.obligations)).toEqual(['static', 'build']);
    expect(result.obligations[0]?.step).toEqual({
      command: 'lint',
      args: [css],
    });
    expect(result.obligations[1]?.step).toEqual({ command: 'build', args: ['--ui'] });
    expect(result.notes.join()).toContain('No test runs this change');
  });

  it('never makes a task step quiet, including a test a lane would run', () => {
    const lanes = [
      { id: 'quiet', files: [`${INVENTORY[0]?.[0] ?? ''}/browser_0.js`], quiet: true },
    ];
    const result = plan({
      changed: [change(css)],
      named: [`${INVENTORY[0]?.[0] ?? ''}/browser_0.js`],
      proof: { gate: { lanes } },
    });
    expect(result.obligations.every((entry) => entry.step?.quiet !== true)).toBe(true);
  });

  it('selects direct consumers by whole token, up to the limit', () => {
    const consumer = 'browser/x/test/browser_consumer.js';
    const near = 'browser/x/test/browser_near.js';
    const result = plan({
      changed: [change('browser/x/widget.mjs')],
      touched: [
        { path: 'browser/x/widget.mjs', content: "customElements.define('moz-widget', Widget);\n" },
      ],
      tests: [
        { path: consumer, content: "document.createElement('moz-widget');\n" },
        { path: near, content: "document.createElement('moz-widget-other');\n" },
      ],
    });
    expect(ids(result.obligations)).toEqual(['static', 'build', `test:${consumer}`]);
  });

  it('refuses by name over the consumer limit, and accepts named tests with the rest left visible', () => {
    const many = Array.from({ length: 150 }, (_, index) => ({
      path: `browser/x/test/browser_${String(index)}.js`,
      content: "use('moz-widget');\n",
    }));
    const input = {
      changed: [change('browser/x/widget.mjs')],
      touched: [
        { path: 'browser/x/widget.mjs', content: "customElements.define('moz-widget', Widget);\n" },
      ],
      tests: many,
    };
    expect(() => plan(input)).toThrow(/proof-consumer-limit: 150 tests .* limit of 12/);
    const named = plan({ ...input, named: ['browser/x/test/browser_0.js'] });
    expect(ids(named.obligations)).toEqual(['static', 'build', 'test:browser/x/test/browser_0.js']);
    expect(named.notes.join()).toContain('149 direct consumers');
    expect(
      plan({ ...input, tests: many.slice(0, 20), proof: { consumerLimit: 20 } }).obligations.filter(
        (entry) => entry.kind === 'test'
      )
    ).toHaveLength(20);
    // Raising the limit past what a job can carry still refuses, by that limit's own name.
    expect(() => plan({ ...input, proof: { consumerLimit: 200 } })).toThrow(/proof-step-limit/);
  });

  it('refuses a plan a single job could not carry, naming the limit', () => {
    const many = Array.from(
      { length: 150 },
      (_, index) => `browser/x/test/browser_${String(index)}.js`
    );
    expect(() => plan({ changed: [change(css)], named: many })).toThrow(
      /proof-step-limit: .*a job carries 100/
    );
  });

  it('routes known documents and metadata to no runtime, and everything else conservatively', () => {
    for (const path of [
      'README.md',
      'CHANGELOG.md',
      'package.json',
      'patches/001.patch',
      'docs/a.md',
    ])
      expect(rootRoute(path)).toBe('none');
    expect(runtimeRoute('browser/docs/x.md')).toBe('none');
    expect(rootRoute('tools/scripts/a.mts')).toBe('unknown');
    expect(rootRoute('tools/scripts/a.mts', ['tools/**'])).toBe('none');
    // A project can declare a script inert, never what a build reads.
    expect(rootRoute('configs/common.mozconfig', ['**'])).toBe('compiled');
    expect(rootRoute('fireforge.json', ['**'])).toBe('unknown');
    expect(rootRoute('components/a/b.css', ['**'])).toBe('component');
    const docs = plan({ changed: [change('README.md', 'root')] });
    expect(ids(docs.obligations)).toEqual(['static']);
    expect(docs.obligations[0]?.step?.command).toBe('verify');
  });

  it('asks for a full build where a UI build would refuse', () => {
    for (const path of ['browser/base/jar.mn', 'dom/foo.cpp', 'browser/x.mm']) {
      const result = plan({ changed: [change(path)] });
      expect(result.obligations.find((entry) => entry.kind === 'build')?.step?.args).toEqual([]);
      expect(result.obligations.find((entry) => entry.kind === 'static')?.step?.args).toEqual([]);
    }
  });

  it('accepts a full build as proof of a UI build, never the reverse', () => {
    const fullStep = { command: 'build' as const, args: [] };
    const ui = plan({ changed: [change(css)] }).obligations.find((entry) => entry.kind === 'build');
    expect(ui?.fingerprints).toContain(stepFingerprint(fullStep));
    const full = plan({ changed: [change('dom/foo.cpp')] }).obligations.find(
      (entry) => entry.kind === 'build'
    );
    expect(full?.fingerprints).toEqual([stepFingerprint(fullStep)]);
  });
});

describe('a changed test never disappears', () => {
  it('runs a changed JS test by itself', () => {
    const path = 'browser/x/test/browser_new.js';
    const result = plan({ changed: [change(path)], tests: [{ path, content: '' }] });
    expect(result.obligations.find((entry) => entry.kind === 'test')?.step).toEqual({
      command: 'test',
      args: ['--headless', '--auto-ports', path],
      expected: { files: [path] },
    });
  });

  it.each([
    'browser/x/test/test_new.html',
    'browser/x/test/test_new.xhtml',
    'browser/x/test_new.py',
  ])('refuses %s until something names it', (path) => {
    const changed = [change(path)];
    expect(() => plan({ changed })).toThrow(/proof-unclassified-test/);
    expect(ids(plan({ changed, named: [path] }).obligations)).toContain(`test:${path}`);
    const proof: ProofConfig = { gate: { lanes: [{ id: 'plain', files: [path] }] } };
    expect(ids(plan({ changed, proof }).obligations)).toContain(`test:${path}`);
  });

  it('maps a shared support file to the tests beside it, or refuses', () => {
    const head = 'browser/x/test/head.js';
    const beside = 'browser/x/test/browser_a.js';
    expect(() => plan({ changed: [change(head)], tests: [] })).toThrow(/proof-unclassified-test/);
    expect(
      ids(plan({ changed: [change(head)], tests: [{ path: beside, content: '' }] }).obligations)
    ).toContain(`test:${beside}`);
    // Naming a test beside it answers for it, and the gate's lane does when one covers the directory.
    expect(
      ids(
        plan({
          changed: [change(head)],
          named: [beside],
          tests: [
            { path: beside, content: '' },
            { path: 'browser/x/test/browser_b.js', content: '' },
          ],
        }).obligations
      )
    ).not.toContain('test:browser/x/test/browser_b.js');
  });

  it('refuses a component test no declaration says how to run', () => {
    const changed = [change('components/w/test/browser_w.js', 'root')];
    expect(() => plan({ changed })).toThrow(/proof-unclassified-test/);
    expect(ids(plan({ changed, named: ['browser/w/test/browser_w.js'] }).obligations)).toContain(
      'test:browser/w/test/browser_w.js'
    );
  });

  it('dispatches a changed test the way its lane has to, so a manifest-restricted file can pass', () => {
    const path = 'browser/x/test/browser_scene.js';
    const proof: ProofConfig = {
      gate: { lanes: [{ id: 'scenes', files: [path], dispatch: 'standalone', headed: true }] },
    };
    const result = plan({ changed: [change(path)], tests: [{ path, content: '' }], proof });
    expect(result.obligations.find((entry) => entry.kind === 'test')?.step?.args).toEqual([
      '--auto-ports',
      '--restart-between-tests',
      path,
    ]);
  });

  it('runs a changed test under what its lane declares, so the lane’s evidence is what it needs', () => {
    const path = 'browser/x/test/browser_scene.js';
    const proof: ProofConfig = {
      gate: {
        lanes: [
          {
            id: 'scenes',
            files: [path],
            env: { PROJECT_CAPTURE: '1' },
            uploadDir: true,
            machArgs: ['--setpref=focusmanager.testmode=true'],
            keepAwake: true,
          },
        ],
      },
    };
    const result = plan({ changed: [change(path)], tests: [{ path, content: '' }], proof });
    expect(result.obligations.find((entry) => entry.kind === 'test')?.step).toMatchObject({
      args: ['--headless', '--auto-ports', '--mach-arg=--setpref=focusmanager.testmode=true', path],
      env: { PROJECT_CAPTURE: '1' },
      uploadDir: true,
      keepAwake: true,
    });
  });
});

describe('controls', () => {
  const diff = 'tools/control.diff';
  const control = { diff, test: 'browser/x/test/browser_a.js', assertions: ['guard'] };

  it('requires a declared control to target what changed outside its tests', () => {
    const source = 'browser/x/guard.mjs';
    const test = 'browser/x/test/browser_a.js';
    const changed = [change(source), change(test)];
    const tests_ = [{ path: test, content: '' }];
    expect(() =>
      plan({ changed, tests: tests_, control, controlTargets: { [diff]: [test] } })
    ).toThrow(/proof-control-unrelated/);
    expect(() =>
      plan({ changed, tests: tests_, control, controlTargets: { [diff]: ['browser/y.mjs'] } })
    ).toThrow(/proof-control-unrelated/);
    const result = plan({ changed, tests: tests_, control, controlTargets: { [diff]: [source] } });
    const obligation = result.obligations.find((entry) => entry.kind === 'control');
    expect(obligation?.step).toMatchObject({
      args: ['--headless', '--auto-ports', '--negative-control', diff, test],
      controlAssertions: ['guard'],
      quiet: true,
    });
    expect(result.controlPaths).toEqual([source]);
  });

  it('makes no control obligation a task did not declare', () => {
    expect(ids(plan({ changed: [change(css)] }).obligations)).not.toContain('control');
  });
});

describe('gate tier', () => {
  const directory = INVENTORY[0]?.[0] ?? '';
  const proof: ProofConfig = {
    gate: {
      lanes: [
        { id: 'tiles', files: [`${directory}/browser_*.js`], dispatch: 'one-browser', quiet: true },
        { id: 'unit', files: ['browser/modules/hominis/test/unit/browser_*.js'] },
        {
          id: 'responsive',
          files: ['devtools/client/responsive/test/browser/browser_*.js'],
          owns: ['devtools/**'],
        },
      ],
      stress: [
        {
          id: 'tiles',
          files: [`${directory}/browser_3.js`],
          context: [`${directory}/browser_1.js`, `${directory}/browser_2.js`],
          repeat: 10,
          quiet: true,
        },
      ],
      runs: [{ id: 'smoke', args: ['--smoke-exit', '30'] }],
      acceptance: [{ id: 'scene', reason: 'A person looks.' }],
      check: { quiet: true },
    },
  };

  it('retains lanes by ownership and always the check, with what it left out stated', () => {
    const result = plan({ tier: 'gate', changed: [change(css)], proof });
    // The check reads only captured source, so it comes first: a static red costs no build or lane.
    expect(ids(result.obligations)).toEqual([
      'check',
      'build',
      'lane:tiles',
      'lane:unit',
      'stress:tiles',
      'run:smoke',
      'accept:scene',
    ]);
    expect(result.notes.join()).toContain('Lane responsive is not owned');
    const devtools = plan({
      tier: 'gate',
      changed: [change('devtools/client/x.js')],
      proof,
    });
    expect(ids(devtools.obligations)).toContain('lane:responsive');
    // A candidate with no diff, such as a first gate on main, has nothing to scope by.
    expect(ids(plan({ tier: 'gate', proof }).obligations)).toContain('lane:responsive');
  });

  it('dispatches files explicitly, one browser where declared, and repeats with its context first', () => {
    const result = plan({ tier: 'gate', changed: [change(css)], proof });
    const lane = result.obligations.find((entry) => entry.id === 'lane:tiles');
    expect(lane?.step?.expected?.files).toHaveLength(485);
    expect(lane?.step?.args.slice(0, 3)).toEqual(['--headless', '--auto-ports', '--no-shard']);
    expect(lane?.step?.quiet).toBe(true);
    const unit = result.obligations.find((entry) => entry.id === 'lane:unit');
    expect(unit?.step?.args).not.toContain('--no-shard');
    expect(unit?.step?.quiet).toBeUndefined();
    const stress = result.obligations.find((entry) => entry.kind === 'stress');
    expect(stress?.repeat).toBe(10);
    expect(stress?.step?.args).toEqual([
      '--headless',
      '--auto-ports',
      '--no-shard',
      '--repeat',
      '10',
      `${directory}/browser_1.js`,
      `${directory}/browser_2.js`,
      `${directory}/browser_3.js`,
    ]);
    expect(result.obligations.find((entry) => entry.kind === 'check')?.step).toEqual({
      command: 'check',
      args: [],
      quiet: true,
    });
    expect(result.obligations.find((entry) => entry.kind === 'accept')?.step).toBeUndefined();
  });

  it('runs a changed test no lane covers, and does not repeat one a lane does', () => {
    const covered = `${directory}/browser_7.js`;
    const outside = 'browser/x/test/browser_new.js';
    const result = plan({
      tier: 'gate',
      changed: [change(covered), change(outside)],
      tests: [...tests, { path: outside, content: '' }],
      proof,
    });
    expect(ids(result.obligations)).toContain(`test:${outside}`);
    expect(ids(result.obligations)).not.toContain(`test:${covered}`);
  });

  it('holds static to the project line on warnings, and only that', () => {
    const held = plan({ changed: [change(css)], lintMaxWarnings: 3 });
    expect(held.obligations[0]?.step?.args).toEqual([css, '--max-warnings', '3']);
    const whole = plan({ changed: [change('dom/foo.cpp')], lintMaxWarnings: 0 });
    expect(whole.obligations[0]?.step?.args).toEqual(['--max-warnings', '0']);
  });

  it('lets an empty lane pattern refuse only a gate, which would run it', () => {
    const empty: ProofConfig = {
      gate: { lanes: [{ id: 'gone', files: ['nowhere/browser_*.js'] }] },
    };
    expect(ids(plan({ changed: [change(css)], proof: empty }).obligations)).toEqual([
      'static',
      'build',
    ]);
  });

  it('asks a person about a changed declaration, at the gate only', () => {
    const changes = ['proof'];
    const gate = plan({ tier: 'gate', declarationChanges: changes, notes: ['Lane x is gone.'] });
    const accept = gate.obligations.find((entry) => entry.id === 'accept:proof-config');
    expect(accept?.kind).toBe('accept');
    expect(accept?.reason).toContain('proof');
    expect(gate.notes).toContain('Lane x is gone.');
    expect(ids(plan({ tier: 'gate', declarationChanges: [] }).obligations)).not.toContain(
      'accept:proof-config'
    );
  });

  it('lists a deleted test with the rosters that held it, and runs nothing for it', () => {
    const path = `${directory}/browser_gone.js`;
    const proof: ProofConfig = {
      gate: {
        lanes: [
          { id: 'all', files: [`${directory}/browser_*.js`] },
          { id: 'other', files: [`${directory}/browser_*.js`], exclude: [path] },
        ],
        stress: [{ id: 's', files: [path], repeat: 2 }],
      },
    };
    const deleted = { ...change(path), deleted: true };
    const { removedTests, obligations } = plan({ tier: 'gate', changed: [deleted], proof });
    expect(removedTests).toEqual([{ path, from: ['lane:all', 'stress:s'] }]);
    expect(ids(obligations)).not.toContain(`test:${path}`);
    expect(plan({ changed: [deleted] }).removedTests).toEqual([{ path, from: [] }]);
    expect(plan({ changed: [change(css)] }).removedTests).toEqual([]);
  });

  it('keeps whatever an acceptance looks at, whatever its scope says', () => {
    const test = `${directory}/browser_0.js`;
    const scoped: ProofConfig = {
      gate: {
        lanes: [{ id: 'captures', files: [test], owns: ['nothing/**'] }],
        stress: [{ id: 'soak', files: [test], repeat: 2, owns: ['nothing/**'] }],
        controls: [{ id: 'guard', diff: 'c.diff', test, assertions: ['x'] }],
        acceptance: [
          {
            id: 'scene',
            reason: 'A person looks.',
            evidence: ['lane:captures', 'stress:soak', 'control:guard'],
          },
        ],
      },
    };
    const result = plan({
      tier: 'gate',
      changed: [change(css)],
      proof: scoped,
      controlTargets: { 'c.diff': ['browser/other.css'] },
    });
    expect(ids(result.obligations)).toEqual(
      expect.arrayContaining(['lane:captures', 'stress:soak', 'control:guard', 'accept:scene'])
    );
    expect(result.obligations.find((entry) => entry.id === 'accept:scene')?.evidence).toEqual([
      'lane:captures',
      'stress:soak',
      'control:guard',
    ]);
    // An acceptance that is out of scope keeps nothing.
    const out: ProofConfig = {
      gate: {
        lanes: [{ id: 'captures', files: [test], owns: ['nothing/**'] }],
        acceptance: [
          { id: 'scene', reason: 'r', owns: ['nothing/**'], evidence: ['lane:captures'] },
        ],
      },
    };
    expect(ids(plan({ tier: 'gate', changed: [change(css)], proof: out }).obligations)).toEqual(
      expect.not.arrayContaining(['lane:captures', 'accept:scene'])
    );
  });

  it('notes an acceptance whose evidence is gone with its tests', () => {
    const gone: ProofConfig = {
      gate: { acceptance: [{ id: 'scene', reason: 'r', evidence: ['lane:captures'] }] },
    };
    const result = plan({ tier: 'gate', proof: gone });
    expect(result.notes.join()).toContain('looks at lane:captures, which is gone');
    expect(
      result.obligations.find((entry) => entry.id === 'accept:scene')?.evidence
    ).toBeUndefined();
  });

  it('puts a validator in a lane step and its key, and leaves it out of a file run alone', () => {
    const test = `${directory}/browser_0.js`;
    const validate = { command: ['node', 'tools/v.mjs'] };
    const proof: ProofConfig = { gate: { lanes: [{ id: 'l', files: [test], validate }] } };
    const gate = plan({ tier: 'gate', proof });
    const step = gate.obligations.find((entry) => entry.id === 'lane:l')?.step;
    expect(step?.validate).toEqual(validate);
    const without = plan({
      tier: 'gate',
      proof: { gate: { lanes: [{ id: 'l', files: [test] }] } },
    });
    expect(gate.obligations.find((entry) => entry.id === 'lane:l')?.fingerprints).not.toEqual(
      without.obligations.find((entry) => entry.id === 'lane:l')?.fingerprints
    );
    const task = plan({ changed: [change(test)], proof });
    expect(
      task.obligations.find((entry) => entry.id === `test:${test}`)?.step?.validate
    ).toBeUndefined();
  });

  it('puts a run validator in the run step and its key, as on a lane', () => {
    const args = ['--headless', '--smoke-exit', '30', '--capture-console', '{artifacts}/c.txt'];
    const validate = { command: ['node', 'tools/allow.mjs', '{artifacts}/c.txt'] };
    const judged = plan({ tier: 'gate', proof: { gate: { runs: [{ id: 's', args, validate }] } } });
    const run = judged.obligations.find((entry) => entry.id === 'run:s');
    expect(run?.step).toMatchObject({ command: 'run', args, validate });
    const bare = plan({ tier: 'gate', proof: { gate: { runs: [{ id: 's', args }] } } });
    expect(run?.fingerprints).not.toEqual(
      bare.obligations.find((entry) => entry.id === 'run:s')?.fingerprints
    );
    // The capture holds the validator's script beside the source, as a lane's.
    expect(declaredInputs({ gate: { runs: [{ id: 's', args, validate }] } })).toEqual([
      'tools/allow.mjs',
    ]);
  });

  it('refuses a lane pattern that matches nothing rather than proving an empty roster', () => {
    const empty: ProofConfig = {
      gate: { lanes: [{ id: 'gone', files: ['nowhere/browser_*.js'] }] },
    };
    expect(() => plan({ tier: 'gate', proof: empty })).toThrow(/proof-empty-lane/);
    const excluded: ProofConfig = {
      gate: { lanes: [{ id: 'gone', files: [`${directory}/browser_*.js`], exclude: ['**'] }] },
    };
    expect(() => plan({ tier: 'gate', proof: excluded })).toThrow(/proof-empty-lane/);
  });

  it('plans a declared control only when its mutation touches what this candidate changed', () => {
    const declared: ProofConfig = {
      gate: {
        controls: [
          { id: 'guard', diff: 'c.diff', test: `${directory}/browser_0.js`, assertions: ['guard'] },
        ],
      },
    };
    const unrelated = plan({
      tier: 'gate',
      changed: [change(css)],
      proof: declared,
      controlTargets: { 'c.diff': ['browser/other.css'] },
    });
    expect(ids(unrelated.obligations)).not.toContain('control:guard');
    expect(unrelated.notes.join()).toContain('Control guard');
    const related = plan({
      tier: 'gate',
      changed: [change(css)],
      proof: declared,
      controlTargets: { 'c.diff': [css] },
    });
    expect(ids(related.obligations)).toContain('control:guard');
  });

  it('keeps an always control whatever changed, and refuses one that mutates nothing', () => {
    const declared: ProofConfig = {
      gate: {
        controls: [
          {
            id: 'guard',
            diff: 'c.diff',
            test: `${directory}/browser_0.js`,
            assertions: ['guard'],
            always: true,
          },
        ],
      },
    };
    const kept = plan({
      tier: 'gate',
      changed: [],
      proof: declared,
      controlTargets: { 'c.diff': ['browser/other.css'] },
    });
    const obligation = kept.obligations.find((entry) => entry.id === 'control:guard');
    expect(obligation?.always).toBe(true);
    expect(obligation?.step?.quiet).toBe(true);
    expect(kept.notes.join()).not.toContain('Control guard');
    expect(() =>
      plan({ tier: 'gate', changed: [], proof: declared, controlTargets: { 'c.diff': [] } })
    ).toThrow(/proof-control-unrelated/);
  });

  it('holds no project name in the planner: declaration alone decides stress', () => {
    const noStress = plan({
      tier: 'gate',
      changed: [change('browser/tiles/world/x.css')],
      proof: { gate: { lanes: [{ id: 'tiles-world', files: [`${directory}/browser_*.js`] }] } },
    });
    expect(noStress.obligations.filter((entry) => entry.kind === 'stress')).toEqual([]);
  });
});

describe('plan identity', () => {
  it('binds the base tree: another base is another plan', () => {
    const first = plan({ changed: [change(css)] });
    const second = plan({
      changed: [change(css)],
      base: { commit: 'b'.repeat(40), tree: 'e'.repeat(40), label: 'x', narrowed: false },
    });
    expect(first.base.tree).not.toBe(second.base.tree);
    expect(first.id).not.toBe(second.id);
  });

  it('refuses a task with nothing to prove rather than passing it', () => {
    expect(() => plan({ changed: [] })).toThrow(/proof-empty-input/);
  });

  it('fingerprints what a step does, not who asked, and sees every difference that matters', () => {
    const step = { command: 'test' as const, args: ['a.js'], expected: { files: ['a.js'] } };
    expect(stepFingerprint(step)).toBe(stepFingerprint({ ...step, quiet: false }));
    expect(stepFingerprint(step)).not.toBe(stepFingerprint({ ...step, quiet: true }));
    expect(stepFingerprint(step)).not.toBe(
      stepFingerprint({ ...step, args: ['--repeat', '2', 'a.js'] })
    );
    expect(stepFingerprint(step)).not.toBe(
      stepFingerprint({ ...step, controlAssertions: ['guard'] })
    );
    const declared = { ...step, env: { PROJECT_CAPTURE: '1' } };
    expect(stepFingerprint(declared)).not.toBe(stepFingerprint(step));
    expect(stepFingerprint(declared)).not.toBe(
      stepFingerprint({ ...step, env: { PROJECT_CAPTURE: '2' } })
    );
    expect(stepFingerprint({ ...step, uploadDir: true })).not.toBe(stepFingerprint(step));
    // Holding the display on changes nothing a test reads.
    expect(stepFingerprint({ ...step, keepAwake: true })).toBe(stepFingerprint(step));
    // Where and how fast it ran is not what it did.
    expect(
      stepFingerprint({
        ...step,
        deadlineSeconds: 5,
        resources: { cpu: 8, memory: 16, build: 0, browser: 1, display: 0 },
      })
    ).toBe(stepFingerprint(step));
  });
});
