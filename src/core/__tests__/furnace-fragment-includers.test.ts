// SPDX-License-Identifier: EUPL-1.2
/**
 * Unit tests for the fragment → includer reverse index and the stale
 * includer probe a targeted deploy runs.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempProject, removeTempProject } from '../../test-utils/index.js';
import type { CustomComponentConfig } from '../../types/furnace.js';
import type { FurnacePaths } from '../furnace-config.js';
import { expandCssFragments } from '../furnace-css-fragments.js';
import {
  collectFragmentIncluders,
  findStaleIncludersOfTargetFragments,
} from '../furnace-fragment-includers.js';

const FRAGMENT = ['@keyframes pulse {', '  from { opacity: 0; }', '  to { opacity: 1; }', '}'].join(
  '\n'
);

function sheetIncluding(...fragments: string[]): string {
  return [
    ':host { display: block; }',
    ...fragments.map((f) => `/* @fireforge-include ${f} */`),
    '.local { color: red; }',
    '',
  ].join('\n');
}

function customEntry(tag: string): CustomComponentConfig {
  return {
    description: tag,
    targetPath: `toolkit/content/widgets/${tag}`,
    register: false,
    localized: false,
  };
}

describe('furnace-fragment-includers', () => {
  let projectRoot: string;
  let furnacePaths: FurnacePaths;
  let engineDir: string;
  const custom: Record<string, CustomComponentConfig> = {
    'moz-a': customEntry('moz-a'),
    'moz-b': customEntry('moz-b'),
    'moz-c': customEntry('moz-c'),
  };

  async function writeWorkspaceSheet(tag: string, fileName: string, css: string): Promise<void> {
    const dir = join(furnacePaths.customDir, tag);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, fileName), css);
  }

  async function deploySheet(tag: string, fileName: string): Promise<void> {
    const src = join(furnacePaths.customDir, tag, fileName);
    const { readFile } = await import('node:fs/promises');
    const { expanded } = await expandCssFragments(
      await readFile(src, 'utf8'),
      furnacePaths.sharedDir
    );
    const dir = join(engineDir, custom[tag]?.targetPath ?? tag);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, fileName), expanded);
  }

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-includers-');
    const componentsDir = join(projectRoot, 'components');
    furnacePaths = {
      furnaceConfig: join(projectRoot, 'furnace.json'),
      componentsDir,
      overridesDir: join(componentsDir, 'overrides'),
      customDir: join(componentsDir, 'custom'),
      sharedDir: join(componentsDir, 'shared'),
      furnaceState: join(projectRoot, '.fireforge', 'furnace-state.json'),
    };
    engineDir = join(projectRoot, 'engine');
    await mkdir(furnacePaths.sharedDir, { recursive: true });
    await writeFile(join(furnacePaths.sharedDir, 'shared-anims.css'), FRAGMENT + '\n');
    await writeFile(join(furnacePaths.sharedDir, 'other.css'), '.other { color: blue; }\n');
    await writeWorkspaceSheet('moz-a', 'moz-a.css', sheetIncluding('shared-anims.css'));
    await writeWorkspaceSheet('moz-b', 'moz-b.css', sheetIncluding('shared-anims.css'));
    await writeWorkspaceSheet('moz-c', 'moz-c.css', sheetIncluding('other.css'));
  });

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('collectFragmentIncluders maps each fragment to every custom tag whose sheet includes it', async () => {
    const index = await collectFragmentIncluders(furnacePaths.customDir, custom);
    expect([...(index.get('shared-anims.css') ?? [])].sort()).toEqual(['moz-a', 'moz-b']);
    expect([...(index.get('other.css') ?? [])]).toEqual(['moz-c']);
  });

  it('collectFragmentIncluders ignores non-css files, sheets without directives and missing component dirs', async () => {
    await writeWorkspaceSheet('moz-a', 'moz-a.mjs', '/* @fireforge-include shared-anims.css */\n');
    await writeWorkspaceSheet('moz-c', 'plain.css', '.plain { color: green; }\n');
    const index = await collectFragmentIncluders(furnacePaths.customDir, {
      ...custom,
      'moz-missing': customEntry('moz-missing'),
    });
    expect([...(index.get('shared-anims.css') ?? [])].sort()).toEqual(['moz-a', 'moz-b']);
    expect([...index.keys()].sort()).toEqual(['other.css', 'shared-anims.css']);
  });

  it('returns nothing when no other includer is stale', async () => {
    await deploySheet('moz-a', 'moz-a.css');
    await deploySheet('moz-b', 'moz-b.css');
    const result = await findStaleIncludersOfTargetFragments({
      targetTag: 'moz-a',
      custom,
      furnacePaths,
      engineDir,
    });
    expect(result).toEqual({ fragments: ['shared-anims.css'], stale: [] });
  });

  it('reports a deployed includer whose expansion predates a fragment edit', async () => {
    await deploySheet('moz-a', 'moz-a.css');
    await deploySheet('moz-b', 'moz-b.css');
    await writeFile(
      join(furnacePaths.sharedDir, 'shared-anims.css'),
      '@keyframes spin { to { rotate: 1turn; } }\n'
    );
    const result = await findStaleIncludersOfTargetFragments({
      targetTag: 'moz-a',
      custom,
      furnacePaths,
      engineDir,
    });
    expect(result).toEqual({
      fragments: ['shared-anims.css'],
      stale: [{ tag: 'moz-b', fragments: ['shared-anims.css'] }],
    });
  });

  it('skips includers that are not deployed', async () => {
    await deploySheet('moz-a', 'moz-a.css');
    await writeFile(join(furnacePaths.sharedDir, 'shared-anims.css'), '.changed {}\n');
    const result = await findStaleIncludersOfTargetFragments({
      targetTag: 'moz-a',
      custom,
      furnacePaths,
      engineDir,
    });
    expect(result.stale).toEqual([]);
  });

  it('ignores fragments the target does not include', async () => {
    await deploySheet('moz-c', 'moz-c.css');
    await writeFile(join(furnacePaths.sharedDir, 'other.css'), '.other-changed {}\n');
    const result = await findStaleIncludersOfTargetFragments({
      targetTag: 'moz-a',
      custom,
      furnacePaths,
      engineDir,
    });
    expect(result).toEqual({ fragments: ['shared-anims.css'], stale: [] });
  });

  it('returns no fragments for a target that includes none', async () => {
    const result = await findStaleIncludersOfTargetFragments({
      targetTag: 'moz-none',
      custom: { ...custom, 'moz-none': customEntry('moz-none') },
      furnacePaths,
      engineDir,
    });
    expect(result).toEqual({ fragments: [], stale: [] });
  });

  it('treats a deployed sheet with no expansion as stale', async () => {
    const dir = join(engineDir, custom['moz-b']?.targetPath ?? 'moz-b');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'moz-b.css'), sheetIncluding('shared-anims.css'));
    const result = await findStaleIncludersOfTargetFragments({
      targetTag: 'moz-a',
      custom,
      furnacePaths,
      engineDir,
    });
    expect(result.stale).toEqual([{ tag: 'moz-b', fragments: ['shared-anims.css'] }]);
  });
});
