// SPDX-License-Identifier: EUPL-1.2
/**
 * Tests for xpcshell test-file registration (`test_*.js` files otherwise
 * rejected as "Unknown file pattern") and for the relaxed pattern rules
 * (nested browser.toml, xpcshell test files).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureDir, readText, writeText } from '../../utils/fs.js';
import { getRules } from '../moz-manifest-rules.js';
import {
  insertXpcshellManifestSection,
  isXpcshellTestRegistered,
  placeXpcshellManifestSection,
  registerXpcshellTest,
} from '../register-xpcshell-test.js';

describe('pattern rules', () => {
  const patterns = getRules('mybrowser').map((r) => r.pattern);
  const matches = (path: string): boolean => patterns.some((p) => p.test(path));

  it('matches nested browser.toml manifests at arbitrary depth', () => {
    expect(matches('browser/base/content/test/mybrowser/browser.toml')).toBe(true);
    expect(matches('browser/base/content/test/mybrowser/settings/browser.toml')).toBe(true);
    expect(matches('browser/base/content/test/a/b/c/browser.toml')).toBe(true);
  });

  it('matches xpcshell test files outside browser/base/content/test/', () => {
    expect(matches('browser/components/mybrowser/test/unit/test_store.js')).toBe(true);
    expect(matches('toolkit/components/foo/tests/test_settings.js')).toBe(true);
  });

  it('keeps browser/base/content/test/ test files on the browser.toml guidance path', () => {
    expect(matches('browser/base/content/test/mybrowser/test_something.js')).toBe(false);
    expect(matches('browser/base/content/test/mybrowser/browser_foo.js')).toBe(false);
  });
});

describe('insertXpcshellManifestSection', () => {
  it('inserts a section alphabetically among existing sections', () => {
    const content = [
      '[DEFAULT]',
      'head = "head.js"',
      '',
      '["test_a.js"]',
      '',
      '["test_z.js"]',
      '',
    ].join('\n');
    const updated = insertXpcshellManifestSection(content, 'test_m.js');
    const aIdx = updated.indexOf('["test_a.js"]');
    const mIdx = updated.indexOf('["test_m.js"]');
    const zIdx = updated.indexOf('["test_z.js"]');
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(mIdx).toBeGreaterThan(aIdx);
    expect(zIdx).toBeGreaterThan(mIdx);
  });

  it('appends when the new section sorts last or no sections exist', () => {
    expect(insertXpcshellManifestSection('[DEFAULT]\n', 'test_x.js')).toContain('["test_x.js"]');
    const updated = insertXpcshellManifestSection('[DEFAULT]\n\n["test_a.js"]\n', 'test_b.js');
    expect(updated.indexOf('["test_b.js"]')).toBeGreaterThan(updated.indexOf('["test_a.js"]'));
  });
});

describe('xpcshell section placement keeps comments with their entry', () => {
  const content = [
    '[DEFAULT]',
    '',
    '["test_HominisStore.js"]',
    'skip-if = ["os == \'win\'"]',
    '',
    '# Exercises the harness itself.',
    '# Keep it last.',
    '["test_HominisStoreTestHarness.js"]',
    '',
  ].join('\n');

  it('inserts ahead of the comment that introduces the next entry', () => {
    expect(placeXpcshellManifestSection(content, 'test_HominisStoreQuota.js').content).toBe(
      [
        '[DEFAULT]',
        '',
        '["test_HominisStore.js"]',
        'skip-if = ["os == \'win\'"]',
        '',
        '["test_HominisStoreQuota.js"]',
        '',
        '# Exercises the harness itself.',
        '# Keep it last.',
        '["test_HominisStoreTestHarness.js"]',
        '',
      ].join('\n')
    );
  });

  it("--after places the section after the named entry's whole block", () => {
    const placed = placeXpcshellManifestSection(
      content,
      'test_HominisAAA.js',
      'test_HominisStore.js'
    );
    expect(placed.previousEntry).toBe('["test_HominisStore.js"]');
    expect(placed.afterFallback).toBeUndefined();
    const lines = placed.content.split('\n');
    expect(lines.indexOf('["test_HominisAAA.js"]')).toBe(5);
    expect(lines.indexOf('# Exercises the harness itself.')).toBe(7);

    const last = placeXpcshellManifestSection(
      content,
      'test_HominisAAA.js',
      'test_HominisStoreTestHarness.js'
    );
    expect(last.content.trimEnd().endsWith('["test_HominisAAA.js"]')).toBe(true);
  });

  it('--after naming no entry falls back to sort order and says so', () => {
    const placed = placeXpcshellManifestSection(content, 'test_A.js', 'test_missing.js');
    expect(placed.afterFallback).toBe(true);
    expect(placed.content.indexOf('["test_A.js"]')).toBeLessThan(
      placed.content.indexOf('["test_HominisStore.js"]')
    );
  });

  it('the xpcshell rule takes --after', () => {
    const rule = getRules('mybrowser').find((candidate) =>
      candidate.pattern.test('toolkit/components/foo/tests/test_x.js')
    );
    expect(rule?.supportsAfter).toBe(true);
  });
});

describe('registerXpcshellTest', () => {
  let engine: string;
  const dirRel = 'browser/components/mybrowser/test/unit';

  beforeEach(async () => {
    engine = await mkdtemp(join(tmpdir(), 'ff-register-xpcshell-'));
    await ensureDir(join(engine, dirRel));
  });

  afterEach(async () => {
    await rm(engine, { recursive: true, force: true });
  });

  it('errors with a --create-manifest hint when the manifest is missing', async () => {
    await expect(registerXpcshellTest(engine, dirRel, 'test_store.js')).rejects.toThrow(
      /Manifest not found: .*xpcshell\.toml.*--create-manifest/s
    );
    await expect(isXpcshellTestRegistered(engine, dirRel, 'test_store.js')).rejects.toThrow(
      /^Manifest not found:/
    );
  });

  it('creates the manifest and wires XPCSHELL_TESTS_MANIFESTS with --create-manifest', async () => {
    await writeText(
      join(engine, 'browser/components/mybrowser/moz.build'),
      'EXTRA_JS_MODULES.mybrowser += [\n    "MyStore.sys.mjs",\n]\n'
    );

    const result = await registerXpcshellTest(engine, dirRel, 'test_store.js', false, true);

    expect(result.skipped).toBe(false);
    expect(result.scaffoldActions?.map((a) => a.manifest)).toEqual([
      `${dirRel}/xpcshell.toml`,
      'browser/components/mybrowser/moz.build',
    ]);
    const manifest = await readText(join(engine, dirRel, 'xpcshell.toml'));
    expect(manifest).toContain('[DEFAULT]');
    expect(manifest).toContain('["test_store.js"]');
    expect(await readText(join(engine, 'browser/components/mybrowser/moz.build'))).toContain(
      'XPCSHELL_TESTS_MANIFESTS += [\n    "test/unit/xpcshell.toml",\n]'
    );
  });

  it('inserts into an existing manifest and is idempotent', async () => {
    await writeText(
      join(engine, dirRel, 'xpcshell.toml'),
      '[DEFAULT]\nhead = "head.js"\n\n["test_a.js"]\n'
    );

    const first = await registerXpcshellTest(engine, dirRel, 'test_store.js');
    expect(first.skipped).toBe(false);
    const manifest = await readText(join(engine, dirRel, 'xpcshell.toml'));
    expect(manifest).toContain('["test_store.js"]');
    expect(manifest).toContain('head = "head.js"');

    const second = await registerXpcshellTest(engine, dirRel, 'test_store.js');
    expect(second.skipped).toBe(true);
    expect(await isXpcshellTestRegistered(engine, dirRel, 'test_store.js')).toBe(true);
  });

  it('registers after an --after entry and reports it', async () => {
    await writeText(
      join(engine, dirRel, 'xpcshell.toml'),
      '[DEFAULT]\n\n["test_a.js"]\n\n["test_z.js"]\n'
    );
    const result = await registerXpcshellTest(
      engine,
      dirRel,
      'test_b.js',
      false,
      false,
      'test_z.js'
    );
    expect(result.previousEntry).toBe('["test_z.js"]');
    expect(await readText(join(engine, dirRel, 'xpcshell.toml'))).toBe(
      '[DEFAULT]\n\n["test_a.js"]\n\n["test_z.js"]\n\n["test_b.js"]\n'
    );
  });

  it('dry-run against an existing manifest does not write', async () => {
    const original = '[DEFAULT]\n\n["test_a.js"]\n';
    await writeText(join(engine, dirRel, 'xpcshell.toml'), original);

    const result = await registerXpcshellTest(engine, dirRel, 'test_store.js', true);

    expect(result.skipped).toBe(false);
    expect(await readText(join(engine, dirRel, 'xpcshell.toml'))).toBe(original);
  });
});
