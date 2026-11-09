// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { validateAdapterArguments } from '../../jobs/adapter-arguments.js';
import type { JobStep } from '../../jobs/schema.js';
import { stepTraits } from '../../jobs/step-traits.js';
import { createProofPlan, type PlanInput, stepFingerprint } from '../plan.js';
import { inTypecheckProject, jsconfigScope, type PlanTypecheck } from '../plan-typecheck.js';
import { rootRoute, runtimeRoute } from '../route.js';
import type { ChangedPath, Obligation, ProofPlan } from '../types.js';

function change(path: string, tree: ChangedPath['tree'] = 'engine', deleted = false): ChangedPath {
  return {
    path,
    tree,
    route: tree === 'engine' ? runtimeRoute(path) : rootRoute(path),
    deleted,
  };
}

/** A real project's three projects, scoped as their jsconfigs state. */
const TYPECHECK: PlanTypecheck = {
  projects: [
    {
      project: 'components/custom/jsconfig.json',
      include: ['**/*.mjs', '**/*.js', '../../tools/types/hominis-shim-portable.d.ts'],
      exclude: ['node_modules'],
    },
    {
      project: 'engine/browser/base/content/jsconfig.json',
      include: [
        'hominis*',
        'test/hominis/**/*',
        'test/hominis-tiles/**/*',
        '../../../../tools/types/hominis-shim-gecko.d.ts',
      ],
      exclude: ['test/hominis-tiles/**/file_*.jsx'],
    },
    {
      project: 'engine/browser/modules/hominis/jsconfig.json',
      include: ['**/*.mjs', '**/*.js', 'test/**/*'],
    },
  ],
  shims: [
    'tools/types/hominis-shim-portable.d.ts',
    'tools/types/hominis-shim-browser-content.d.ts',
  ],
};

/** Overrides, where an undefined `typecheck` stands for a project with no typecheck block. */
type Overrides = Omit<Partial<PlanInput>, 'typecheck'> & { typecheck?: PlanTypecheck | undefined };

function plan(overrides: Overrides = {}): ProofPlan {
  const { typecheck, ...rest } = { typecheck: TYPECHECK, ...overrides };
  return createProofPlan({
    tier: 'task',
    source: 'a'.repeat(64),
    base: { commit: 'b'.repeat(40), tree: 'c'.repeat(40), label: 'main', narrowed: false },
    compiled: 'd'.repeat(64),
    changed: [],
    tests: [],
    touched: [],
    named: [],
    controlTargets: {},
    ...rest,
    ...(typecheck === undefined ? {} : { typecheck }),
  });
}

const types = (result: ProofPlan): Obligation | undefined =>
  result.obligations.find((entry) => entry.id === 'types');
const test = 'browser/base/content/test/hominis/browser_tile_null.js';

describe('task tier types the projects a change reaches', () => {
  it('types the project holding a changed test, before any build, as the gate check would', () => {
    const result = plan({ changed: [change(test)], named: [] });
    expect(result.obligations.map((entry) => entry.id).slice(0, 2)).toEqual(['static', 'types']);
    const obligation = types(result);
    expect(obligation?.kind).toBe('static');
    expect(obligation?.step).toEqual({
      command: 'typecheck',
      args: ['--project', 'engine/browser/base/content/jsconfig.json'],
    });
    // A static step a job admits as it stands: no build, browser or package.
    const step = obligation?.step ?? { command: 'typecheck', args: [] };
    expect(() => {
      validateAdapterArguments(step);
    }).not.toThrow();
    expect(stepTraits(step)).toMatchObject({ light: true, builds: false, browser: false });
    // Evidence of every project typed discharges the narrower obligation.
    expect(obligation?.fingerprints).toEqual([
      stepFingerprint(obligation?.step ?? { command: 'typecheck', args: [] }),
      stepFingerprint({ command: 'typecheck', args: [] }),
    ]);
  });

  it('names each reached project once, in a stable order', () => {
    const changed = [
      change('browser/modules/hominis/HominisStore.sys.mjs'),
      change('browser/base/content/hominis-tiles.js'),
      change('browser/modules/hominis/test/unit/test_store.js'),
    ];
    const forward = types(plan({ changed }))?.step;
    expect(forward?.args).toEqual([
      '--project',
      'engine/browser/base/content/jsconfig.json',
      '--project',
      'engine/browser/modules/hominis/jsconfig.json',
    ]);
    expect(types(plan({ changed: [...changed].reverse() }))?.step).toEqual(forward);
  });

  it('counts a deleted file, since what imported it no longer resolves', () => {
    expect(
      types(plan({ changed: [change('browser/base/content/hominis-old.js', 'engine', true)] }))
        ?.step?.args
    ).toEqual(['--project', 'engine/browser/base/content/jsconfig.json']);
  });

  it('types a root-tree project by its own path', () => {
    const component: ChangedPath = {
      path: 'components/custom/moz-x/moz-x.mjs',
      tree: 'root',
      route: 'none',
      deleted: false,
    };
    expect(types(plan({ changed: [component] }))?.step?.args).toEqual([
      '--project',
      'components/custom/jsconfig.json',
    ]);
    expect(
      inTypecheckProject(
        TYPECHECK.projects[1] ?? { project: '' },
        'engine/browser/base/content/test/hominis-tiles/file_a.jsx'
      )
    ).toBe(false);
  });

  it('adds nothing for a change outside every project, or with no typecheck block', () => {
    for (const path of [
      'browser/base/content/browser.js',
      'browser/base/content/hominis-tiles.css',
      'toolkit/content/widgets/moz-x.mjs',
    ])
      expect(types(plan({ changed: [change(path)] }))).toBeUndefined();
    expect(types(plan({ changed: [change(test)], typecheck: undefined }))).toBeUndefined();
    expect(
      types(plan({ changed: [change(test)], typecheck: { projects: [], shims: [] } }))
    ).toBeUndefined();
  });

  it('types every project after a structural change, or a change to a shim or jsconfig', () => {
    const every: JobStep = { command: 'typecheck', args: [] };
    for (const changed of [
      [change('browser/base/content/moz.build')],
      [change('tools/types/hominis-shim-browser-content.d.ts', 'root')],
      [change('browser/modules/hominis/jsconfig.json')],
    ]) {
      const obligation = types(plan({ changed }));
      expect(obligation?.step).toEqual(every);
      expect(obligation?.fingerprints).toEqual([stepFingerprint(every)]);
    }
  });

  it('types every project with the unrestricted step when the change reaches them all', () => {
    expect(
      types(
        plan({
          changed: [change('tools/types/hominis-shim-gecko.d.ts', 'root')],
          typecheck: {
            projects: TYPECHECK.projects.slice(1, 2),
            shims: [],
          },
        })
      )?.step
    ).toEqual({ command: 'typecheck', args: [] });
  });

  it('leaves the gate as it was: its check already types every project', () => {
    const gate = plan({ tier: 'gate', changed: [change(test)], named: [test] });
    const without = plan({
      tier: 'gate',
      changed: [change(test)],
      named: [test],
      typecheck: undefined,
    });
    expect(types(gate)).toBeUndefined();
    expect(gate.obligations).toEqual(without.obligations);
    expect(gate.id).toBe(without.id);
  });
});

describe('project membership', () => {
  const scope = jsconfigScope(
    'engine/browser/base/content/jsconfig.json',
    '{\n  // what the gate types\n  "include": ["hominis*", "test/hominis"],\n  "exclude": ["test/hominis/skip"],\n}\n'
  );

  it('reads a commented jsconfig, a directory include, and a directory exclude', () => {
    expect(scope).toEqual({
      project: 'engine/browser/base/content/jsconfig.json',
      include: ['hominis*', 'test/hominis'],
      exclude: ['test/hominis/skip'],
    });
    expect(inTypecheckProject(scope, 'engine/browser/base/content/test/hominis/a/b.js')).toBe(true);
    expect(inTypecheckProject(scope, 'engine/browser/base/content/test/hominis/skip/b.js')).toBe(
      false
    );
    expect(inTypecheckProject(scope, 'engine/browser/base/content/hominis/b.js')).toBe(false);
  });

  it('takes files outside any include, and everything under the directory without either', () => {
    const files = jsconfigScope('a/jsconfig.json', '{"files": ["x.js"], "exclude": ["x.js"]}');
    expect(inTypecheckProject(files, 'a/x.js')).toBe(true);
    expect(inTypecheckProject(files, 'a/y.js')).toBe(false);
    const unread = jsconfigScope('a/jsconfig.json', undefined);
    expect(unread).toEqual({ project: 'a/jsconfig.json' });
    expect(inTypecheckProject(unread, 'a/deep/y.ts')).toBe(true);
    expect(inTypecheckProject(unread, 'a/node_modules/y.ts')).toBe(false);
    expect(inTypecheckProject(unread, 'b/y.ts')).toBe(false);
    expect(jsconfigScope('a/jsconfig.json', '[1]')).toEqual({ project: 'a/jsconfig.json' });
    expect(jsconfigScope('a/jsconfig.json', '{"include": [1]}')).toEqual({
      project: 'a/jsconfig.json',
    });
  });
});
