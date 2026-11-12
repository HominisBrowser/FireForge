// SPDX-License-Identifier: EUPL-1.2
/** Real Firefox manifests, copied verbatim into `__fixtures__/`. */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readText } from '../kernel/fs.js';
import type { JarEntry } from './jar.js';
import { insertJarEntry, parseJar, updateJarEntries } from './jar.js';
import {
  addToMozBuildList,
  findMozBuildLists,
  mozBuildSortViolations,
  parseMozBuild,
  removeFromMozBuildList,
} from './mozbuild.js';
import { manifestKind } from './paths.js';
import {
  addTest,
  listTests,
  parseTestManifest,
  removeTest,
  supportEntries,
} from './testManifest.js';
import { joinSource, splitSource } from './text.js';

/** Removes the entries `where` selects. */
const drop = (
  text: string,
  where: (entry: JarEntry) => boolean
): ReturnType<typeof updateJarEntries> =>
  updateJarEntries(text, (entry) => (where(entry) ? null : undefined));

/** Whether a list of `variable` the selector allows holds `value`. */
const contains = (
  text: string,
  variable: string,
  value: string,
  selector: Parameters<typeof findMozBuildLists>[2] = {}
): boolean =>
  findMozBuildLists(text, variable, selector).some((list) =>
    list.items.some((item) => item.value === value)
  );

const dir = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const load = (name: string): Promise<string> => readText(join(dir, name));

const FIXTURES = [
  'browser-base.moz.build',
  'browser-components.moz.build',
  'browser-extensions.jar.mn',
  'browser-locales.jar.mn',
  'caps-browser.toml',
  'general-browser.toml',
  'toolkit-content.jar.mn',
  'toolkit-locales.jar.mn',
  'xpcshell-common.toml',
];

describe('real manifests', () => {
  it.each(FIXTURES)('%s round-trips byte for byte through every parser', async (name) => {
    const text = await load(name);
    expect(joinSource(splitSource(text))).toBe(text);
    const kind = name.endsWith('.mn')
      ? 'jar'
      : name.endsWith('.build')
        ? 'moz-build'
        : 'test-manifest';
    expect(manifestKind(name.replace(/^[^.]+\./, ''))).toBe(
      kind === 'test-manifest' ? undefined : kind
    );
    if (kind === 'jar') expect(joinSource(parseJar(text).lines)).toBe(text);
    if (kind === 'moz-build') expect(joinSource(parseMozBuild(text).lines)).toBe(text);
    if (kind === 'test-manifest')
      expect(joinSource(parseTestManifest(name, text).lines)).toBe(text);
  });

  it('parses the locale jar: headers, a localization section and chrome manifest lines', async () => {
    const jar = parseJar(await load('browser-locales.jar.mn'));
    expect(jar.balanced).toBe(true);
    expect(jar.headers.map((h) => [h.base, h.jar])).toEqual([
      ['localization', '@AB_CD@.jar'],
      [undefined, '@AB_CD@.jar'],
    ]);
    expect(jar.chromeManifests.map((m) => m.args.slice(0, 3))).toEqual([
      ['locale', 'browser', '@AB_CD@'],
      ['locale', 'browser-region', '@AB_CD@'],
    ]);
    const wildcard = jar.entries.find((e) => e.target === 'browser');
    expect(wildcard).toMatchObject({ source: 'browser/**/*.ftl', localized: true, section: 1 });
    expect(jar.entries.every((e) => e.source !== undefined)).toBe(true);
  });

  it('reads flags, preprocessor regions and sourceless entries in a toolkit jar.mn', async () => {
    const jar = parseJar(await load('toolkit-content.jar.mn'));
    expect(jar.entries.length).toBeGreaterThan(50);
    expect(jar.entries.some((e) => e.flags.includes('*'))).toBe(true);
    expect(jar.entries.some((e) => e.conditional)).toBe(true);
    expect(jar.entries.filter((e) => e.source === undefined || e.source !== '').length).toBe(
      jar.entries.length
    );
  });

  it('inserts into a real jar.mn and removing the entry restores the file exactly', async () => {
    const text = await load('toolkit-content.jar.mn');
    const placed = insertJarEntry(text, {
      target: 'content/global/elements/moz-zzz-new.mjs',
      source: 'widgets/moz-zzz-new/moz-zzz-new.mjs',
    });
    expect(placed.changed).toBe(true);
    expect(parseJar(placed.text).entries.some((e) => e.target.endsWith('moz-zzz-new.mjs'))).toBe(
      true
    );
    expect(drop(placed.text, (e) => e.target.endsWith('moz-zzz-new.mjs')).text).toBe(text);
  });

  it('adds to the locale jar.mn, naming an ambiguous second jar section', async () => {
    const text = await load('browser-locales.jar.mn');
    const placed = insertJarEntry(
      text,
      {
        target: 'locale/browser/zzz.properties',
        source: 'chrome/browser/zzz.properties',
        localized: true,
      },
      { jar: '@AB_CD@.jar' }
    );
    expect(placed.text).toContain('(%chrome/browser/zzz.properties)');
    expect(() => insertJarEntry(text, { target: 'other/x', source: 'x' })).toThrow(
      /several jar sections/
    );
  });

  it('reads the lists of a real moz.build, conditional and namespaced ones included', async () => {
    const text = await load('browser-components.moz.build');
    expect(contains(text, 'EXTRA_JS_MODULES', 'BrowserGlue.sys.mjs')).toBe(true);
    expect(contains(text, 'EXTRA_JS_MODULES', 'StartupRecorder.sys.mjs')).toBe(false);
    expect(
      contains(text, 'EXTRA_JS_MODULES', 'StartupRecorder.sys.mjs', {
        conditional: true,
      })
    ).toBe(true);
    expect(contains(text, 'DIRS', 'touchbar', { conditional: true })).toBe(true);
    expect(mozBuildSortViolations(text)).toEqual([]);
  });

  it('adds to and removes from a real moz.build without disturbing the rest', async () => {
    const text = await load('browser-base.moz.build');
    const value = 'content/test/homestead-new/browser.toml';
    const placed = addToMozBuildList(text, 'BROWSER_CHROME_MANIFESTS', value);
    const rows = placed.text.split('\n');
    expect(rows[placed.line]).toBe(`    "${value}",`);
    expect(rows[placed.line - 1]).toBe('    "content/test/historySwipeAnimation/browser.toml",');
    expect(removeFromMozBuildList(placed.text, 'BROWSER_CHROME_MANIFESTS', value).text).toBe(text);
  });

  it('lists the tests and support files of real test manifests', async () => {
    const general = await load('general-browser.toml');
    const support = supportEntries('browser/base/content/test/general/browser.toml', general);
    expect(support.slice(0, 3).map((e) => [e.key, e.entry, e.test])).toEqual([
      ['support-files', 'app_bug575561.html', undefined],
      ['support-files', 'app_subframe_bug575561.html', undefined],
      ['support-files', 'audio.ogg', undefined],
    ]);
    const common = await load('xpcshell-common.toml');
    expect(listTests('toolkit/test/xpcshell-common.toml', common)[0]).toBe(
      'toolkit/test/test_ChannelWrapper.js'
    );
    expect(
      parseTestManifest('x/xpcshell-common.toml', common).sections[1]?.keys.map((k) => k.name)
    ).toEqual(['prefs', 'requesttimeoutfactor']);
  });

  it('adds a test to a real manifest in byte order and removing it restores the file', async () => {
    const common = await load('xpcshell-common.toml');
    const placed = addTest('toolkit/test/xpcshell-common.toml', common, 'test_Homestead.js');
    const rows = placed.text.split('\n');
    expect(rows[placed.line]).toBe('["test_Homestead.js"]');
    expect(rows[placed.line - 2]).toBe('["test_GuardSets_propagation.js"]');
    expect(removeTest('x/xpcshell-common.toml', placed.text, 'test_Homestead.js').text).toBe(
      common
    );

    const caps = await load('caps-browser.toml');
    const appended = addTest('caps/browser.toml', caps, 'browser_zzz.js');
    expect(appended.text).toBe(`${caps}\n["browser_zzz.js"]\n`);
    expect(removeTest('caps/browser.toml', appended.text, 'browser_zzz.js').text).toBe(caps);
  });
});
