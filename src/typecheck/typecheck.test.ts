// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { engineFiles, textChangeSet, type TextStep } from '../testing/changes.js';
import { testConfig } from '../testing/config.js';
import { useTempDir, writeTree } from '../testing/temp.js';
import {
  explainTypecheck,
  renderTypecheckReport,
  runTypecheck,
  type TypecheckReport,
  type TypecheckRequest,
  typecheckVerdict,
} from './index.js';

const dir = useTempDir();

const JSCONFIG = JSON.stringify({
  compilerOptions: {
    checkJs: true,
    target: 'es2022',
    module: 'esnext',
    moduleResolution: 'bundler',
  },
  include: ['*.js', '*.mjs'],
});

function request(config: Record<string, unknown>, steps: TextStep[] = []): TypecheckRequest {
  return {
    config: testConfig(config),
    projectRoot: join(dir(), 'project'),
    engineDir: join(dir(), 'workspace', 'engine'),
    changes: textChangeSet(steps),
    engine: engineFiles(),
  };
}

function issues(report: TypecheckReport): string[][] {
  return report.projects.flatMap((result) =>
    result.issues.map((issue) => [
      result.project,
      issue.path,
      `${issue.line}`,
      issue.severity,
      issue.message.replace(/ \(undefined identifier.*$/, ''),
    ])
  );
}

describe('runTypecheck', () => {
  it('checks engine/ projects in the workspace and other projects in the project', async () => {
    await writeTree(dir(), {
      'workspace/engine/browser/jsconfig.json': JSCONFIG,
      'workspace/engine/browser/a.js':
        '/** @type {number} */\nconst n = "x";\nServices.prefs.getBoolPref("a");\n',
      'project/components/jsconfig.json': JSCONFIG,
      'project/components/b.mjs': 'export const v = missingName;\n',
    });
    const report = await runTypecheck(
      request({
        typecheck: { projects: ['engine/browser/jsconfig.json', 'components/jsconfig.json'] },
      })
    );
    expect(issues(report)).toEqual([
      [
        'engine/browser/jsconfig.json',
        'engine/browser/a.js',
        '2',
        'error',
        "Type 'string' is not assignable to type 'number'.",
      ],
      [
        'components/jsconfig.json',
        'components/b.mjs',
        '1',
        'warning',
        "Cannot find name 'missingName'.",
      ],
    ]);
    expect(typecheckVerdict(report)).toEqual({ pass: false, errors: 1, warnings: 1 });
    expect(renderTypecheckReport(report).at(-1)).toBe(
      'Typecheck: 1 error(s), 1 warning(s) across 2 project(s) and the owned files'
    );
  });

  it('applies the shared shim, a per-project override, and undefinedIdentifiers', async () => {
    await writeTree(dir(), {
      'project/types/shim.d.ts': 'declare var gMine: number;\n',
      'project/a/jsconfig.json': JSCONFIG,
      'project/a/a.js': 'const x = gMine;\n',
      'project/b/jsconfig.json': JSCONFIG,
      'project/b/b.js': 'const y = gMine;\n',
    });
    const report = await runTypecheck(
      request({
        typecheck: {
          projects: ['a/jsconfig.json', 'b/jsconfig.json'],
          extraShim: 'types/shim.d.ts',
          projectOverrides: { 'b/jsconfig.json': null },
          undefinedIdentifiers: 'error',
        },
      })
    );
    expect(issues(report)).toEqual([
      ['b/jsconfig.json', 'b/b.js', '1', 'error', "Cannot find name 'gMine'."],
    ]);
  });

  it('reports a missing project, a missing shim, and a project that opts out', async () => {
    await writeTree(dir(), {
      'project/off/jsconfig.json': JSON.stringify({ compilerOptions: { checkJs: false } }),
      'project/off/a.js': 'const n = 1;\n',
    });
    const report = await runTypecheck(
      request({
        typecheck: {
          projects: ['gone/jsconfig.json', 'off/jsconfig.json'],
          projectOverrides: { 'off/jsconfig.json': null },
        },
      })
    );
    expect(issues(report)).toEqual([
      [
        'gone/jsconfig.json',
        'gone/jsconfig.json',
        '1',
        'error',
        'The project file gone/jsconfig.json does not exist.',
      ],
      [
        'off/jsconfig.json',
        'off/jsconfig.json',
        '1',
        'warning',
        'The project sets "checkJs": false, so it was skipped.',
      ],
    ]);
    const shimless = await runTypecheck(
      request({ typecheck: { projects: ['off/jsconfig.json'], extraShim: 'types/gone.d.ts' } })
    );
    expect(issues(shimless)[0]?.[4]).toBe('The TypeScript shim types/gone.d.ts does not exist.');
  });

  it('includes the strict pass over the owned files, and refuses to check nothing', async () => {
    const steps = [
      { path: 'browser/A.sys.mjs', after: '/** @type {number} */\nexport const n = "x";\n' },
    ];
    const report = await runTypecheck(request({ patchLint: { checkJs: true } }, steps));
    expect(report.owned.map((finding) => [finding.path, finding.line])).toEqual([
      ['browser/A.sys.mjs', 2],
    ]);
    expect(typecheckVerdict(report).pass).toBe(false);
    await expect(runTypecheck(request({}))).rejects.toMatchObject({
      code: 'typecheck-unconfigured',
    });
  });

  it('checks the given projects instead of the configured ones', async () => {
    await writeTree(dir(), {
      'project/a/jsconfig.json': JSCONFIG,
      'project/a/a.js': 'const a = 1;\n',
    });
    const report = await runTypecheck({
      ...request({ typecheck: { projects: ['gone/jsconfig.json'] } }),
      projects: ['a/jsconfig.json'],
    });
    expect(
      report.projects.map((result) => [result.project, result.filesChecked, result.issues.length])
    ).toEqual([['a/jsconfig.json', 1, 0]]);
  });
});

describe('explainTypecheck', () => {
  it('names the projects that see a file and how the owned pass does', async () => {
    await writeTree(dir(), {
      'workspace/engine/browser/jsconfig.json': JSCONFIG,
      'workspace/engine/browser/A.sys.mjs': 'export const a = 1;\n',
      'project/c/jsconfig.json': JSCONFIG,
    });
    const explanation = await explainTypecheck(
      request(
        {
          patchLint: { checkJs: true },
          typecheck: {
            projects: ['engine/browser/jsconfig.json', 'c/jsconfig.json'],
            litTypes: true,
          },
        },
        [{ path: 'browser/A.sys.mjs', after: 'export const a = 1;\n' }]
      ),
      'engine/browser/A.sys.mjs'
    );
    expect(explanation).toMatchObject({
      file: 'engine/browser/A.sys.mjs',
      exists: true,
      projects: [
        { project: 'engine/browser/jsconfig.json', membership: 'root', litTypes: true },
        { project: 'c/jsconfig.json', membership: 'not-root' },
      ],
      owned: { program: 'module', imports: [] },
    });
  });
});
