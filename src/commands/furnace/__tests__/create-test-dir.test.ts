// SPDX-License-Identifier: EUPL-1.2
/**
 * Tests for `furnace create --test-dir` and the collision safety added in
 * 0.34.0 (field report: the scaffold targeted .../test/<binaryName>/
 * unconditionally and would have overwritten an existing
 * browser.toml/head.js owned by a different patch).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureDir, readText, writeText } from '../../../utils/fs.js';
import { resolveTestDirOverride, scaffoldTestFiles } from '../create-browser-test.js';
import { scaffoldXpcshellTestFiles } from '../create-xpcshell.js';

describe('resolveTestDirOverride', () => {
  it('accepts engine-relative directories under browser/base/content/test/', () => {
    expect(resolveTestDirOverride('browser/base/content/test/mybrowser-widgets')).toBe(
      'browser/base/content/test/mybrowser-widgets'
    );
    // engine/ prefix and trailing slash are normalized away.
    expect(resolveTestDirOverride('engine/browser/base/content/test/foo/')).toBe(
      'browser/base/content/test/foo'
    );
  });

  it('rejects directories outside the test scaffold root', () => {
    expect(() => resolveTestDirOverride('browser/components/foo')).toThrow(/--test-dir/);
    expect(() => resolveTestDirOverride('browser/base/content/test')).toThrow(/--test-dir/);
  });
});

describe('scaffoldTestFiles (browser-chrome)', () => {
  let projectRoot: string;
  let engine: string;
  const forgeConfig = { binaryName: 'mybrowser' };

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'ff-create-test-dir-'));
    engine = join(projectRoot, 'engine');
    await ensureDir(engine);
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('scaffolds into the default directory without --test-dir', async () => {
    await scaffoldTestFiles('moz-panel', 'MPL-2.0', forgeConfig, { engine });

    const toml = await readText(join(engine, 'browser/base/content/test/mybrowser/browser.toml'));
    expect(toml).toContain('["browser_mybrowser_panel.js"]');
    expect(toml).toContain('support-files = ["head.js"]');
  });

  it('redirects the scaffold with --test-dir', async () => {
    const override = 'browser/base/content/test/mybrowser-widgets';
    await scaffoldTestFiles('moz-panel', 'MPL-2.0', forgeConfig, { engine }, undefined, override);

    const toml = await readText(join(engine, override, 'browser.toml'));
    expect(toml).toContain('["browser_mybrowser_panel.js"]');
    const testJs = await readText(join(engine, override, 'browser_mybrowser_panel.js'));
    expect(testJs).toContain('moz-panel');
  });

  it('appends to an existing browser.toml and never clobbers head.js or test files', async () => {
    const dir = join(engine, 'browser/base/content/test/mybrowser');
    await ensureDir(dir);
    const existingToml =
      '[DEFAULT]\nsupport-files = ["head.js", "other-fixture.html"]\n\n["browser_other_patch.js"]\n';
    const existingHead = '// head.js owned by another patch\n';
    const existingTest = '// existing test owned by another patch\n';
    await writeText(join(dir, 'browser.toml'), existingToml);
    await writeText(join(dir, 'head.js'), existingHead);
    await writeText(join(dir, 'browser_mybrowser_panel.js'), existingTest);

    await scaffoldTestFiles('moz-panel', 'MPL-2.0', forgeConfig, { engine });

    const toml = await readText(join(dir, 'browser.toml'));
    // Existing entries and support-files kept; new entry appended.
    expect(toml).toContain('["browser_other_patch.js"]');
    expect(toml).toContain('other-fixture.html');
    expect(toml).toContain('["browser_mybrowser_panel.js"]');
    // Owned files untouched.
    expect(await readText(join(dir, 'head.js'))).toBe(existingHead);
    expect(await readText(join(dir, 'browser_mybrowser_panel.js'))).toBe(existingTest);
  });

  it('registers a nested --test-dir manifest under browser/base/moz.build', async () => {
    await writeText(
      join(engine, 'browser/base/moz.build'),
      'BROWSER_CHROME_MANIFESTS += [\n    "content/test/about/browser.toml",\n]\n'
    );
    const override = 'browser/base/content/test/mybrowser/widgets';
    await scaffoldTestFiles('moz-panel', 'MPL-2.0', forgeConfig, { engine }, undefined, override);

    const mozBuild = await readText(join(engine, 'browser/base/moz.build'));
    expect(mozBuild).toContain('"content/test/mybrowser/widgets/browser.toml",');
  });
});

describe('scaffoldXpcshellTestFiles collision safety', () => {
  let projectRoot: string;
  let engine: string;
  const forgeConfig = { binaryName: 'mybrowser' };

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'ff-create-xpcshell-dir-'));
    engine = join(projectRoot, 'engine');
    await ensureDir(engine);
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('appends to an existing xpcshell.toml instead of scaffolding over it', async () => {
    const dir = join(engine, 'browser/base/content/test/mybrowser-xpcshell/moz-panel');
    await ensureDir(dir);
    const existing = '[DEFAULT]\nhead = "head.js"\n\n["test_other_patch.js"]\n';
    await writeText(join(dir, 'xpcshell.toml'), existing);

    await scaffoldXpcshellTestFiles('moz-panel', 'MPL-2.0', forgeConfig, { engine });

    const toml = await readText(join(dir, 'xpcshell.toml'));
    expect(toml).toContain('["test_other_patch.js"]');
    expect(toml).toContain('head = "head.js"');
    expect(toml).toContain('["test_moz_panel_packaged.js"]');
  });

  it('keeps an existing test file instead of overwriting it', async () => {
    const dir = join(engine, 'browser/base/content/test/mybrowser-xpcshell/moz-panel');
    await ensureDir(dir);
    const existingTest = '// test owned by another patch\n';
    await writeText(join(dir, 'test_moz_panel_packaged.js'), existingTest);

    await scaffoldXpcshellTestFiles('moz-panel', 'MPL-2.0', forgeConfig, { engine });

    expect(await readText(join(dir, 'test_moz_panel_packaged.js'))).toBe(existingTest);
  });

  it('honours a --test-dir override as the final directory', async () => {
    const override = 'browser/base/content/test/mybrowser-storage';
    await scaffoldXpcshellTestFiles(
      'moz-panel',
      'MPL-2.0',
      forgeConfig,
      { engine },
      undefined,
      override
    );

    const toml = await readText(join(engine, override, 'xpcshell.toml'));
    expect(toml).toContain('test_moz_panel_packaged.js');
  });
});
