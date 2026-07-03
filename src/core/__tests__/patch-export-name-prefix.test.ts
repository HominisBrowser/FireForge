// SPDX-License-Identifier: EUPL-1.2
/**
 * Pins the 0.34.0 `--name` double-prefix fix: `export --name 203-ui-foo
 * --category ui` produced `203-ui-203-ui-foo.patch` because the filename
 * builders prepended order+category to a name that already carried them.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getNextPatchFilename, stripRedundantCategoryPrefix } from '../patch-export.js';

describe('stripRedundantCategoryPrefix', () => {
  it('strips a leading NNN-<category>- prefix matching the selected category', () => {
    expect(stripRedundantCategoryPrefix('203-ui-foo', 'ui')).toBe('foo');
  });

  it('collapses a doubly prefixed slug from a previous incident', () => {
    expect(stripRedundantCategoryPrefix('203-ui-203-ui-foo', 'ui')).toBe('foo');
  });

  it('leaves names without a matching prefix untouched', () => {
    expect(stripRedundantCategoryPrefix('sidebar-foo', 'ui')).toBe('sidebar-foo');
    // Different category in the prefix is part of the intended name.
    expect(stripRedundantCategoryPrefix('203-infra-foo', 'ui')).toBe('203-infra-foo');
    // Bare numbers without the category are kept too.
    expect(stripRedundantCategoryPrefix('203-foo', 'ui')).toBe('203-foo');
  });

  it('keeps the original slug when stripping would leave nothing', () => {
    expect(stripRedundantCategoryPrefix('203-ui-', 'ui')).toBe('203-ui-');
  });
});

describe('getNextPatchFilename (double-prefix regression)', () => {
  let patchesDir: string;

  beforeEach(async () => {
    patchesDir = await mkdtemp(join(tmpdir(), 'ff-export-name-'));
  });

  afterEach(async () => {
    await rm(patchesDir, { recursive: true, force: true });
  });

  it('produces a single prefix when --name already carries NNN-<category>-', async () => {
    await expect(getNextPatchFilename(patchesDir, 'ui', '203-ui-foo')).resolves.toBe(
      '001-ui-foo.patch'
    );
  });

  it('keeps the plain-name behaviour unchanged', async () => {
    await expect(getNextPatchFilename(patchesDir, 'ui', 'Sidebar Foo')).resolves.toBe(
      '001-ui-sidebar-foo.patch'
    );
  });
});
