// SPDX-License-Identifier: EUPL-1.2
/**
 * Real-filesystem lifecycle test for shared CSS fragments through
 * `applyAllComponents`. The main invariant: a deploy followed by an
 * unchanged re-deploy must skip. If the drift oracle compared the raw
 * (un-expanded) workspace source against the expanded engine copy, every
 * fragment-using component would loop as permanently drifted.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempProject, removeTempProject } from '../../test-utils/index.js';
import { applyAllComponents } from '../furnace-apply.js';

vi.mock('../../utils/logger.js', () => ({
  // Verbose + stdout-seal state: the CLI error boundary consults both
  // before walking a cause chain or emitting a --json error envelope.
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

const FRAGMENT_V1 = '@keyframes pulse { from { opacity: 0; } to { opacity: 1; } }\n';
const FRAGMENT_V2 = '@keyframes spin { to { rotate: 1turn; } }\n';

describe('CSS fragment deploy lifecycle (applyAllComponents, real fs)', () => {
  let projectRoot: string;
  let componentDir: string;
  let sharedDir: string;
  let engineCssPath: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-frag-deploy-');
    componentDir = join(projectRoot, 'components', 'custom', 'moz-fancy');
    sharedDir = join(projectRoot, 'components', 'shared');
    engineCssPath = join(projectRoot, 'engine', 'browser', 'components', 'fancy', 'moz-fancy.css');

    await mkdir(componentDir, { recursive: true });
    await mkdir(sharedDir, { recursive: true });
    await mkdir(join(projectRoot, 'engine', 'toolkit', 'content'), { recursive: true });
    // jar.mn registration runs for every copied component file, so seed a
    // minimal jar.mn with one existing elements line as insertion anchor.
    await writeFile(
      join(projectRoot, 'engine', 'toolkit', 'content', 'jar.mn'),
      [
        'toolkit.jar:',
        '%  content global %content/global/',
        '   content/global/elements/moz-button.mjs  (widgets/moz-button/moz-button.mjs)',
        '',
      ].join('\n')
    );

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
        overrides: {},
        custom: {
          'moz-fancy': {
            description: 'Fancy widget',
            targetPath: 'browser/components/fancy',
            register: false,
            localized: false,
          },
        },
      }) + '\n'
    );
    await writeFile(join(componentDir, 'moz-fancy.mjs'), 'export class MozFancy {}\n');
    await writeFile(join(componentDir, 'moz-fancy.css'), WIDGET_CSS);
    await writeFile(join(sharedDir, 'shared-anims.css'), FRAGMENT_V1);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await removeTempProject(projectRoot);
  });

  it('expands on deploy, skips an unchanged re-deploy, and refreshes on fragment edits', async () => {
    // First deploy: the engine copy carries the fenced expansion. The
    // workspace source keeps only the directive.
    const first = await applyAllComponents(projectRoot);
    expect(first.errors).toEqual([]);
    expect(first.applied.map((entry) => entry.name)).toEqual(['moz-fancy']);

    const deployed = await readFile(engineCssPath, 'utf-8');
    expect(deployed).toContain('@keyframes pulse');
    expect(deployed).toContain('/* @fireforge-end-include shared-anims.css */');
    expect(await readFile(join(componentDir, 'moz-fancy.css'), 'utf-8')).toBe(WIDGET_CSS);

    // Regression guard: an unchanged second deploy must skip, not loop on
    // false drift between directive-source and expanded-engine copy.
    const second = await applyAllComponents(projectRoot);
    expect(second.errors).toEqual([]);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual([{ name: 'moz-fancy', reason: 'No changes since last apply' }]);

    // Editing the fragment alone (no component file changed) must surface
    // as drift and refresh the deployed expansion.
    await writeFile(join(sharedDir, 'shared-anims.css'), FRAGMENT_V2);
    const third = await applyAllComponents(projectRoot);
    expect(third.errors).toEqual([]);
    expect(third.applied.map((entry) => entry.name)).toEqual(['moz-fancy']);

    const refreshed = await readFile(engineCssPath, 'utf-8');
    expect(refreshed).toContain('@keyframes spin');
    expect(refreshed).not.toContain('@keyframes pulse');

    // And the refreshed state settles: a fourth run skips again.
    const fourth = await applyAllComponents(projectRoot);
    expect(fourth.applied).toEqual([]);
    expect(fourth.skipped).toHaveLength(1);
  });

  it('fails the component (with rollback) when a fragment is missing', async () => {
    await writeFile(join(componentDir, 'moz-fancy.css'), '/* @fireforge-include missing.css */\n');

    const result = await applyAllComponents(projectRoot);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.name).toBe('moz-fancy');
    expect(result.errors[0]?.error).toMatch(/fragment "missing.css" not found/i);
    expect(result.rolledBack).toBe(true);
  });
});
