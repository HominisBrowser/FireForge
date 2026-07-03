// SPDX-License-Identifier: EUPL-1.2
/**
 * Tests for `register --create-manifest` scaffolding (0.34.0 field
 * report): directory moz.build creation, parent DIRS wiring, and
 * XPCSHELL_TESTS_MANIFESTS wiring.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureDir, readText, writeText } from '../../utils/fs.js';
import {
  ensureParentDirsWiring,
  ensureXpcshellManifestWiring,
  scaffoldModuleMozBuild,
  upsertMozBuildListEntry,
} from '../register-scaffold.js';

describe('upsertMozBuildListEntry', () => {
  it('inserts into an existing list in mozbuild case-insensitive order', () => {
    const content = ['DIRS += [', '    "newtab",', '    "urlbar",', ']', ''].join('\n');
    const updated = upsertMozBuildListEntry(content, 'DIRS', 'mybrowser');
    expect(updated).toBe(
      ['DIRS += [', '    "mybrowser",', '    "newtab",', '    "urlbar",', ']', ''].join('\n')
    );
  });

  it('returns null when the value is already listed', () => {
    const content = 'DIRS += [\n    "mybrowser",\n]\n';
    expect(upsertMozBuildListEntry(content, 'DIRS', 'mybrowser')).toBeNull();
  });

  it('appends a fresh block when the directive does not exist', () => {
    const content = 'EXTRA_JS_MODULES += [\n    "Foo.sys.mjs",\n]\n';
    const updated = upsertMozBuildListEntry(content, 'DIRS', 'mybrowser');
    expect(updated).toContain('EXTRA_JS_MODULES');
    expect(updated).toContain('DIRS += [\n    "mybrowser",\n]');
  });

  it('does not confuse directives sharing a prefix', () => {
    // XPCSHELL_TESTS_MANIFESTS insertion must not land inside a
    // BROWSER_CHROME_MANIFESTS list.
    const content = 'BROWSER_CHROME_MANIFESTS += [\n    "test/browser.toml",\n]\n';
    const updated = upsertMozBuildListEntry(
      content,
      'XPCSHELL_TESTS_MANIFESTS',
      'test/unit/xpcshell.toml'
    );
    expect(updated).toContain('XPCSHELL_TESTS_MANIFESTS += [\n    "test/unit/xpcshell.toml",\n]');
    expect(updated).toContain('BROWSER_CHROME_MANIFESTS += [\n    "test/browser.toml",\n]');
  });
});

describe('scaffolding against a synthetic engine tree', () => {
  let engine: string;

  beforeEach(async () => {
    engine = await mkdtemp(join(tmpdir(), 'ff-register-scaffold-'));
  });

  afterEach(async () => {
    await rm(engine, { recursive: true, force: true });
  });

  it('wires DIRS into the nearest existing parent moz.build', async () => {
    await ensureDir(join(engine, 'browser/modules/mybrowser'));
    await writeText(join(engine, 'browser/modules/moz.build'), 'DIRS += [\n    "newtab",\n]\n');

    const actions = await ensureParentDirsWiring(engine, 'browser/modules/mybrowser', false);

    expect(actions).toEqual([
      { manifest: 'browser/modules/moz.build', change: 'DIRS += ["mybrowser"]' },
    ]);
    const content = await readText(join(engine, 'browser/modules/moz.build'));
    expect(content).toContain('"mybrowser",');
    expect(content.indexOf('"mybrowser"')).toBeLessThan(content.indexOf('"newtab"'));
  });

  it('creates intermediate moz.build files up to the nearest existing one', async () => {
    await writeText(join(engine, 'browser/moz.build'), 'DIRS += [\n    "base",\n]\n');
    await ensureDir(join(engine, 'browser/components/mybrowser/nested'));

    const actions = await ensureParentDirsWiring(
      engine,
      'browser/components/mybrowser/nested',
      false
    );

    expect(actions.map((a) => a.manifest)).toEqual([
      'browser/components/mybrowser/moz.build',
      'browser/components/moz.build',
      'browser/moz.build',
    ]);
    expect(await readText(join(engine, 'browser/components/mybrowser/moz.build'))).toContain(
      'DIRS += [\n    "nested",\n]'
    );
    expect(await readText(join(engine, 'browser/components/moz.build'))).toContain('"mybrowser"');
    expect(await readText(join(engine, 'browser/moz.build'))).toContain('"components"');
  });

  it('throws when no moz.build exists anywhere up to the engine root', async () => {
    await ensureDir(join(engine, 'browser/modules/mybrowser'));
    await expect(
      ensureParentDirsWiring(engine, 'browser/modules/mybrowser', false)
    ).rejects.toThrow(/No moz\.build found/);
  });

  it('is idempotent: an existing DIRS entry produces no action', async () => {
    await writeText(join(engine, 'browser/modules/moz.build'), 'DIRS += [\n    "mybrowser",\n]\n');
    const actions = await ensureParentDirsWiring(engine, 'browser/modules/mybrowser', false);
    expect(actions).toEqual([]);
  });

  it('scaffolds a module moz.build with the namespaced EXTRA_JS_MODULES list', async () => {
    await writeText(join(engine, 'browser/modules/moz.build'), 'DIRS += [\n    "newtab",\n]\n');
    await ensureDir(join(engine, 'browser/modules/mybrowser'));

    const actions = await scaffoldModuleMozBuild(
      engine,
      'browser/modules/mybrowser',
      'MyStore.sys.mjs',
      false
    );

    const scaffolded = await readText(join(engine, 'browser/modules/mybrowser/moz.build'));
    expect(scaffolded).toContain('This Source Code Form is subject to the terms');
    expect(scaffolded).toContain('EXTRA_JS_MODULES.mybrowser += [\n    "MyStore.sys.mjs",\n]');
    expect(actions.some((a) => a.manifest === 'browser/modules/moz.build')).toBe(true);
    expect(await readText(join(engine, 'browser/modules/moz.build'))).toContain('"mybrowser"');
  });

  it('dry-run reports actions without writing anything', async () => {
    await writeText(join(engine, 'browser/modules/moz.build'), 'DIRS += [\n    "newtab",\n]\n');
    await ensureDir(join(engine, 'browser/modules/mybrowser'));

    const actions = await scaffoldModuleMozBuild(
      engine,
      'browser/modules/mybrowser',
      'MyStore.sys.mjs',
      true
    );

    expect(actions.length).toBeGreaterThan(0);
    await expect(readText(join(engine, 'browser/modules/mybrowser/moz.build'))).rejects.toThrow();
    expect(await readText(join(engine, 'browser/modules/moz.build'))).not.toContain('"mybrowser"');
  });

  it('wires XPCSHELL_TESTS_MANIFESTS into the nearest existing moz.build', async () => {
    await writeText(
      join(engine, 'browser/components/mybrowser/moz.build'),
      'EXTRA_JS_MODULES.mybrowser += [\n    "MyStore.sys.mjs",\n]\n'
    );
    await ensureDir(join(engine, 'browser/components/mybrowser/test/unit'));

    const actions = await ensureXpcshellManifestWiring(
      engine,
      'browser/components/mybrowser/test/unit/xpcshell.toml',
      false
    );

    expect(actions).toEqual([
      {
        manifest: 'browser/components/mybrowser/moz.build',
        change: 'XPCSHELL_TESTS_MANIFESTS += ["test/unit/xpcshell.toml"]',
      },
    ]);
    expect(await readText(join(engine, 'browser/components/mybrowser/moz.build'))).toContain(
      'XPCSHELL_TESTS_MANIFESTS += [\n    "test/unit/xpcshell.toml",\n]'
    );
  });

  it('XPCSHELL wiring is idempotent', async () => {
    await writeText(
      join(engine, 'browser/components/mybrowser/moz.build'),
      'XPCSHELL_TESTS_MANIFESTS += [\n    "test/unit/xpcshell.toml",\n]\n'
    );
    const actions = await ensureXpcshellManifestWiring(
      engine,
      'browser/components/mybrowser/test/unit/xpcshell.toml',
      false
    );
    expect(actions).toEqual([]);
  });
});
