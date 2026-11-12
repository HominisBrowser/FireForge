// SPDX-License-Identifier: EUPL-1.2
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ExitCode, type FireForgeError } from '../kernel/errors.js';
import { useTempDir } from '../testing/temp.js';
import {
  coerceConfigValue,
  configKeys,
  getConfigValue,
  loadConfig,
  setConfigValue,
} from './index.js';

const dir = useTempDir();

const DOCUMENT = `{
  "name": "Mine",
  "vendor": "Example",
  "appId": "org.example.mine",
  "binaryName": "mine",
  "firefox": { "version": "153.4.0esr", "product": "firefox-esr" },
  "patchLint": { "rawColorAllowlist": ["a.css", "b.css"], "fileSizeMetric": "code" },
  "typecheck": {
    "projects": ["engine/browser/jsconfig.json"]
  }
}
`;

async function project(text = DOCUMENT): Promise<string> {
  await writeFile(join(dir(), 'fireforge.json'), text);
  return dir();
}

const read = (): Promise<string> => readFile(join(dir(), 'fireforge.json'), 'utf8');

async function failure(promise: Promise<unknown>): Promise<FireForgeError> {
  return promise.then(
    () => {
      throw new Error('expected a failure');
    },
    (error: unknown) => error as FireForgeError
  );
}

describe('loadConfig', () => {
  it('returns the validated configuration with defaults applied', async () => {
    const config = await loadConfig(await project());
    expect(config.firefox.version).toBe('153.4.0esr');
    expect(config.patchLint.fileSizeMetric).toBe('code');
    expect(config.patchLint.checkJs).toBe(false);
    expect(config.typecheck?.undefinedIdentifiers).toBe('warning');
  });

  it('refuses a missing file with exit code 2 and the setup hint', async () => {
    const error = await failure(loadConfig(dir()));
    expect(error.code).toBe('config-missing');
    expect(error.exitCode).toBe(ExitCode.CONFIG_ERROR);
    expect(error.hint).toContain('fireforge setup');
  });

  it('refuses text that is not JSON, comments included, naming the file', async () => {
    const error = await failure(loadConfig(await project('{ // no comments\n}')));
    expect(error.code).toBe('config-invalid');
    expect(error.exitCode).toBe(ExitCode.CONFIG_ERROR);
    expect(error.message).toContain(join(dir(), 'fireforge.json'));
  });

  it('refuses a document that is not an object', async () => {
    const error = await failure(loadConfig(await project('[]')));
    expect(error.code).toBe('config-invalid');
  });

  it('reports every problem at once, by key path, with the nearest key', async () => {
    const broken = DOCUMENT.replace('"fileSizeMetric"', '"fileSizeMetrik"').replace(
      '"mine"',
      '"Mine Browser"'
    );
    const error = await failure(loadConfig(await project(broken)));
    expect(error.code).toBe('config-invalid');
    expect(error.exitCode).toBe(ExitCode.CONFIG_ERROR);
    expect(error.message).toContain('"binaryName" must be a lowercase letter');
    expect(error.message).toContain(
      '"patchLint.fileSizeMetrik" is not a known key. Did you mean "fileSizeMetric"?'
    );
  });
});

describe('getConfigValue', () => {
  it('reads a value as written, with the key type, documentation and default', async () => {
    const root = await project();
    const version = await getConfigValue(root, 'firefox.version');
    expect(version.value).toBe('153.4.0esr');
    expect(version.doc).toContain('Firefox release');
    const ports = await getConfigValue(root, 'test.mochitestPorts');
    expect(ports.value).toBeUndefined();
    expect(ports.defaultValue).toBe('fixed');
    expect((await getConfigValue(root, 'patchLint.rawColorAllowlist[1]')).value).toBe('b.css');
    expect((await getConfigValue(root, 'patchLint.rawColorAllowlist.0')).value).toBe('a.css');
  });

  it('refuses a key the schema does not declare, naming the nearest one', async () => {
    const error = await failure(getConfigValue(await project(), 'firefox.verison'));
    expect(error.code).toBe('config-unknown-key');
    expect(error.exitCode).toBe(ExitCode.INVALID_ARGUMENT);
    expect(error.hint).toBe('Did you mean "firefox.version"?');
  });
});

describe('coerceConfigValue', () => {
  it.each([
    ['build.jobs', '8', 8],
    ['firefox.version', '153.5.0esr', '153.5.0esr'],
    ['firefox.allowUnverifiedDownload', 'true', true],
    ['patchLint.fileSizeMetric', 'code', 'code'],
    ['patchLint.rawColorAllowlist', '["x.css"]', ['x.css']],
    ['name', '128', '128'],
    ['name', '"quoted"', 'quoted'],
    ['typecheck.projectOverrides["a/jsconfig.json"]', 'null', null],
  ])('reads %s %s as %j', (key, text, expected) => {
    expect(coerceConfigValue(key, text)).toEqual(expected);
  });

  it.each([
    ['build.jobs', 'four', '"build.jobs" must be an integer of at least 1 (got "four")'],
    ['build.jobs', '0', '"build.jobs" must be an integer of at least 1 (got 0)'],
    ['firefox.version', 'latest', '"firefox.version" must be a Firefox version'],
  ])('refuses %s %s', (key, text, expected) => {
    let caught: unknown;
    try {
      coerceConfigValue(key, text);
    } catch (error: unknown) {
      caught = error;
    }
    expect((caught as FireForgeError).code).toBe('config-invalid-value');
    expect((caught as FireForgeError).message).toContain(expected);
  });

  it.each(['__proto__.polluted', 'patchLint.constructor', 'gate..lanes', 'gate[x]'])(
    'refuses the key path %s',
    (key) => {
      expect(() => coerceConfigValue(key, '1')).toThrow(
        expect.objectContaining({ code: 'config-unknown-key' }) as Error
      );
    }
  );
});

describe('setConfigValue', () => {
  it('rewrites only the changed value, keeping one-line objects and key order', async () => {
    const root = await project();
    const edit = await setConfigValue(root, 'firefox.version', '153.5.0esr');
    expect(edit).toEqual({ path: 'firefox.version', value: '153.5.0esr', changed: true });
    expect(await read()).toBe(DOCUMENT.replace('153.4.0esr', '153.5.0esr'));
  });

  it('inserts a missing key and creates the objects on its way', async () => {
    const root = await project();
    await setConfigValue(root, 'build.jobs', '12');
    await setConfigValue(root, 'patchLint.rawColorAllowlist[2]', 'c.css');
    const text = await read();
    expect(text).toContain('"rawColorAllowlist": ["a.css", "b.css", "c.css"]');
    expect(text).toContain('"build": {\n    "jobs": 12\n  }');
    expect((await loadConfig(root)).build?.jobs).toBe(12);
  });

  it('sets a dictionary key that holds dots through the bracket form', async () => {
    const root = await project();
    await setConfigValue(
      root,
      'typecheck.projectOverrides["engine/browser/jsconfig.json"]',
      'x.d.ts'
    );
    expect((await loadConfig(root)).typecheck?.projectOverrides).toEqual({
      'engine/browser/jsconfig.json': 'x.d.ts',
    });
  });

  it('leaves the file untouched when it already holds the value', async () => {
    const root = await project();
    const edit = await setConfigValue(root, 'patchLint.fileSizeMetric', 'code');
    expect(edit.changed).toBe(false);
    expect(await read()).toBe(DOCUMENT);
  });

  it('validates the whole document, refusing a value a cross-field rule rejects', async () => {
    const root = await project();
    const error = await failure(setConfigValue(root, 'patchLint.checkJsStrict', 'true'));
    expect(error.code).toBe('config-invalid-value');
    expect(error.exitCode).toBe(ExitCode.INVALID_ARGUMENT);
    expect(error.message).toBe('"patchLint" sets checkJsStrict, which needs checkJs: true');
    expect(await read()).toBe(DOCUMENT);
  });

  it('refuses to change the mode, naming the command that does it in each direction', async () => {
    const root = await project();
    const toSource = await failure(setConfigValue(root, 'mode', 'source'));
    expect(toSource.code).toBe('config-mode-switch');
    expect(toSource.exitCode).toBe(ExitCode.INVALID_ARGUMENT);
    expect(toSource.message).toContain('"mode" cannot be set to "source" with "config set"');
    expect(toSource.hint).toContain('fireforge migrate --to-source');
    expect(await read()).toBe(DOCUMENT);
    expect(await setConfigValue(root, 'mode', 'patches')).toMatchObject({ changed: true });

    const source = { root: 'src', metadataRoot: 'upstream', pristineCommit: 'a'.repeat(40) };
    const sourceRoot = await project(
      JSON.stringify({ ...(JSON.parse(DOCUMENT) as object), mode: 'source', source })
    );
    const back = await failure(setConfigValue(sourceRoot, 'mode', 'patches'));
    expect(back.code).toBe('config-mode-switch');
    expect(back.hint).toMatch(/fireforge export.*set "mode" to "patches" and remove "source"/);
    expect(await setConfigValue(sourceRoot, 'mode', 'source')).toMatchObject({ changed: false });
  });

  it('refuses an index past the end of a list', async () => {
    const error = await failure(
      setConfigValue(await project(), 'patchLint.rawColorAllowlist[5]', 'x')
    );
    expect(error.code).toBe('config-unknown-key');
    expect(await read()).toBe(DOCUMENT);
  });

  it('loses no edit when several run at once', async () => {
    const root = await project();
    await Promise.all([
      setConfigValue(root, 'build.jobs', '6'),
      setConfigValue(root, 'license', 'MPL-2.0'),
      setConfigValue(root, 'markerComment', 'MINE'),
    ]);
    const config = await loadConfig(root);
    expect([config.build?.jobs, config.license, config.markerComment]).toEqual([
      6,
      'MPL-2.0',
      'MINE',
    ]);
  });
});

describe('configKeys', () => {
  it('lists every key with its type, documentation and default', () => {
    const keys = new Map(configKeys().map((key) => [key.path, key]));
    expect(keys.get('firefox')).toMatchObject({ container: true, required: true });
    expect(keys.get('mode')).toMatchObject({ defaultValue: 'patches', required: false });
    expect(keys.get('gate.lanes')?.type).toMatch(/^an array of/);
    expect(keys.has('proof')).toBe(false);
    expect(keys.has('slots')).toBe(false);
  });
});
