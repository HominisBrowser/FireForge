// SPDX-License-Identifier: EUPL-1.2
/**
 * Real-filesystem coverage for the composed-source oracle the
 * unexported-drift belt consults: a deployed file is a Furnace deployment
 * of its component source when it equals the composed current source,
 * differs only inside generated fragment expansions, or is exactly the
 * last recorded deployment; a hand edit is none of these.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempProject, removeTempProject } from '../../test-utils/index.js';
import { applyAllComponents } from '../furnace-apply.js';
import {
  composeComponentSource,
  mapDeployedComponentSources,
  matchDeployedComponentFiles,
} from '../furnace-composed-source.js';
import { loadFurnaceConfig } from '../furnace-config.js';

vi.mock('../../utils/logger.js', () => ({
  isVerbose: vi.fn(() => false),
  isStdoutSealed: vi.fn(() => false),
  setStdoutSealed: vi.fn(),
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  verbose: vi.fn(),
  note: vi.fn(),
  spinner: vi.fn(() => ({ message: vi.fn(), stop: vi.fn(), error: vi.fn() })),
}));

const WIDGET_CSS = [
  ':host { display: block; }',
  '/* @fireforge-include shared-anims.css */',
  '.local { color: red; }',
  '',
].join('\n');

const CSS_REL = 'browser/components/fancy/moz-fancy.css';
const MJS_REL = 'browser/components/fancy/moz-fancy.mjs';
const OVERRIDE_REL = 'toolkit/content/widgets/moz-card/moz-card.css';

describe('furnace composed-source oracle (real fs)', () => {
  let projectRoot: string;
  let componentDir: string;
  let sharedDir: string;
  let engineDir: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-composed-');
    componentDir = join(projectRoot, 'components', 'custom', 'moz-fancy');
    sharedDir = join(projectRoot, 'components', 'shared');
    engineDir = join(projectRoot, 'engine');
    const overrideDir = join(projectRoot, 'components', 'overrides', 'moz-card');

    await mkdir(componentDir, { recursive: true });
    await mkdir(sharedDir, { recursive: true });
    await mkdir(overrideDir, { recursive: true });
    await mkdir(join(engineDir, 'toolkit', 'content', 'widgets', 'moz-card'), { recursive: true });
    await writeFile(
      join(engineDir, 'toolkit', 'content', 'jar.mn'),
      [
        'toolkit.jar:',
        '%  content global %content/global/',
        '   content/global/elements/moz-button.mjs  (widgets/moz-button/moz-button.mjs)',
        '',
      ].join('\n')
    );
    await writeFile(join(engineDir, OVERRIDE_REL), 'upstream {}\n');
    await writeFile(
      join(projectRoot, 'fireforge.json'),
      JSON.stringify({
        name: 'Test Browser',
        vendor: 'Test',
        appId: 'org.test.browser',
        binaryName: 'testbrowser',
        firefox: { version: '152.0', product: 'firefox' },
      }) + '\n'
    );
    await writeFile(
      join(projectRoot, 'furnace.json'),
      JSON.stringify({
        version: 1,
        componentPrefix: 'moz-',
        stock: [],
        overrides: {
          'moz-card': {
            type: 'css-only',
            description: 'Card override',
            basePath: 'toolkit/content/widgets/moz-card',
            baseVersion: '152.0',
          },
        },
        custom: {
          'moz-fancy': {
            description: 'Fancy widget',
            targetPath: 'browser/components/fancy',
            register: false,
            localized: true,
            sharedFtl: 'browser/testbrowser-fancy.ftl',
          },
        },
      }) + '\n'
    );
    await writeFile(join(componentDir, 'moz-fancy.mjs'), 'export class MozFancy {}\n');
    await writeFile(join(componentDir, 'moz-fancy.css'), WIDGET_CSS);
    // A sharedFtl component deploys no per-component .ftl.
    await writeFile(join(componentDir, 'moz-fancy.ftl'), 'fancy = Fancy\n');
    await writeFile(join(sharedDir, 'shared-anims.css'), '@keyframes a {}\n');
    await writeFile(join(overrideDir, 'moz-card.css'), 'override {}\n');
    await writeFile(join(overrideDir, 'override.json'), '{}\n');

    const result = await applyAllComponents(projectRoot);
    expect(result.errors).toEqual([]);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await removeTempProject(projectRoot);
  });

  it('maps each deployed engine path to its source, skipping a sharedFtl .ftl', async () => {
    const sources = await mapDeployedComponentSources(
      projectRoot,
      await loadFurnaceConfig(projectRoot)
    );

    expect([...sources.keys()].sort()).toEqual([CSS_REL, MJS_REL, OVERRIDE_REL].sort());
    expect(sources.get(OVERRIDE_REL)).toMatchObject({ type: 'override', component: 'moz-card' });
  });

  it('composes only stylesheets that carry include directives', async () => {
    const composed = await composeComponentSource(WIDGET_CSS, 'moz-fancy.css', sharedDir);
    expect(composed).toBe(await readFile(join(engineDir, CSS_REL), 'utf8'));
    expect(await composeComponentSource(WIDGET_CSS, 'moz-fancy.mjs', sharedDir)).toBe(WIDGET_CSS);
  });

  it('classifies a fresh deployment as the composed source', async () => {
    const matches = await matchDeployedComponentFiles(projectRoot, engineDir, [
      CSS_REL,
      MJS_REL,
      OVERRIDE_REL,
      'browser/unrelated.js',
    ]);

    expect(Object.fromEntries(matches)).toEqual({
      [CSS_REL]: 'composed-source',
      [MJS_REL]: 'composed-source',
      [OVERRIDE_REL]: 'composed-source',
    });
  });

  it('classifies a stale fragment expansion as a fragment refresh', async () => {
    await writeFile(join(sharedDir, 'shared-anims.css'), '@keyframes b {}\n');

    const matches = await matchDeployedComponentFiles(projectRoot, engineDir, [CSS_REL]);

    expect(matches.get(CSS_REL)).toBe('fragment-refresh');
  });

  it('classifies the last recorded deployment of a since-edited source', async () => {
    await writeFile(join(componentDir, 'moz-fancy.mjs'), 'export class MozFancy { v2() {} }\n');

    const matches = await matchDeployedComponentFiles(projectRoot, engineDir, [MJS_REL]);

    expect(matches.get(MJS_REL)).toBe('previous-deploy');
  });

  it('leaves a hand edit to the deployed copy unmatched', async () => {
    await writeFile(join(engineDir, MJS_REL), 'export class MozFancy { hotfix() {} }\n');
    await writeFile(
      join(engineDir, CSS_REL),
      (await readFile(join(engineDir, CSS_REL), 'utf8')).replace('red', 'blue')
    );

    const matches = await matchDeployedComponentFiles(projectRoot, engineDir, [MJS_REL, CSS_REL]);

    expect(matches.size).toBe(0);
  });

  it('matches nothing without a furnace.json', async () => {
    await rm(join(projectRoot, 'furnace.json'));

    await expect(matchDeployedComponentFiles(projectRoot, engineDir, [MJS_REL])).resolves.toEqual(
      new Map()
    );
  });
});
