// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { memoryFiles, noTransaction } from '../testing/files.js';
import {
  componentSources,
  removeTestScaffold,
  renameTag,
  type ScaffoldProject,
  testScaffold,
  writeTestScaffold,
} from './scaffold.js';

const PROJECT: ScaffoldProject = { moduleDir: 'browser/modules/acme', license: 'EUPL-1.2' };
const BASE_MOZ_BUILD = 'BROWSER_CHROME_MANIFESTS += [\n    "content/test/other/browser.toml",\n]\n';

describe('componentSources', () => {
  it('writes a module and stylesheet under the project header, and a Fluent file when it owns one', () => {
    const sources = componentSources({
      name: 'moz-acme-chip',
      description: 'A chip */ that closes',
      license: 'EUPL-1.2',
      ftl: 'toolkit/global/moz-acme-chip.ftl',
      ownFtl: true,
    });
    expect([...sources.keys()]).toEqual([
      'moz-acme-chip.mjs',
      'moz-acme-chip.css',
      'moz-acme-chip.ftl',
    ]);
    const mjs = sources.get('moz-acme-chip.mjs') ?? '';
    expect(mjs.startsWith('/* SPDX-License-Identifier: EUPL-1.2 */')).toBe(true);
    expect(mjs).toContain('export default class MozAcmeChip extends MozLitElement');
    expect(mjs).toContain('insertFTLIfNeeded("toolkit/global/moz-acme-chip.ftl")');
    expect(mjs).toContain('A chip *\\/ that closes');
    expect(sources.get('moz-acme-chip.ftl')).toMatch(/^# SPDX-License-Identifier: EUPL-1\.2/);
  });

  it('leaves out the Fluent load and file of a component that is not localized', () => {
    const sources = componentSources({
      name: 'moz-acme-chip',
      description: '',
      license: 'MPL-2.0',
      ftl: undefined,
      ownFtl: false,
    });
    expect([...sources.keys()]).toEqual(['moz-acme-chip.mjs', 'moz-acme-chip.css']);
    expect(sources.get('moz-acme-chip.mjs')).not.toContain('insertFTLIfNeeded');
  });
});

describe('testScaffold', () => {
  it.each([
    [
      'browser-chrome',
      'browser/base/content/test/acme/browser_acme_chip.js',
      'browser/base/content/test/acme/head.js',
      undefined,
    ],
    ['mochikit', 'toolkit/content/tests/widgets/test_moz-acme-chip.html', undefined, 'chrome.toml'],
    [
      'xpcshell',
      'browser/base/content/test/acme-xpcshell/moz-acme-chip/test_moz_acme_chip_packaged.js',
      undefined,
      undefined,
    ],
  ] as const)('places a %s test', (style, test, support, manifest) => {
    const scaffold = testScaffold('moz-acme-chip', 'acme', style, 'EUPL-1.2');
    expect(scaffold.test.path).toBe(test);
    expect(scaffold.support?.path).toBe(support);
    expect(scaffold.manifest).toBe(manifest);
  });
});

describe('writeTestScaffold and removeTestScaffold', () => {
  it('registers a browser-chrome test in a new manifest wired into the moz.build that lists the flavour', async () => {
    const files = memoryFiles({
      'browser/base/moz.build': BASE_MOZ_BUILD,
      'browser/base/content/moz.build': 'with Files("**"):\n    BUG_COMPONENT = ("A", "B")\n',
    });
    const scaffold = testScaffold('moz-acme-chip', 'acme', 'browser-chrome', 'EUPL-1.2');
    const notes = await writeTestScaffold(files, noTransaction, scaffold, PROJECT);
    expect(files.contents.get('browser/base/content/test/acme/browser.toml')).toBe(
      '# SPDX-License-Identifier: EUPL-1.2\n\n[DEFAULT]\nsupport-files = ["head.js"]\n\n["browser_acme_chip.js"]\n'
    );
    expect(files.contents.get('browser/base/moz.build')).toContain(
      '"content/test/acme/browser.toml",'
    );
    expect(files.contents.get('browser/base/content/test/acme/head.js')).toContain(
      'waitForElement'
    );
    expect(notes).toEqual([
      'Registered in browser/base/content/test/acme/browser.toml: ["browser_acme_chip.js"] (new file)',
      'Registered in browser/base/moz.build: BROWSER_CHROME_MANIFESTS += ["content/test/acme/browser.toml"]',
    ]);
  });

  it('keeps an existing test and adds the entry to an existing manifest', async () => {
    const scaffold = testScaffold('moz-acme-chip', 'acme', 'browser-chrome', 'EUPL-1.2');
    const files = memoryFiles({
      'browser/base/moz.build': BASE_MOZ_BUILD,
      [scaffold.test.path]: 'mine\n',
      'browser/base/content/test/acme/browser.toml': '[DEFAULT]\n\n["browser_a.js"]\n',
    });
    const notes = await writeTestScaffold(files, noTransaction, scaffold, PROJECT);
    expect(files.contents.get(scaffold.test.path)).toBe('mine\n');
    expect(files.contents.get('browser/base/content/test/acme/browser.toml')).toBe(
      '[DEFAULT]\n\n["browser_a.js"]\n\n["browser_acme_chip.js"]\n'
    );
    expect(notes[0]).toBe(`${scaffold.test.path} already exists and was kept.`);
  });

  it('takes an xpcshell scaffold away with its manifest and moz.build entry', async () => {
    const files = memoryFiles({ 'browser/base/moz.build': BASE_MOZ_BUILD });
    const scaffold = testScaffold('moz-acme-chip', 'acme', 'xpcshell', 'EUPL-1.2');
    await writeTestScaffold(files, noTransaction, scaffold, PROJECT);
    const manifest = 'browser/base/content/test/acme-xpcshell/moz-acme-chip/xpcshell.toml';
    expect(files.contents.get(manifest)).toContain('head = ""');
    expect(files.contents.get('browser/base/moz.build')).toContain(
      'XPCSHELL_TESTS_MANIFESTS += [\n    "content/test/acme-xpcshell/moz-acme-chip/xpcshell.toml",\n]'
    );
    expect(await removeTestScaffold(files, noTransaction, scaffold)).toBe(true);
    expect(files.contents.has(scaffold.test.path)).toBe(false);
    expect(files.contents.has(manifest)).toBe(false);
    expect(files.contents.get('browser/base/moz.build')).not.toContain('acme-xpcshell');
    expect(await removeTestScaffold(files, noTransaction, scaffold)).toBe(false);
  });

  it('removes only the entry from a manifest shared by a directory', async () => {
    const scaffold = testScaffold('moz-acme-chip', 'acme', 'mochikit', 'EUPL-1.2');
    const manifest = 'toolkit/content/tests/widgets/chrome.toml';
    const files = memoryFiles({
      [scaffold.test.path]: '<html></html>\n',
      [manifest]: '[DEFAULT]\n\n["test_moz-acme-chip.html"]\n\n["test_other.html"]\n',
    });
    await removeTestScaffold(files, noTransaction, scaffold);
    expect(files.contents.get(manifest)).toBe('[DEFAULT]\n\n["test_other.html"]\n');
  });
});

describe('renameTag', () => {
  it.each([
    ['<moz-panel></moz-panel>', '<moz-box></moz-box>'],
    ['<moz-panel-group>', '<moz-panel-group>'],
    ['class MozPanel extends X', 'class MozBox extends X'],
    ['class MozPanelGroup', 'class MozPanelGroup'],
    ['test_moz_panel_defined', 'test_moz_box_defined'],
    ['await moz_panel.updateComplete', 'await moz_box.updateComplete'],
    ['amoz_panel_defined', 'amoz_panel_defined'],
  ])('%j -> %j', (text, expected) => {
    expect(renameTag(text, 'moz-panel', 'moz-box')).toBe(expected);
  });

  it('leaves the identifiers of a longer tag the project knows alone, in every spelling', () => {
    const text = [
      'test_moz_panel_defined',
      'test_moz_panel_group_defined',
      'test_moz_panel_groups',
      '<moz-panel-group>',
      'MozPanelGroup',
    ].join('\n');
    expect(renameTag(text, 'moz-panel', 'moz-box', ['moz-panel-group', 'moz-card'])).toBe(
      [
        'test_moz_box_defined',
        'test_moz_panel_group_defined',
        'test_moz_box_groups',
        '<moz-panel-group>',
        'MozPanelGroup',
      ].join('\n')
    );
  });
});
