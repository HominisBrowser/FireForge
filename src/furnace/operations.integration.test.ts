// SPDX-License-Identifier: EUPL-1.2
/**
 * Creating, overriding, renaming and removing components against real
 * project files and a synthetic engine, and how each meets deployment.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { type FurnaceFixture, makeFurnaceFixture } from '../testing/furnace.js';
import { readTree, useTempDir, writeTree } from '../testing/temp.js';
import {
  applyComponents,
  createComponent,
  loadFurnaceConfig,
  overrideComponent,
  removeComponent,
  renameComponent,
  typingDrift,
} from './index.js';

const dir = useTempDir();

const FURNACE = { version: 1, componentPrefix: 'moz-', typecheckTagMap: 'types/widgets.d.ts' };

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false
  );

async function fixture(furnace: object = FURNACE): Promise<FurnaceFixture> {
  return makeFurnaceFixture(dir(), {
    furnace,
    files: {
      'components/custom/jsconfig.json': '{\n  "compilerOptions": {\n    "paths": {}\n  }\n}\n',
    },
  });
}

describe('createComponent', () => {
  it('writes the sources, the furnace.json entry, a test and the typing files in one go', async () => {
    const f = await fixture({ ...FURNACE, typecheckJsconfig: 'components/custom/jsconfig.json' });
    const result = await createComponent(f.project, f.tracked, 'moz-acme-chip', {
      description: 'A chip',
      localized: true,
      tests: 'browser-chrome',
    });
    expect(result.paths).toEqual([
      'components/custom/moz-acme-chip/moz-acme-chip.mjs',
      'components/custom/moz-acme-chip/moz-acme-chip.css',
      'components/custom/moz-acme-chip/moz-acme-chip.ftl',
      'furnace.json',
      'engine/browser/base/content/test/acme/browser_acme_chip.js',
      'engine/browser/base/content/test/acme/head.js',
      'engine/browser/base/content/test/acme/browser.toml',
      'engine/browser/base/moz.build',
      'components/custom/jsconfig.json',
      'types/widgets.d.ts',
    ]);
    const mjs = await readFile(
      join(f.root, 'components/custom/moz-acme-chip/moz-acme-chip.mjs'),
      'utf8'
    );
    expect(mjs).toContain(
      'window.MozXULElement?.insertFTLIfNeeded("toolkit/global/moz-acme-chip.ftl");'
    );
    expect(mjs).toContain('export default class MozAcmeChip extends MozLitElement');
    expect((await loadFurnaceConfig(f.project)).custom['moz-acme-chip']).toEqual({
      description: 'A chip',
      targetPath: 'toolkit/content/widgets/moz-acme-chip',
      register: true,
      localized: true,
    });
    expect(await readFile(join(f.engineDir, 'browser/base/moz.build'), 'utf8')).toContain(
      '"content/test/acme/browser.toml"'
    );
    expect(await readFile(join(f.root, 'types/widgets.d.ts'), 'utf8')).toContain(
      '"moz-acme-chip": HTMLElement & import("chrome://global/content/elements/moz-acme-chip.mjs").default;'
    );
    expect(await typingDrift(f.project, await loadFurnaceConfig(f.project), f.tracked)).toEqual([]);
    const deployed = await applyComponents(f.project, f.workspace);
    expect(deployed.components[0]?.status).toBe('outdated');
  });

  it('shares a feature Fluent file instead of writing its own', async () => {
    const f = await fixture();
    await createComponent(f.project, f.tracked, 'moz-acme-dock', {
      sharedFtl: 'browser/acme-dock.ftl',
    });
    const tree = await readTree(join(f.root, 'components/custom/moz-acme-dock'));
    expect(Object.keys(tree).sort()).toEqual(['moz-acme-dock.css', 'moz-acme-dock.mjs']);
    expect(tree['moz-acme-dock.mjs']).toContain('insertFTLIfNeeded("browser/acme-dock.ftl")');
  });

  it('lists the paths of a dry run, its test registration included, and writes nothing', async () => {
    const f = await fixture();
    await writeTree(f.root, {
      'engine/toolkit/content/moz.build': 'JAR_MANIFESTS += ["jar.mn"]\n',
    });
    const before = await readTree(f.root, ['engine']);
    const result = await createComponent(f.project, f.tracked, 'moz-acme-chip', {
      dryRun: true,
      tests: 'mochikit',
    });
    expect(result.paths).toEqual(
      expect.arrayContaining([
        'engine/toolkit/content/tests/widgets/test_moz-acme-chip.html',
        'engine/toolkit/content/tests/widgets/chrome.toml',
        'engine/toolkit/content/moz.build',
      ])
    );
    expect(await readTree(f.root, ['engine'])).toEqual(before);
  });

  it.each([
    ['acme-chip', /component prefix "moz-"/],
    ['moz-Chip', /not a custom element name/],
    ['moz-card', /already has a component/],
  ])('refuses %s', async (name, message) => {
    const f = await fixture({
      ...FURNACE,
      overrides: {
        'moz-card': {
          type: 'full',
          description: '',
          basePath: 'toolkit/content/widgets/moz-card',
          baseVersion: 'x',
        },
      },
    });
    await expect(createComponent(f.project, f.tracked, name)).rejects.toThrow(message);
  });

  it('rolls everything back when a later step fails', async () => {
    const f = await fixture({ ...FURNACE, typecheckJsconfig: 'missing/jsconfig.json' });
    const before = await readTree(f.root, ['.fireforge']);
    await expect(
      createComponent(f.project, f.tracked, 'moz-acme-chip', { tests: 'xpcshell' })
    ).rejects.toMatchObject({
      code: 'furnace-jsconfig-invalid',
    });
    expect(await readTree(f.root, ['.fireforge'])).toEqual(before);
  });
});

describe('renameComponent', () => {
  it('moves the component, its references and its test, and deployment follows', async () => {
    const f = await fixture();
    await createComponent(f.project, f.tracked, 'moz-acme-chip', { tests: 'xpcshell' });
    await writeTree(f.root, {
      'components/custom/moz-acme-chip/moz-acme-chip-rows.mjs': '// rows of moz-acme-chip\n',
    });
    await createComponent(f.project, f.tracked, 'moz-acme-bar', { composes: ['moz-acme-chip'] });
    await applyComponents(f.project, f.workspace);

    await renameComponent(f.project, f.tracked, 'moz-acme-chip', 'moz-acme-pill');
    const tree = await readTree(join(f.root, 'components/custom/moz-acme-pill'));
    expect(Object.keys(tree).sort()).toEqual([
      'moz-acme-pill-rows.mjs',
      'moz-acme-pill.css',
      'moz-acme-pill.mjs',
    ]);
    expect(tree['moz-acme-pill.mjs']).toContain('class MozAcmePill');
    expect(tree['moz-acme-pill-rows.mjs']).toBe('// rows of moz-acme-pill\n');
    expect(await exists(join(f.root, 'components/custom/moz-acme-chip'))).toBe(false);
    const config = await loadFurnaceConfig(f.project);
    expect(config.custom['moz-acme-pill']?.targetPath).toBe(
      'toolkit/content/widgets/moz-acme-pill'
    );
    expect(config.custom['moz-acme-bar']?.composes).toEqual(['moz-acme-pill']);
    const xpcshell = 'browser/base/content/test/acme-xpcshell';
    expect(await exists(join(f.engineDir, xpcshell, 'moz-acme-chip/xpcshell.toml'))).toBe(false);
    expect(
      await readFile(
        join(f.engineDir, xpcshell, 'moz-acme-pill/test_moz_acme_pill_packaged.js'),
        'utf8'
      )
    ).toContain('moz-acme-pill.mjs');
    const build = await readFile(join(f.engineDir, 'browser/base/moz.build'), 'utf8');
    expect(build).toContain('acme-xpcshell/moz-acme-pill/xpcshell.toml');
    expect(build).not.toContain('moz-acme-chip');

    const deployed = await applyComponents(f.project, f.workspace);
    expect(deployed.components.map((component) => [component.name, component.status])).toEqual([
      ['moz-acme-bar', 'current'],
      ['moz-acme-pill', 'outdated'],
      ['moz-acme-chip', 'removed'],
    ]);
    const elements = await readFile(join(f.engineDir, 'toolkit/content/customElements.js'), 'utf8');
    expect(elements).toContain('"moz-acme-pill"');
    expect(elements).not.toContain('"moz-acme-chip"');
  });
});

describe('removeComponent', () => {
  it('removes the component, its exceptions and its test, and refuses one another composes', async () => {
    const f = await fixture({
      ...FURNACE,
      validationExceptions: [{ component: 'moz-acme-chip', check: 'missing-css', reason: 'r' }],
    });
    await createComponent(f.project, f.tracked, 'moz-acme-chip', { tests: 'browser-chrome' });
    await createComponent(f.project, f.tracked, 'moz-acme-bar', { composes: ['moz-acme-chip'] });
    await expect(removeComponent(f.project, f.tracked, 'moz-acme-chip')).rejects.toThrow(
      /moz-acme-bar composes/
    );
    await removeComponent(f.project, f.tracked, 'moz-acme-bar');
    await removeComponent(f.project, f.tracked, 'moz-acme-chip');
    const config = await loadFurnaceConfig(f.project);
    expect(config.custom).toEqual({});
    expect(config.validationExceptions).toEqual([]);
    expect(
      await exists(join(f.engineDir, 'browser/base/content/test/acme/browser_acme_chip.js'))
    ).toBe(false);
    expect(
      await readFile(join(f.engineDir, 'browser/base/content/test/acme/browser.toml'), 'utf8')
    ).not.toContain('browser_acme_chip.js');
    expect(await readFile(join(f.root, 'types/widgets.d.ts'), 'utf8')).not.toContain(
      'moz-acme-chip'
    );
  });
});

describe('overrideComponent', () => {
  it('copies the stock files from upstream and records where they came from', async () => {
    const f = await fixture({ ...FURNACE, stock: ['moz-card'] });
    await writeTree(f.engineDir, {
      'toolkit/content/widgets/moz-card/moz-card.css': 'locally edited\n',
    });
    await overrideComponent(f.project, f.tracked, f.workspace, 'moz-card', {
      description: 'Square',
    });
    const tree = await readTree(join(f.root, 'components/overrides/moz-card'));
    expect(Object.keys(tree).sort()).toEqual(['moz-card.css', 'moz-card.mjs']);
    expect(tree['moz-card.css']).toContain('var(--text-color)');
    const config = await loadFurnaceConfig(f.project);
    expect(config.stock).toEqual([]);
    expect(config.overrides['moz-card']).toMatchObject({
      type: 'full',
      basePath: 'toolkit/content/widgets/moz-card',
      baseVersion: '153.7.0esr',
      baseCommit: expect.stringMatching(/^[0-9a-f]{40}$/) as string,
    });
  });

  it('copies only stylesheets for a css-only override, and refuses a component upstream lacks', async () => {
    const f = await fixture();
    await overrideComponent(f.project, f.tracked, f.workspace, 'moz-card', { cssOnly: true });
    expect(Object.keys(await readTree(join(f.root, 'components/overrides/moz-card')))).toEqual([
      'moz-card.css',
    ]);
    await expect(
      overrideComponent(f.project, f.tracked, f.workspace, 'moz-nothing')
    ).rejects.toThrow(/no stock component files/);
  });
});
