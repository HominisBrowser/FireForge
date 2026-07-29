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

import {
  getNextPatchFilename,
  patchNameSlug,
  stripRedundantCategoryPrefix,
} from '../patch-export.js';

describe('patchNameSlug (trailing .patch normalization)', () => {
  it('strips a trailing .patch instead of slugging it into -patch', () => {
    expect(patchNameSlug('foo.patch', 'ui')).toBe('foo');
  });

  it('collapses a full filename argument to its bare slug', () => {
    expect(patchNameSlug('348-ui-editor-panels.patch', 'ui')).toBe('editor-panels');
  });

  it('strips the extension case-insensitively', () => {
    expect(patchNameSlug('foo.PATCH', 'ui')).toBe('foo');
  });

  it('strips only one trailing extension', () => {
    expect(patchNameSlug('foo.patch.patch', 'ui')).toBe('foo-patch');
  });

  it('applies the length cap to the stem, not the raw filename', () => {
    const stem = 'a'.repeat(55);
    expect(patchNameSlug(`${stem}.patch`, 'ui')).toBe('a'.repeat(50));
  });

  it('leaves names without the extension untouched', () => {
    expect(patchNameSlug('sidebar-foo', 'ui')).toBe('sidebar-foo');
  });
});

describe('stripRedundantCategoryPrefix', () => {
  it('strips a leading NNN-<category>- prefix matching the selected category', () => {
    expect(stripRedundantCategoryPrefix('203-ui-foo', 'ui')).toBe('foo');
  });

  it('collapses a doubly prefixed slug from a previous incident', () => {
    expect(stripRedundantCategoryPrefix('203-ui-203-ui-foo', 'ui')).toBe('foo');
  });

  it('strips a bare category prefix matching the selected category', () => {
    expect(stripRedundantCategoryPrefix('ui-window-chrome-tests', 'ui')).toBe(
      'window-chrome-tests'
    );
  });

  it('collapses mixed full-stem and category-only repeats', () => {
    expect(stripRedundantCategoryPrefix('235-ui-ui-window-chrome-tests', 'ui')).toBe(
      'window-chrome-tests'
    );
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

  it('produces a single prefix when --name starts with <category>-', async () => {
    await expect(getNextPatchFilename(patchesDir, 'ui', 'ui-private-mode')).resolves.toBe(
      '001-ui-private-mode.patch'
    );
  });

  it('keeps the plain-name behaviour unchanged', async () => {
    await expect(getNextPatchFilename(patchesDir, 'ui', 'Sidebar Foo')).resolves.toBe(
      '001-ui-sidebar-foo.patch'
    );
  });
});
