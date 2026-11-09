// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { loadTypeScriptApi, type ModuleImporter } from '../typescript-api.js';

const api = { version: '6.0.3', createProgram: (): void => undefined };

/** An importer answering from a table; a name it lacks reads as not installed. */
function importer(table: Record<string, unknown>): ModuleImporter {
  return (name) =>
    name in table ? Promise.resolve(table[name]) : Promise.reject(new Error(`no ${name}`));
}

describe('loadTypeScriptApi', () => {
  it('takes typescript when it carries the compiler API', async () => {
    const loaded = await loadTypeScriptApi(importer({ typescript: api }));
    expect(loaded?.packageName).toBe('typescript');
    expect(loaded?.ts).toBe(api);
  });

  it('falls back to @typescript/typescript6 beside a TypeScript 7 that ships none', async () => {
    const loaded = await loadTypeScriptApi(
      importer({ typescript: { version: '7.0.2' }, '@typescript/typescript6': api })
    );
    expect(loaded?.packageName).toBe('@typescript/typescript6');
  });

  it('reads the API from a default export, as a CommonJS module may arrive', async () => {
    const loaded = await loadTypeScriptApi(importer({ typescript: { default: api } }));
    expect(loaded?.ts).toBe(api);
  });

  it('finds none when nothing installed carries it', async () => {
    expect(await loadTypeScriptApi(importer({ typescript: { version: '7.0.2' } }))).toBeUndefined();
    expect(await loadTypeScriptApi(importer({ typescript: null }))).toBeUndefined();
    expect(await loadTypeScriptApi(importer({}))).toBeUndefined();
  });

  it('loads the real compiler API this repository installs', async () => {
    const loaded = await loadTypeScriptApi();
    expect(typeof loaded?.ts.createProgram).toBe('function');
  });
});
