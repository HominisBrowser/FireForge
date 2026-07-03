// SPDX-License-Identifier: EUPL-1.2
/**
 * Tests for xpcshell test-file registration (0.34.0 field report:
 * `test_*.js` files rejected as "Unknown file pattern") and for the
 * relaxed pattern rules (nested browser.toml, xpcshell test files).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureDir, readText, writeText } from '../../utils/fs.js';
import { getRules } from '../manifest-rules.js';
import {
  insertXpcshellManifestSection,
  isXpcshellTestRegistered,
  registerXpcshellTest,
} from '../register-xpcshell-test.js';

describe('pattern rules (0.34.0 additions)', () => {
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

  it('dry-run against an existing manifest does not write', async () => {
    const original = '[DEFAULT]\n\n["test_a.js"]\n';
    await writeText(join(engine, dirRel, 'xpcshell.toml'), original);

    const result = await registerXpcshellTest(engine, dirRel, 'test_store.js', true);

    expect(result.skipped).toBe(false);
    expect(await readText(join(engine, dirRel, 'xpcshell.toml'))).toBe(original);
  });
});
