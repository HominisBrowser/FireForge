// SPDX-License-Identifier: EUPL-1.2
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { JsonObject } from '../kernel/json.js';
import { MINIMAL_CONFIG } from '../testing/config.js';
import { configSchema, upgradeConfig } from './index.js';

async function fixture(): Promise<JsonObject> {
  const file = fileURLToPath(new URL('./__fixtures__/previous-source.json', import.meta.url));
  return JSON.parse(await readFile(file, 'utf8')) as JsonObject;
}

const keys = (notes: readonly { key: string }[]): string[] => notes.map((note) => note.key);

describe('upgradeConfig', () => {
  it('converts a real source-mode configuration of the previous format into a valid one', async () => {
    const result = upgradeConfig(await fixture());
    expect(result.blockers).toEqual([]);
    expect(configSchema.validate(result.document).ok).toBe(true);

    const next = configSchema.parse(result.document, { source: 'fixture' });
    expect(next.mode).toBe('source');
    expect(next.source).toEqual({
      root: 'src',
      metadataRoot: '.fireforge-sources',
      pristineCommit: 'a5654e28a51104adec4bfa85c976d5c0bee7c0c6',
    });
    for (const gone of ['sources', 'proof', 'slots', 'test']) {
      expect(result.document).not.toHaveProperty(gone);
    }
    expect(next.patchLint.rules).toEqual({
      'jsdoc-class-method': 'error',
      'test-needs-assertion': 'error',
      'chrome-script-jsdoc': 'error',
    });
    expect(result.document['patchLint']).not.toHaveProperty('forwardRegistration');
    expect(result.document['check']).not.toHaveProperty('timeout');
    expect(next.check.extraSteps?.map((step) => [step.name, step.command])).toEqual([
      ['branding-month', ['node', 'tools/scripts/check-branding-month.mts']],
      ['engine-eslint', ['node', 'tools/scripts/run-engine-eslint.mts']],
      ['repo-audits', ['node', 'tools/scripts/run-audits.mts']],
      [
        'seasonal-depth-proof',
        [
          'node',
          'tools/scripts/generate-seasonal-branding.mts',
          '--depth-proof-self-test',
          '--month',
          '1',
        ],
      ],
      [
        'tooling',
        [
          'sh',
          '-c',
          "node tools/scripts/lint-tooling.mts && ./node_modules/.bin/tsc -p tsconfig.tools.json && node --test --test-reporter=dot 'tools/scripts/**/*.test.mts'",
        ],
      ],
    ]);
    expect(next.check.extraSteps?.[2]?.after).toEqual(['typecheck']);
    expect(next.gate?.build).toBe('ui');
    expect(next.gate?.documents).toEqual([
      'tools/**',
      '.claude/**',
      'tsconfig.tools.json',
      'components/prettier.config.mjs',
      '.prettierignore',
      '.gitignore',
    ]);
    const declared = result.document['gate'] as { lanes: Record<string, unknown>[] };
    expect(declared.lanes.map((lane) => Object.keys(lane).sort())).toEqual([
      ['files', 'id'],
      ['dispatch', 'files', 'id', 'uploadDir', 'validate'],
      ['files', 'id', 'uploadDir', 'validate'],
      ['dispatch', 'env', 'exclude', 'files', 'id', 'uploadDir', 'validate'],
      ['files', 'headed', 'id', 'machArgs'],
      ['files', 'headed', 'id'],
      ['files', 'id', 'validate'],
      ['dispatch', 'env', 'exclude', 'files', 'id', 'uploadDir', 'validate'],
    ]);
    expect(next.gate?.lanes?.[6]?.validate).toEqual({
      command: ['node', 'tools/scripts/run-helper-checks.mts'],
    });
    expect(next.gate?.runs).toEqual([
      {
        id: 'smoke',
        headless: false,
        smokeExit: 30,
        consoleAllowFile: 'tools/audit-config/smoke-console-allow.txt',
        validate: {
          command: [
            'node',
            'tools/scripts/validate-smoke.mts',
            '{artifacts}/console.txt',
            '--allow',
            'tools/audit-config/smoke-console-allow.txt',
          ],
        },
      },
    ]);
    expect(next.gate?.acceptance?.map(({ id, evidence }) => [id, evidence])).toEqual([
      ['visual', ['lane:captures']],
    ]);
    expect(next.patchPolicy?.scopeRules).toEqual([
      { group: '-tests\\.patch$', files: ['**/test/**', '**/tests/**'] },
    ]);

    // What a person must still look at is named.
    expect(keys(result.manual)).toEqual([
      'proof.gate.lanes[1].validate.command',
      'proof.gate.lanes[2].validate.command',
      'proof.gate.lanes[3].validate.command',
      'proof.gate.lanes[7].validate.command',
      'check.extraSteps',
    ]);

    // Everything dropped is named, with its reason.
    expect(keys(result.removed)).toEqual(
      expect.arrayContaining([
        'proof.mainBranch',
        'proof.gate.mode',
        'proof.gate.lanes[0].quiet',
        'proof.gate.lanes[5].holdFront',
        'proof.gate.lanes[6].validate.footprint',
        'proof.gate.lanes[7].owns',
        'proof.gate.acceptance[0].owns',
        'check.timeout',
        'check.extraSteps[0].footprint',
        'check.extraSteps[4]',
        'patchLint.forwardRegistration',
        'slots',
        'test.reapOrphans',
      ])
    );
    expect(result.removed.every((note) => note.message.length > 10)).toBe(true);
    expect(keys(result.converted)).toEqual(
      expect.arrayContaining([
        'sources',
        'proof',
        'proof.noneRoutes',
        'proof.gate.runs[0].args',
        'check.extraSteps[5].command',
        'patchLint.jsdocClassMethods',
        'patchPolicy.scopeRules[0].filenamePattern',
      ])
    );
  });

  it('leaves a document of the current format alone, so a second run does nothing', async () => {
    const once = upgradeConfig(await fixture());
    const twice = upgradeConfig(once.document);
    expect(twice).toEqual({
      document: once.document,
      converted: [],
      removed: [],
      manual: [],
      blockers: [],
    });
    expect(upgradeConfig({ ...MINIMAL_CONFIG })).toMatchObject({ converted: [], removed: [] });
  });

  it('writes out the license an unset key meant, and converts a patch-mode scope rule', () => {
    const result = upgradeConfig({
      ...MINIMAL_CONFIG,
      history: { path: '.fireforge/history.jsonl' },
      test: { canaryPath: 'browser/x.js', mochitestPorts: 'auto' },
      patchLint: { prettier: 'warning' },
      patchPolicy: {
        ranges: [{ from: 1, to: 99, category: 'ui' }],
        mutationMode: 'force',
        scopeRules: [{ category: 'ui', files: ['browser/**'] }],
      },
    });
    expect(result.blockers).toEqual([]);
    expect(result.document).toMatchObject({
      license: 'MPL-2.0',
      test: { mochitestPorts: 'auto' },
      patchPolicy: {
        mutationMode: 'error',
        scopeRules: [{ group: '^\\d+-ui-', files: ['browser/**'] }],
      },
    });
    expect(result.document).not.toHaveProperty('history');
    expect(result.document).not.toHaveProperty('mode');
    expect(keys(result.removed).sort()).toEqual([
      'history',
      'patchLint.prettier',
      'test.canaryPath',
    ]);
  });

  it.each([
    [
      'a run argument with no structured equivalent',
      {
        proof: {
          gate: { runs: [{ id: 'smoke', args: ['--smoke-exit', '20', '--profile', 'x'] }] },
        },
      },
      'proof.gate.runs[0].args[2]',
    ],
    [
      'a run without a smoke-exit',
      { proof: { gate: { runs: [{ id: 'smoke', args: ['--headless'] }] } } },
      'proof.gate.runs[0].args',
    ],
    [
      'a console captured somewhere else',
      {
        proof: {
          gate: {
            runs: [{ id: 's', args: ['--smoke-exit', '5', '--capture-console', 'out.txt'] }],
          },
        },
      },
      'proof.gate.runs[0].args[2]',
    ],
    [
      'an extra step run in another directory',
      { check: { extraSteps: [{ name: 'audit', command: 'node audit.mjs', cwd: 'tools' }] } },
      'check.extraSteps[0].cwd',
    ],
    [
      'an extra step named like a built-in step that runs something else',
      { check: { extraSteps: [{ name: 'token-lint', command: 'node my-token-lint.mjs' }] } },
      'check.extraSteps[0].name',
    ],
    [
      'a source declaration of another kind',
      { sources: { schemaVersion: 2, mode: 'authored', root: 'src' } },
      'sources',
    ],
    ['a key neither format has', { proof: { ledger: true } }, 'proof.ledger'],
    [
      'a lint switch that disagrees with its rule',
      { patchLint: { jsdocClassMethods: 'error', rules: { 'jsdoc-class-method': 'off' } } },
      'patchLint.jsdocClassMethods',
    ],
    ['a key the current schema refuses', { verifcation: true }, 'verifcation'],
  ])('refuses to guess at %s', (_name, patch, key) => {
    const result = upgradeConfig({ ...MINIMAL_CONFIG, ...(patch as JsonObject) });
    expect(keys(result.blockers)).toContain(key);
  });

  it('reads a headless smoke start with browser arguments', () => {
    const result = upgradeConfig({
      ...MINIMAL_CONFIG,
      proof: {
        gate: {
          runs: [
            {
              id: 'startup',
              quiet: true,
              args: ['--smoke-exit', '20', '--headless', '--', '-url', 'about:blank'],
            },
          ],
        },
      },
    });
    expect(result.blockers).toEqual([]);
    expect(result.document['gate']).toEqual({
      runs: [{ id: 'startup', smokeExit: 20, headless: true, args: ['-url', 'about:blank'] }],
    });
  });
});
