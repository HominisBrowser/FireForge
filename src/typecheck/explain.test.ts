// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { engineFiles, textChangeSet } from '../testing/changes.js';
import { testConfig } from '../testing/config.js';
import { useTempDir, writeTree } from '../testing/temp.js';
import { explainTypecheck, explanationJson, renderExplanation } from './explain.js';
import type { TypecheckRequest } from './typecheck.js';

const dir = useTempDir();

function request(projects: string[]): TypecheckRequest {
  return {
    config: testConfig(projects.length === 0 ? {} : { typecheck: { projects } }),
    projectRoot: join(dir(), 'project'),
    engineDir: join(dir(), 'workspace', 'engine'),
    changes: textChangeSet([]),
    engine: engineFiles(),
  };
}

describe('explainTypecheck', () => {
  it('tells a project that opts out, one that is missing and one that does not parse', async () => {
    await writeTree(dir(), {
      'project/off/jsconfig.json': JSON.stringify({
        compilerOptions: { checkJs: false },
        include: ['*.mjs'],
      }),
      'project/off/a.mjs': 'export const a = 1;\n',
      'project/bad/jsconfig.json': '{ "compilerOptions": { "checkJs": tru } }',
    });
    const explanation = await explainTypecheck(
      request(['off/jsconfig.json', 'gone/jsconfig.json', 'bad/jsconfig.json']),
      'off/a.mjs'
    );
    expect(explanation.file).toBe('off/a.mjs');
    expect(explanation.exists).toBe(true);
    expect(explanation.projects.map((view) => [view.project, view.membership])).toEqual([
      ['off/jsconfig.json', 'skipped'],
      ['gone/jsconfig.json', 'unreadable'],
      ['bad/jsconfig.json', 'unreadable'],
    ]);
    expect(explanation.projects[1]?.detail).toBe('the project file does not exist');
    expect(explanation.projects[2]?.detail).not.toBe('');
    expect(explanation.owned).toEqual({
      program: 'none',
      reason: 'the file is not in the engine',
      heads: [],
      imports: [],
    });
  });

  it('renders a file outside every project, as lines and as JSON', async () => {
    const explanation = await explainTypecheck(request([]), 'engine/browser/missing.mjs');
    expect(renderExplanation(explanation)).toEqual([
      'engine/browser/missing.mjs (does not exist)',
      '',
      'Projects:',
      '  none configured',
      '',
      'Owned files: not checked (patchLint.checkJs is off)',
    ]);
    expect(explanationJson(explanation)).toEqual({
      file: 'engine/browser/missing.mjs',
      exists: false,
      projects: [],
      owned: {
        program: 'none',
        reason: 'patchLint.checkJs is off',
        heads: [],
        imports: [],
        shim: null,
      },
    });
  });

  it('renders a project view with its settings', () => {
    const lines = renderExplanation({
      file: 'engine/a.mjs',
      exists: true,
      projects: [
        {
          project: 'engine/jsconfig.json',
          membership: 'root',
          shim: 'types/shim.d.ts',
          litTypes: true,
          undefinedIdentifiers: 'error',
        },
      ],
      owned: {
        program: 'module',
        heads: ['head.js'],
        imports: [{ specifier: 'resource://x', resolution: 'owned', target: 'x.sys.mjs' }],
        shim: 'types/owned.d.ts',
      },
    });
    expect(lines.slice(3)).toEqual([
      '  engine/jsconfig.json: root; shim types/shim.d.ts, litTypes true, undefinedIdentifiers error',
      '',
      'Owned files: module program',
      '  shim types/owned.d.ts',
      '  head head.js',
      '  import resource://x: owned x.sys.mjs',
    ]);
  });
});
