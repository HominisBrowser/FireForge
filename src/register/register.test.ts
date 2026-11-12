// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { memoryFiles, noTransaction } from '../testing/files.js';
import { applyEdits } from './files.js';
import { planRegister, type RegisterRequest } from './register.js';

const MODULE_DIR = 'browser/modules/mybrowser';
const BASE = { moduleDir: MODULE_DIR, license: 'MPL-2.0' } as const;

/** A request for `path` with the defaults every test shares. */
function request(path: string, options: Partial<RegisterRequest> = {}): RegisterRequest {
  return { path, ...BASE, ...options };
}

const BROWSER_JAR = [
  'browser.jar:',
  '*       content/browser/browser.xhtml    (content/browser.xhtml)',
  '        content/browser/zeta.js          (content/zeta.js)',
  '',
].join('\n');

const SHARED_JAR = [
  '  skin/classic/browser/alpha.css       (../shared/alpha.css)',
  '  skin/classic/browser/omega.css       (../shared/omega.css)',
  '',
].join('\n');

const TOOLKIT_JAR = [
  'toolkit.jar:',
  '   content/global/elements/a.mjs  (widgets/a/a.mjs)',
  '   content/global/elements/z.mjs  (widgets/z/z.mjs)',
  '',
].join('\n');

const BASE_MOZ_BUILD = [
  'BROWSER_CHROME_MANIFESTS += [',
  '    "content/test/alpha/browser.toml",',
  '    "content/test/zed/browser.toml",',
  ']',
  '',
].join('\n');

function engine(extra: Record<string, string> = {}): ReturnType<typeof memoryFiles> {
  return memoryFiles({
    'browser/base/jar.mn': BROWSER_JAR,
    'browser/themes/shared/jar.inc.mn': SHARED_JAR,
    'toolkit/content/jar.mn': TOOLKIT_JAR,
    'browser/base/moz.build': BASE_MOZ_BUILD,
    'browser/modules/moz.build': 'DIRS += [\n    "other",\n]\n',
    ...extra,
  });
}

async function register(
  files: ReturnType<typeof memoryFiles>,
  path: string,
  options: Partial<RegisterRequest> = {}
): Promise<Awaited<ReturnType<typeof planRegister>>> {
  const plan = await planRegister(files, request(path, options));
  await applyEdits(noTransaction, files, plan.edits);
  return plan;
}

describe('which manifest a path belongs in', () => {
  const REGISTRABLE: [string, boolean][] = [
    ['browser/themes/shared/panel.css', true],
    ['browser/base/content/panel.js', true],
    ['browser/base/content/panel.xhtml', true],
    ['browser/base/content/test/foo/browser.toml', true],
    ['browser/components/foo/tests/browser-srd.toml', true],
    ['browser/components/foo/tests/xpcshell-remote.toml', true],
    [`${MODULE_DIR}/Thing.sys.mjs`, true],
    ['toolkit/content/widgets/moz-x/moz-x.mjs', true],
    ['browser/components/foo/test/unit/test_thing.js', true],
    ['browser/base/content/test/foo/browser_thing.js', true],
    ['toolkit/content/tests/widgets/test_thing.html', true],
    ['browser/base/content/panel.inc.xhtml', false],
    ['browser/locales/en-US/browser/panel.ftl', false],
    ['browser/modules/other/Thing.sys.mjs', false],
    ['README.md', false],
  ];
  it.each(REGISTRABLE)('%s: %s', async (path, registrable) => {
    const outcome = await planRegister(memoryFiles(), request(path)).then(
      () => 'planned',
      (error: unknown) => (error as { code?: string }).code
    );
    expect(outcome === 'invalid-argument').toBe(!registrable);
  });

  it('explains why an .inc.xhtml fragment has no entry', async () => {
    await expect(
      planRegister(engine(), { path: 'browser/base/content/x.inc.xhtml', ...BASE })
    ).rejects.toThrow(/wire <name> --dom/);
  });

  it('lists the supported patterns for an unknown path', async () => {
    await expect(planRegister(engine(), { path: 'foo/bar.txt', ...BASE })).rejects.toThrow(
      /Supported patterns[\s\S]*browser\/themes\/shared/
    );
  });
});

describe('jar.mn registration', () => {
  it('adds browser content in sort order with the neighbours layout', async () => {
    const files = engine();
    const plan = await register(files, 'browser/base/content/mid.js');
    expect(files.contents.get('browser/base/jar.mn')).toBe(
      [
        'browser.jar:',
        '*       content/browser/browser.xhtml    (content/browser.xhtml)',
        '        content/browser/mid.js           (content/mid.js)',
        '        content/browser/zeta.js          (content/zeta.js)',
        '',
      ].join('\n')
    );
    expect(plan.manifest).toBe('browser/base/jar.mn');
    expect(plan.entry).toBe('content/browser/mid.js           (content/mid.js)');
    expect(plan.previous).toBe('*       content/browser/browser.xhtml    (content/browser.xhtml)');
  });

  it('is idempotent', async () => {
    const files = engine();
    await register(files, 'browser/base/content/mid.js');
    const again = await planRegister(files, {
      path: 'browser/base/content/mid.js',
      ...BASE,
    });
    expect(again.edits).toEqual([]);
    expect(again.steps[0]?.present).toBe(true);
  });

  it('places the entry after the named one and reports a missing anchor', async () => {
    const files = engine();
    const placed = await register(files, 'browser/base/content/aaa.js', { after: 'zeta.js' });
    expect(placed.previous).toContain('zeta.js');
    const text = files.contents.get('browser/base/jar.mn') ?? '';
    expect(text.indexOf('aaa.js')).toBeGreaterThan(text.indexOf('zeta.js'));
    const fallback = await register(files, 'browser/base/content/bbb.js', { after: 'nothing.js' });
    expect(fallback.afterFallback).toBe(true);
  });

  it('aligns shared CSS with the existing source column', async () => {
    const files = engine();
    await register(files, 'browser/themes/shared/mid.css');
    expect(files.contents.get('browser/themes/shared/jar.inc.mn')).toContain(
      '  skin/classic/browser/mid.css         (../shared/mid.css)'
    );
  });

  it('counts a content/browser entry as the shared CSS registration', async () => {
    const files = engine({
      'browser/themes/shared/jar.inc.mn': '  content/browser/mid.css  (../shared/mid.css)\n',
    });
    const plan = await planRegister(files, {
      path: 'browser/themes/shared/mid.css',
      ...BASE,
    });
    expect(plan.edits).toEqual([]);
  });

  it('registers a toolkit widget file', async () => {
    const files = engine();
    await register(files, 'toolkit/content/widgets/moz-m/moz-m.mjs');
    expect(files.contents.get('toolkit/content/jar.mn')).toContain(
      '   content/global/elements/moz-m.mjs  (widgets/moz-m/moz-m.mjs)'
    );
  });

  it('refuses a missing manifest', async () => {
    await expect(
      planRegister(memoryFiles(), { path: 'browser/base/content/a.js', ...BASE })
    ).rejects.toThrow(/Manifest not found: browser\/base\/jar\.mn/);
  });
});

describe('moz.build registration', () => {
  it('adds a test manifest in sort order', async () => {
    const files = engine();
    await register(files, 'browser/base/content/test/mid/browser.toml');
    expect(files.contents.get('browser/base/moz.build')).toContain(
      '    "content/test/alpha/browser.toml",\n    "content/test/mid/browser.toml",\n    "content/test/zed/browser.toml",'
    );
  });

  it('adds a module to the namespaced list the directory already has', async () => {
    const files = engine({
      [`${MODULE_DIR}/moz.build`]:
        'EXTRA_JS_MODULES.mybrowser += [\n    "A.sys.mjs",\n    "Z.sys.mjs",\n]\n',
    });
    await register(files, `${MODULE_DIR}/M.sys.mjs`);
    expect(files.contents.get(`${MODULE_DIR}/moz.build`)).toBe(
      'EXTRA_JS_MODULES.mybrowser += [\n    "A.sys.mjs",\n    "M.sys.mjs",\n    "Z.sys.mjs",\n]\n'
    );
  });

  it('falls back to a plain EXTRA_JS_MODULES list', async () => {
    const files = engine({
      [`${MODULE_DIR}/moz.build`]: 'EXTRA_JS_MODULES += [\n    "A.sys.mjs",\n]\n',
    });
    await register(files, `${MODULE_DIR}/B.sys.mjs`);
    expect(files.contents.get(`${MODULE_DIR}/moz.build`)).toContain('"B.sys.mjs"');
  });

  it('does not treat the value in another variable as registered', async () => {
    const files = engine({
      [`${MODULE_DIR}/moz.build`]:
        'EXTRA_COMPONENTS += [\n    "A.sys.mjs",\n]\nEXTRA_JS_MODULES += [\n    "B.sys.mjs",\n]\n',
    });
    const plan = await planRegister(files, {
      path: `${MODULE_DIR}/A.sys.mjs`,
      ...BASE,
    });
    expect(plan.edits).toHaveLength(1);
  });

  it('refuses --after where entries are kept sorted', async () => {
    await expect(
      planRegister(engine(), {
        path: 'browser/base/content/test/mid/browser.toml',
        ...BASE,
        after: 'x',
      })
    ).rejects.toThrow(/--after does not apply/);
  });

  it('creates a missing module manifest and wires its parent directory', async () => {
    const files = engine();
    const plan = await register(files, `${MODULE_DIR}/New.sys.mjs`, { createManifest: true });
    expect(files.contents.get(`${MODULE_DIR}/moz.build`)).toBe(
      [
        '# This Source Code Form is subject to the terms of the Mozilla Public',
        '# License, v. 2.0. If a copy of the MPL was not distributed with this',
        '# file, You can obtain one at http://mozilla.org/MPL/2.0/.',
        '',
        'EXTRA_JS_MODULES.mybrowser += [',
        '    "New.sys.mjs",',
        ']',
        '',
      ].join('\n')
    );
    expect(files.contents.get('browser/modules/moz.build')).toBe(
      'DIRS += [\n    "mybrowser",\n    "other",\n]\n'
    );
    expect(plan.steps.map((step) => step.path)).toEqual([
      `${MODULE_DIR}/moz.build`,
      'browser/modules/moz.build',
    ]);
  });

  it('writes the project license on a moz.build it creates', async () => {
    const files = engine();
    await register(files, `${MODULE_DIR}/New.sys.mjs`, {
      createManifest: true,
      license: 'EUPL-1.2',
    });
    expect(files.contents.get(`${MODULE_DIR}/moz.build`)).toMatch(
      /^# SPDX-License-Identifier: EUPL-1\.2\n\nEXTRA_JS_MODULES/
    );
  });

  it('reports the line of a module already listed, not of a comment naming it', async () => {
    const files = engine({
      [`${MODULE_DIR}/moz.build`]:
        '# Thing.sys.mjs moved here\nEXTRA_JS_MODULES.mybrowser += [\n    "Thing.sys.mjs",\n]\n',
    });
    const plan = await planRegister(files, request(`${MODULE_DIR}/Thing.sys.mjs`));
    expect(plan.edits).toEqual([]);
    expect(plan.entry).toBe('"Thing.sys.mjs",');
  });

  it('creates intermediate moz.build files up to the nearest existing one', async () => {
    const files = memoryFiles({ 'browser/moz.build': 'DIRS += [\n    "base",\n]\n' });
    await register(files, 'browser/modules/mybrowser/New.sys.mjs', { createManifest: true });
    expect(files.contents.get('browser/modules/moz.build')).toContain(
      'DIRS += [\n    "mybrowser",\n]'
    );
    expect(files.contents.get('browser/moz.build')).toContain('"modules"');
  });

  it('refuses to wire a chain with no moz.build above it', async () => {
    await expect(
      planRegister(memoryFiles(), {
        path: `${MODULE_DIR}/New.sys.mjs`,
        ...BASE,
        createManifest: true,
      })
    ).rejects.toThrow(/No moz\.build exists above/);
  });

  it('says how to create a missing module manifest', async () => {
    await expect(
      planRegister(engine(), { path: `${MODULE_DIR}/New.sys.mjs`, ...BASE })
    ).rejects.toThrow(/Manifest not found/);
  });
});

describe('test manifest registration', () => {
  const PREFS = 'browser/components/preferences';

  it('finds a manifest any moz.build above it already lists', async () => {
    const files = engine({
      [`${PREFS}/moz.build`]:
        'BROWSER_CHROME_MANIFESTS += [\n    "tests/aiFeatures/browser-srd.toml",\n]\n',
    });
    const plan = await planRegister(files, request(`${PREFS}/tests/aiFeatures/browser-srd.toml`));
    expect(plan.edits).toEqual([]);
    expect(plan.manifest).toBe(`${PREFS}/moz.build`);
    expect(plan.entry).toBe('"tests/aiFeatures/browser-srd.toml",');
  });

  it('adds a manifest to the nearest moz.build that lists its flavour', async () => {
    const files = engine({ 'browser/base/content/moz.build': 'DIRS += []\n' });
    const plan = await register(files, 'browser/base/content/test/mid/browserNova.toml');
    expect(plan.manifest).toBe('browser/base/moz.build');
    expect(files.contents.get('browser/base/moz.build')).toContain(
      '    "content/test/mid/browserNova.toml",\n    "content/test/zed/browser.toml",'
    );
  });

  it('puts a browser test in its browser.toml and a test page in the manifest asked for', async () => {
    const files = engine({
      'browser/base/content/test/alpha/browser.toml': '[DEFAULT]\n\n["browser_a.js"]\n',
      'toolkit/content/moz.build': 'MOCHITEST_CHROME_MANIFESTS += ["tests/chrome/chrome.toml"]\n',
    });
    await register(files, 'browser/base/content/test/alpha/browser_b.js');
    expect(files.contents.get('browser/base/content/test/alpha/browser.toml')).toContain(
      '["browser_a.js"]\n\n["browser_b.js"]'
    );
    const page = await register(files, 'toolkit/content/tests/widgets/test_x.html', {
      testManifest: 'chrome.toml',
      createManifest: true,
      manifestDefaults: { 'support-files': ['head.js'] },
    });
    expect(files.contents.get('toolkit/content/tests/widgets/chrome.toml')).toBe(
      '# This Source Code Form is subject to the terms of the Mozilla Public\n' +
        '# License, v. 2.0. If a copy of the MPL was not distributed with this\n' +
        '# file, You can obtain one at http://mozilla.org/MPL/2.0/.\n\n' +
        '[DEFAULT]\nsupport-files = ["head.js"]\n\n["test_x.html"]\n'
    );
    expect(page.steps.map((step) => [step.path, step.change])).toEqual([
      ['toolkit/content/tests/widgets/chrome.toml', '["test_x.html"] (new file)'],
      ['toolkit/content/moz.build', 'MOCHITEST_CHROME_MANIFESTS += ["tests/widgets/chrome.toml"]'],
    ]);
  });
});

describe('xpcshell registration', () => {
  const DIR = 'browser/components/foo/test/unit';
  const TOML = [
    '[DEFAULT]',
    '',
    '["test_alpha.js"]',
    '',
    '# the zebra',
    '["test_zebra.js"]',
    '',
  ].join('\n');

  it('adds a section in sort order ahead of the comment that introduces the next one', async () => {
    const files = engine({ [`${DIR}/xpcshell.toml`]: TOML });
    await register(files, `${DIR}/test_mid.js`);
    expect(files.contents.get(`${DIR}/xpcshell.toml`)).toBe(
      [
        '[DEFAULT]',
        '',
        '["test_alpha.js"]',
        '',
        '["test_mid.js"]',
        '',
        '# the zebra',
        '["test_zebra.js"]',
        '',
      ].join('\n')
    );
  });

  it('takes --after and is idempotent', async () => {
    const files = engine({ [`${DIR}/xpcshell.toml`]: TOML });
    const placed = await register(files, `${DIR}/test_new.js`, { after: 'test_alpha.js' });
    expect(placed.previous).toBe('["test_alpha.js"]');
    const again = await planRegister(files, { path: `${DIR}/test_new.js`, ...BASE });
    expect(again.edits).toEqual([]);
  });

  it('creates the manifest and wires XPCSHELL_TESTS_MANIFESTS into the nearest moz.build', async () => {
    const files = engine({ 'browser/components/foo/moz.build': 'DIRS += [\n    "x",\n]\n' });
    await register(files, `${DIR}/test_one.js`, { createManifest: true, license: 'EUPL-1.2' });
    expect(files.contents.get(`${DIR}/xpcshell.toml`)).toBe(
      '# SPDX-License-Identifier: EUPL-1.2\n\n[DEFAULT]\n\n["test_one.js"]\n'
    );
    expect(files.contents.get('browser/components/foo/moz.build')).toContain(
      'XPCSHELL_TESTS_MANIFESTS += [\n    "test/unit/xpcshell.toml",\n]'
    );
  });

  it('says how to create a missing manifest', async () => {
    await expect(planRegister(engine(), { path: `${DIR}/test_one.js`, ...BASE })).rejects.toThrow(
      /Manifest not found/
    );
  });
});

describe('planning', () => {
  it('changes nothing until the edits are applied', async () => {
    const files = engine();
    const before = new Map(files.contents);
    await planRegister(files, { path: 'browser/base/content/mid.js', ...BASE });
    expect(files.contents).toEqual(before);
  });

  it('can insist that the file exists', async () => {
    await expect(
      planRegister(engine(), {
        path: 'browser/base/content/mid.js',
        ...BASE,
        mustExist: true,
      })
    ).rejects.toThrow(/File not found: browser\/base\/content\/mid\.js/);
  });
});
