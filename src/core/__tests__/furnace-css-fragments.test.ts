// SPDX-License-Identifier: EUPL-1.2
/**
 * Unit tests for shared CSS fragment expansion (field report D2).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempProject, removeTempProject } from '../../test-utils/index.js';
import {
  expandCssFragments,
  extractExpandedFragmentBodies,
  listFragmentIncludes,
  stripExpandedFragments,
  validateCssFragments,
} from '../furnace-css-fragments.js';

const WIDGET_CSS = [
  ':host {',
  '  display: block;',
  '}',
  '',
  '/* @fireforge-include shared-anims.css */',
  '',
  '.local {',
  '  color: red;',
  '}',
  '',
].join('\n');

const FRAGMENT = ['@keyframes pulse {', '  from { opacity: 0; }', '  to { opacity: 1; }', '}'].join(
  '\n'
);

describe('furnace-css-fragments', () => {
  let projectRoot: string;
  let sharedDir: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-frag-');
    sharedDir = join(projectRoot, 'components', 'shared');
    await mkdir(sharedDir, { recursive: true });
    await writeFile(join(sharedDir, 'shared-anims.css'), FRAGMENT + '\n');
  });
  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('lists include directives', () => {
    expect(listFragmentIncludes(WIDGET_CSS)).toEqual(['shared-anims.css']);
    expect(listFragmentIncludes('.x { color: blue; }')).toEqual([]);
  });

  it('expands a directive into a fenced block carrying the fragment content', async () => {
    const { expanded, includes } = await expandCssFragments(WIDGET_CSS, sharedDir);
    expect(includes).toEqual(['shared-anims.css']);
    expect(expanded).toContain('/* @fireforge-include shared-anims.css */');
    expect(expanded).toContain('@keyframes pulse');
    expect(expanded).toContain('/* @fireforge-end-include shared-anims.css */');
    // Local rules survive on both sides of the expansion.
    expect(expanded).toContain(':host {');
    expect(expanded).toContain('.local {');
  });

  it('round-trips: strip(expand(css)) === css', async () => {
    const { expanded } = await expandCssFragments(WIDGET_CSS, sharedDir);
    expect(stripExpandedFragments(expanded)).toBe(WIDGET_CSS);
  });

  it('re-expansion is idempotent and refreshes stale content', async () => {
    const { expanded: first } = await expandCssFragments(WIDGET_CSS, sharedDir);
    const { expanded: second } = await expandCssFragments(first, sharedDir);
    expect(second).toBe(first);

    await writeFile(
      join(sharedDir, 'shared-anims.css'),
      '@keyframes spin { to { rotate: 1turn; } }\n'
    );
    const { expanded: refreshed } = await expandCssFragments(first, sharedDir);
    expect(refreshed).toContain('@keyframes spin');
    expect(refreshed).not.toContain('@keyframes pulse');
  });

  it('throws a clear error for a missing fragment', async () => {
    await expect(
      expandCssFragments('/* @fireforge-include nope.css */\n', sharedDir)
    ).rejects.toThrow(/fragment "nope.css" not found/i);
  });

  it('rejects nested includes inside fragment files', async () => {
    await writeFile(
      join(sharedDir, 'nested.css'),
      '/* @fireforge-include shared-anims.css */\n.x {}\n'
    );
    await expect(
      expandCssFragments('/* @fireforge-include nested.css */\n', sharedDir)
    ).rejects.toThrow(/nested fragment includes are not supported/i);
  });

  it('extracts deployed fragment bodies for staleness comparison', async () => {
    const { expanded } = await expandCssFragments(WIDGET_CSS, sharedDir);
    const bodies = extractExpandedFragmentBodies(expanded);
    expect(bodies.get('shared-anims.css')).toBe(FRAGMENT);
  });

  it('validateCssFragments reports missing fragments as errors', async () => {
    const componentDir = join(projectRoot, 'components', 'custom', 'moz-fancy');
    await mkdir(componentDir, { recursive: true });
    await writeFile(join(componentDir, 'moz-fancy.css'), '/* @fireforge-include nope.css */\n');

    const issues = await validateCssFragments(componentDir, 'moz-fancy', sharedDir);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe('missing-fragment');
    expect(issues[0]?.severity).toBe('error');
  });

  it('validateCssFragments flags stale and missing deployed expansions', async () => {
    const componentDir = join(projectRoot, 'components', 'custom', 'moz-fancy');
    const engineTargetDir = join(projectRoot, 'engine', 'browser', 'components', 'fancy');
    await mkdir(componentDir, { recursive: true });
    await mkdir(engineTargetDir, { recursive: true });
    await writeFile(join(componentDir, 'moz-fancy.css'), WIDGET_CSS);

    // Deploy the expansion, then change the fragment source.
    const { expanded } = await expandCssFragments(WIDGET_CSS, sharedDir);
    await writeFile(join(engineTargetDir, 'moz-fancy.css'), expanded);

    const freshIssues = await validateCssFragments(
      componentDir,
      'moz-fancy',
      sharedDir,
      engineTargetDir
    );
    expect(freshIssues).toHaveLength(0);

    await writeFile(join(sharedDir, 'shared-anims.css'), '@keyframes spin { }\n');
    const staleIssues = await validateCssFragments(
      componentDir,
      'moz-fancy',
      sharedDir,
      engineTargetDir
    );
    expect(staleIssues).toHaveLength(1);
    expect(staleIssues[0]?.check).toBe('stale-fragment-expansion');
    expect(staleIssues[0]?.severity).toBe('warning');

    // Un-expanded deployed copy (pre-D2 deploy) also reads as stale.
    await writeFile(join(engineTargetDir, 'moz-fancy.css'), WIDGET_CSS);
    const unexpanded = await validateCssFragments(
      componentDir,
      'moz-fancy',
      sharedDir,
      engineTargetDir
    );
    expect(unexpanded.some((i) => i.check === 'stale-fragment-expansion')).toBe(true);
  });
});
