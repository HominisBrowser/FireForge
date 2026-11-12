// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { manifestKind, resolveManifestPath, testManifestFlavor } from './paths.js';
import { manifestReferences, manifestReferencesFile } from './references.js';

describe('manifestKind', () => {
  it.each([
    ['browser/base/jar.mn', 'jar'],
    ['browser/themes/shared/jar.inc.mn', 'jar'],
    ['browser\\base\\jar.mn', 'jar'],
    ['browser/base/moz.build', 'moz-build'],
    ['moz.build', 'moz-build'],
    ['a/xpcshell.toml', 'test-manifest'],
    ['a/xpcshell.ini', 'test-manifest'],
    ['a/browser.toml', 'test-manifest'],
    ['a/mochitest.ini', 'test-manifest'],
    ['a/chrome.toml', 'test-manifest'],
    ['a/a11y.toml', 'test-manifest'],
    ['a\\browser.ini', 'test-manifest'],
    ['Cargo.toml', undefined],
    ['taskcluster/kinds/x.toml', undefined],
    ['a/browserSidebarRevamp.toml', 'test-manifest'],
    ['a/browserNova.toml', 'test-manifest'],
    ['a/browser-srd.toml', 'test-manifest'],
    ['a/xpcshell-remote.toml', 'test-manifest'],
    ['a/xpcshell_snap.toml', 'test-manifest'],
    ['a/mochitest-common.toml', 'test-manifest'],
    ['a/chrome-dFPI.toml', 'test-manifest'],
    ['a/perftest.toml', undefined],
    ['a/browsers.toml', undefined],
    ['browser/themes/shared/desktop-jar.inc.mn', 'jar'],
    ['browser/app/addon-jar.mn', 'jar'],
    ['toolkit/themes/shared/minimal-toolkit.jar.inc.mn', 'jar'],
    ['toolkit/themes/shared/mozapps.inc.mn', 'jar'],
    ['security/nss/lib/manifest.mn', undefined],
    ['allowed-dupes.mn', undefined],
    ['a/moz.build.in', undefined],
    ['a/notjar.mn', undefined],
  ])('%s is %s', (path, kind) => {
    expect(manifestKind(path)).toBe(kind);
  });
});

describe('testManifestFlavor', () => {
  it.each([
    ['a/browser.toml', 'browser-chrome'],
    ['a/browserNova.toml', 'browser-chrome'],
    ['a/xpcshell-remote.toml', 'xpcshell'],
    ['a/mochitest.ini', 'mochitest'],
    ['a/chrome-dFPI.toml', 'chrome'],
    ['a/a11y.toml', 'a11y'],
    ['a/eval.toml', undefined],
  ])('%s is %s', (path, flavor) => {
    expect(testManifestFlavor(path)).toBe(flavor);
  });
});

describe('resolveManifestPath', () => {
  const manifest = 'browser/modules/test/unit/xpcshell.toml';
  const resolve = (written: string, directories = false): ReturnType<typeof resolveManifestPath> =>
    resolveManifestPath(manifest, written, { directories });

  it('resolves a plain path against the manifest directory', () => {
    const matcher = resolve('fixtures/schema.sqlite');
    expect(matcher?.exact).toBe('browser/modules/test/unit/fixtures/schema.sqlite');
    expect(matcher?.matches('browser/modules/test/unit/fixtures/schema.sqlite')).toBe(true);
    expect(matcher?.matches('browser/modules/other/fixtures/schema.sqlite')).toBe(false);
  });

  it('expands * inside one segment, ? as one character, and ** across segments', () => {
    const star = resolve('fixtures/*.sqlite');
    expect(star?.matches('browser/modules/test/unit/fixtures/schema-v32.sqlite')).toBe(true);
    expect(star?.matches('browser/modules/test/unit/fixtures/deep/schema.sqlite')).toBe(false);
    expect(star?.exact).toBeUndefined();
    expect(resolve('f?.js')?.matches('browser/modules/test/unit/fa.js')).toBe(true);
    expect(resolve('**/*.sqlite')?.matches('browser/modules/test/unit/a/b/c.sqlite')).toBe(true);
  });

  it('resolves ../ inside the tree and declines it outside', () => {
    expect(resolve('../shared/head.js')?.matches('browser/modules/test/shared/head.js')).toBe(true);
    expect(resolve('../../../../../escape.sqlite')).toBeUndefined();
    expect(resolve('../../../..')).toBeUndefined();
    expect(resolve('..')?.exact).toBe('browser/modules/test');
  });

  it('reads / and !/ as the engine root and declines other ! paths', () => {
    expect(resolve('/toolkit/x.js')?.exact).toBe('toolkit/x.js');
    expect(resolve('!/toolkit/x.js')?.exact).toBe('toolkit/x.js');
    expect(resolve('!generated.js')).toBeUndefined();
  });

  it('declines substitutions, whitespace and empty paths', () => {
    expect(resolve('locale/@AB_CD@/x')).toBeUndefined();
    expect(resolve('a b')).toBeUndefined();
    expect(resolve('')).toBeUndefined();
    expect(resolve('about-logo@2x.png')?.exact).toBe('browser/modules/test/unit/about-logo@2x.png');
  });

  it('lets a directory cover everything beneath it only when asked', () => {
    expect(resolve('data/')?.matches('browser/modules/test/unit/data/a/b.txt')).toBe(false);
    expect(resolve('data/', true)?.matches('browser/modules/test/unit/data/a/b.txt')).toBe(true);
    expect(resolve('data', true)?.matches('browser/modules/test/unit/database.txt')).toBe(false);
  });

  it('accepts Windows separators in the manifest path', () => {
    expect(resolveManifestPath('a\\b\\jar.mn', 'x.js')?.exact).toBe('a/b/x.js');
  });
});

describe('manifestReferences', () => {
  it('dispatches on the manifest format', () => {
    expect(manifestReferencesFile('a/jar.mn', 'x.jar:\n  t/x.js (x.js)\n', 'a/x.js')).toBe(true);
    expect(manifestReferencesFile('a/moz.build', 'X += ["x.js"]\n', 'a/x.js')).toBe(true);
    expect(manifestReferencesFile('a/browser.toml', '["browser_x.js"]\n', 'a/browser_x.js')).toBe(
      true
    );
    expect(
      manifestReferencesFile(
        'a/xpcshell.toml',
        '[DEFAULT]\nsupport-files = ["data/"]\n',
        'a/data/f.txt'
      )
    ).toBe(true);
  });

  it('reads nothing from a file that is not a manifest', () => {
    expect(manifestReferences('a/Cargo.toml', '["x.js"]\nsupport-files = ["y"]\n')).toEqual([]);
  });

  it('does not attribute a file to a manifest that names a neighbour', () => {
    expect(manifestReferencesFile('a/moz.build', 'X += ["xy.js"]\n', 'a/x.js')).toBe(false);
    expect(manifestReferencesFile('a/jar.mn', 'x.jar:\n  t/x.js (xy.js)\n', 'a/x.js')).toBe(false);
  });
});
