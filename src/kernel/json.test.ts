// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { useTempDir, writeTree } from '../testing/temp.js';
import { ExitCode } from './errors.js';
import { readText } from './fs.js';
import {
  isRecord,
  omitKeys,
  parseJson,
  readJson,
  readJsonIfExists,
  stringifyJson,
  writeJson,
} from './json.js';
import { s } from './schema.js';

const dir = useTempDir();
const State = s.object({ version: s.literal(1), files: s.array(s.string()) });

describe('parseJson and stringifyJson', () => {
  it('names the source of a syntax error', () => {
    expect(parseJson('{"a": [1, null]}')).toEqual({ a: [1, null] });
    expect(() =>
      parseJson('{oops', { source: 'state.json', exitCode: ExitCode.CONFIG_ERROR })
    ).toThrow(
      expect.objectContaining({
        code: 'json-invalid',
        exitCode: ExitCode.CONFIG_ERROR,
        message: expect.stringContaining('state.json is not valid JSON') as string,
      }) as Error
    );
  });

  it('writes indented text ending in a newline, with sorted keys on request', () => {
    expect(stringifyJson({ b: 1, a: { d: 1, c: [{ z: 1, y: 2 }] } })).toBe(
      '{\n  "b": 1,\n  "a": {\n    "d": 1,\n    "c": [\n      {\n        "z": 1,\n        "y": 2\n      }\n    ]\n  }\n}\n'
    );
    expect(
      stringifyJson({ b: 1, a: { d: 1, c: [{ z: 1, y: 2 }] } }, { sortKeys: true, indent: 0 })
    ).toBe('{"a":{"c":[{"y":2,"z":1}],"d":1},"b":1}\n');
    expect(stringifyJson({ a: undefined, b: 1 }, { indent: 0 })).toBe('{"b":1}\n');
  });

  it('narrows plain objects only', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
  });
});

describe('omitKeys', () => {
  it('copies an object without the named keys', () => {
    const object = { a: 1, b: 2, c: 3 };
    expect(omitKeys(object, 'b', 'missing')).toEqual({ a: 1, c: 3 });
    expect(object).toEqual({ a: 1, b: 2, c: 3 });
  });
});

describe('documents', () => {
  it('round-trips a document through its schema', async () => {
    const path = join(dir(), '.fireforge/state.json');
    await writeJson(path, { version: 1, files: ['a'] });
    expect(await readText(path)).toBe('{\n  "version": 1,\n  "files": [\n    "a"\n  ]\n}\n');
    expect(await readJson(path, State)).toEqual({ version: 1, files: ['a'] });
  });

  it('reads a missing document as undefined, or refuses when it must exist', async () => {
    const path = join(dir(), 'missing.json');
    expect(await readJsonIfExists(path, State)).toBeUndefined();
    await expect(
      readJson(path, State, { code: 'not-a-project', hint: 'Run setup' })
    ).rejects.toMatchObject({
      code: 'not-a-project',
      hint: 'Run setup',
    });
  });

  it('never resets a document that fails its schema: it names the file, the key and the repair', async () => {
    await writeTree(dir(), {
      'state.json': '{"version": 2, "files": []}',
      'torn.json': '{"version": 1, "fil',
    });
    const options = {
      code: 'invalid-state',
      exitCode: ExitCode.CONFIG_ERROR,
      hint: 'Run fireforge doctor',
    };
    await expect(readJson(join(dir(), 'state.json'), State, options)).rejects.toMatchObject({
      ...options,
      message: `${join(dir(), 'state.json')}: "version" must be 1 (got 2)`,
    });
    await expect(readJson(join(dir(), 'torn.json'), State, options)).rejects.toMatchObject({
      code: 'json-invalid',
      exitCode: ExitCode.CONFIG_ERROR,
      hint: 'Run fireforge doctor',
    });
  });
});
