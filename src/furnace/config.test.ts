// SPDX-License-Identifier: EUPL-1.2
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { transaction } from '../kernel/journal.js';
import { makeFurnaceFixture } from '../testing/furnace.js';
import { useTempDir, writeTree } from '../testing/temp.js';
import {
  editFurnaceConfig,
  ftlResourceDir,
  jarSourceDir,
  loadFurnaceConfig,
  parseFurnaceConfig,
  section,
  tagProblem,
} from './config.js';

const dir = useTempDir();
const fixturePath = join(import.meta.dirname, '__fixtures__/realistic.furnace.json');

const base = { version: 1, componentPrefix: 'moz-' };
const custom = (entry: object): object => ({
  ...base,
  custom: {
    'moz-x': {
      description: '',
      targetPath: 'toolkit/content/widgets/moz-x',
      register: true,
      localized: false,
      ...entry,
    },
  },
});

function refusal(document: object): string {
  try {
    parseFurnaceConfig(document, 'furnace.json');
  } catch (error: unknown) {
    return (error as Error).message;
  }
  throw new Error('expected a refusal');
}

describe('the furnace.json schema', () => {
  it('accepts a real fork configuration', async () => {
    const config = parseFurnaceConfig(JSON.parse(await readFile(fixturePath, 'utf8')), 'fixture');
    expect(Object.keys(config.custom)).toHaveLength(6);
    expect(config.custom['moz-acme-shared']?.kind).toBe('library');
    expect(config.validationExceptions?.[0]?.file).toBe('moz-acme-editor-codemirror.mjs');
  });

  it('fills in the sections a minimal file omits', () => {
    expect(parseFurnaceConfig(base, 'f')).toMatchObject({ stock: [], overrides: {}, custom: {} });
  });

  it.each([
    [custom({ kind: 'library' }), /is a library, which defines no element/],
    [custom({ sharedFtl: 'browser/x.ftl' }), /sharedFtl, which requires localized/],
    [custom({ targetPath: '../outside' }), /relative path without "\.\."/],
    [custom({ composes: ['moz-nowhere'] }), /composes unknown component "moz-nowhere"/],
    [custom({ regster: true }), /Did you mean "register"/],
    [
      {
        ...base,
        custom: {
          'moz-a': {
            description: '',
            targetPath: 'a',
            register: true,
            localized: false,
            composes: ['moz-b'],
          },
          'moz-b': {
            description: '',
            targetPath: 'b',
            register: true,
            localized: false,
            composes: ['moz-a'],
          },
        },
      },
      /composes cycle: moz-a -> moz-b -> moz-a/,
    ],
    [
      {
        ...base,
        validationExceptions: [
          { component: 'a', check: 'c', reason: 'r', tag: 't', file: 'f.mjs' },
        ],
      },
      /a tag or a file, not both/,
    ],
    [
      {
        ...base,
        validationExceptions: [
          { component: 'a', check: 'c', reason: 'r' },
          { component: 'a', check: 'c', reason: 'again' },
        ],
      },
      /repeats the validation exception for a \[c\]/,
    ],
    [{ ...base, typecheckTagMap: 'types.ts' }, /\.d\.ts/],
    [{ ...base, stock: ['button'] }, /custom element name/],
    [
      {
        ...base,
        custom: {
          widget: { description: '', targetPath: 'w', register: true, localized: false },
        },
      },
      /custom element name/,
    ],
    [{ ...base, optInChecks: ['everything'] }, /icon-button-label/],
  ])('refuses %j', (document, message) => {
    expect(refusal(document)).toMatch(message);
  });
});

describe('editFurnaceConfig', () => {
  it('rewrites only the changed values, keeps one-line arrays and never writes defaults', async () => {
    const f = await makeFurnaceFixture(dir());
    const text =
      '{\n  "version": 1,\n  "componentPrefix": "moz-",\n  "tokenAllowlist": ["--a", "--b"]\n}\n';
    await writeTree(f.root, { 'furnace.json': text });
    await transaction(join(dir(), 'journal'), 'edit', (tx) =>
      editFurnaceConfig(f.project, tx, (document) => {
        section(document, 'custom')['moz-x'] = {
          description: 'X',
          targetPath: 'toolkit/content/widgets/moz-x',
          register: true,
          localized: false,
        };
      })
    );
    const written = await readFile(f.project.paths.furnace, 'utf8');
    expect(written).toContain('"tokenAllowlist": ["--a", "--b"]');
    expect(written).not.toContain('"stock"');
    expect((await loadFurnaceConfig(f.project)).custom['moz-x']?.description).toBe('X');
  });

  it('refuses an edit that leaves the document invalid, writing nothing', async () => {
    const f = await makeFurnaceFixture(dir(), { furnace: base });
    const before = await readFile(f.project.paths.furnace, 'utf8');
    await expect(
      transaction(join(dir(), 'journal'), 'edit', (tx) =>
        editFurnaceConfig(f.project, tx, (document) => {
          document['componentPrefix'] = 7;
        })
      )
    ).rejects.toMatchObject({ code: 'furnace-config-invalid' });
    expect(await readFile(f.project.paths.furnace, 'utf8')).toBe(before);
  });
});

describe('names and paths', () => {
  it.each([
    ['moz-my-widget', true],
    ['my-widget2', true],
    ['widget', false],
    ['moz--double', false],
    ['moz-trailing-', false],
    ['Moz-upper', false],
  ])('%s is a tag: %s', (name, ok) => {
    expect(tagProblem(name) === undefined).toBe(ok);
  });

  it('derives the Fluent resource directory and the jar source directory', () => {
    expect(ftlResourceDir(parseFurnaceConfig(base, 'f'))).toBe('toolkit/global');
    expect(
      ftlResourceDir(parseFurnaceConfig({ ...base, ftlBasePath: 'browser/x' }, 'f'))
    ).toBeUndefined();
    expect(jarSourceDir('toolkit/content/widgets/moz-x')).toBe('widgets/moz-x');
  });
});
