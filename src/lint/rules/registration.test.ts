// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import type { ChangeGroup } from '../../project/index.js';
import { lintSteps } from '../../testing/lint.js';

describe('mozbuild-unsorted-list', () => {
  it('reports the first out-of-place item of a strict-ordered list', async () => {
    const text =
      'EXTRA_JS_MODULES += [\n    "B.sys.mjs",\n    "A.sys.mjs",\n]\nDIRS += ["z", "a"]\n';
    const findings = await lintSteps(
      ['mozbuild-unsorted-list'],
      [{ path: 'browser/moz.build', before: '', after: text }]
    );
    expect(findings.map((f) => [f.line, f.message])).toEqual([
      [
        2,
        'moz.build list EXTRA_JS_MODULES is not sorted: expected "A.sys.mjs" but found "B.sys.mjs" (configure fails with UnsortedError).',
      ],
    ]);
  });
});

describe('unregistered-system-module', () => {
  const module = { path: 'browser/modules/mine/Thing.sys.mjs', after: 'export const x = 1;\n' };
  const importer = {
    path: 'browser/base/content/mine.js',
    after:
      'ChromeUtils.defineESModuleGetters(lazy, {\n  Thing: "resource:///modules/mine/Thing.sys.mjs",\n});\n',
  };

  it('asks for a moz.build entry for an imported created module', async () => {
    const findings = await lintSteps(['unregistered-system-module'], [module, importer]);
    expect(findings.map((f) => f.path)).toEqual([module.path]);
  });

  it('does not count the name in a comment or in a moz.build of another directory', async () => {
    const elsewhere = [
      { path: 'browser/modules/mine/moz.build', after: '# "Thing.sys.mjs" is added later\n' },
      { path: 'browser/modules/other/moz.build', after: 'EXTRA_JS_MODULES += ["Thing.sys.mjs"]\n' },
    ];
    const findings = await lintSteps(
      ['unregistered-system-module'],
      [module, importer, ...elsewhere]
    );
    expect(findings.map((f) => f.path)).toEqual([module.path]);
  });

  it('accepts the moz.build list that installs the file, and ignores modules nothing imports', async () => {
    const mozBuild = {
      path: 'browser/modules/mine/moz.build',
      after: 'EXTRA_JS_MODULES.mine += ["Thing.sys.mjs"]\n',
    };
    expect(await lintSteps(['unregistered-system-module'], [module, importer, mozBuild])).toEqual(
      []
    );
    expect(await lintSteps(['unregistered-system-module'], [module])).toEqual([]);
  });
});

describe('dangling-registration', () => {
  const jar = 'browser.jar:\n  content/browser/a.js (content/a.js)\n';

  it('names an added manifest entry whose file nothing provides', async () => {
    const steps = [
      {
        path: 'browser/base/jar.mn',
        before: jar,
        after: `${jar}  content/browser/b.js (content/b.js)\n  content/browser/c.js (content/c.js)\n  content/browser/d.js (content/d.js)\n`,
      },
      { path: 'browser/base/content/c.js', after: 'c();\n' },
    ];
    const findings = await lintSteps(['dangling-registration'], steps, {
      engine: { 'browser/base/content/d.js': 'd();\n' },
    });
    expect(findings.map((f) => [f.line, f.message])).toEqual([
      [
        3,
        '"content/b.js" names browser/base/content/b.js, which neither the owned changes nor the engine provide.',
      ],
    ]);
  });

  it('counts a file the project deletes as gone', async () => {
    const steps = [
      {
        path: 'dom/tests/browser.toml',
        before: '[DEFAULT]\n',
        after: '[DEFAULT]\n\n["browser_gone.js"]\n',
      },
      { path: 'dom/tests/browser_gone.js', before: 'x', after: undefined },
    ];
    const findings = await lintSteps(['dangling-registration'], steps, {
      engine: { 'dom/tests/browser_gone.js': 'x' },
    });
    expect(findings).toHaveLength(1);
  });
});

describe('forward references between sequential groups', () => {
  const groups = (meta: Record<string, ChangeGroup['meta']> = {}): ChangeGroup[] =>
    ['001-a.patch', '002-b.patch'].map((id) => ({ id, meta: meta[id] ?? {} }));
  const importer = {
    path: 'browser/A.sys.mjs',
    group: '001-a.patch',
    after: 'import { B } from "resource:///modules/B.sys.mjs";\n',
  };
  const created = {
    path: 'browser/modules/B.sys.mjs',
    group: '002-b.patch',
    after: 'export const B = 1;\n',
  };
  const rules = ['forward-import', 'forward-registration', 'staged-dependency-unused'];

  it('flags an import of a module only a later group creates', async () => {
    const findings = await lintSteps(rules, [importer, created], {
      groups: groups(),
      sequential: true,
    });
    expect(findings.map((f) => [f.rule, f.group, f.path, f.line])).toEqual([
      ['forward-import', '001-a.patch', 'browser/A.sys.mjs', 1],
    ]);
  });

  it('says nothing for an earlier creator, or when the groups do not apply in sequence', async () => {
    const reversed = [
      { ...importer, group: '002-b.patch' },
      { ...created, group: '001-a.patch' },
    ];
    expect(await lintSteps(rules, reversed, { groups: groups(), sequential: true })).toEqual([]);
    expect(await lintSteps(rules, [importer, created], { groups: groups() })).toEqual([]);
  });

  it('flags a manifest entry an earlier group adds for a later file, on the added line', async () => {
    const steps = [
      {
        path: 'browser/tests/browser.toml',
        group: '001-a.patch',
        before: '[DEFAULT]\n',
        after: '[DEFAULT]\nsupport-files = ["head.js"]\n',
      },
      { path: 'browser/tests/head.js', group: '002-b.patch', after: 'x\n' },
    ];
    const findings = await lintSteps(rules, steps, { groups: groups(), sequential: true });
    expect(findings.map((f) => [f.rule, f.line])).toEqual([['forward-registration', 2]]);
  });

  it('accepts a declared staged dependency and warns about a stale one', async () => {
    const meta = {
      '001-a.patch': {
        stagedDependencies: [
          { file: 'browser/A.sys.mjs', creates: 'browser/modules/B.sys.mjs' },
          { file: 'browser/A.sys.mjs', creates: 'browser/gone.js' },
        ],
      },
    };
    const findings = await lintSteps(rules, [importer, created], {
      groups: groups(meta),
      sequential: true,
    });
    expect(findings.map((f) => [f.rule, f.severity])).toEqual([
      ['staged-dependency-unused', 'warning'],
    ]);
  });

  it('finds an import added to an existing getter map of a modified file', async () => {
    const before =
      'ChromeUtils.defineESModuleGetters(lazy, {\n  A: "resource:///modules/A.sys.mjs",\n});\n';
    const after = before.replace('});', '  B: "resource:///modules/B.sys.mjs",\n});');
    const steps = [{ path: 'browser/x.js', group: '001-a.patch', before, after }, created];
    const findings = await lintSteps(['forward-import'], steps, {
      groups: groups(),
      sequential: true,
    });
    expect(findings.map((f) => f.line)).toEqual([3]);
  });
});
