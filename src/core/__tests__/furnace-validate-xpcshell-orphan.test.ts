// SPDX-License-Identifier: EUPL-1.2
/**
 * Orphan xpcshell scaffold detection for `furnace validate`.
 *
 * `furnace create --with-tests --xpcshell` writes a scaffold at
 * `browser/base/content/test/<binary>-xpcshell/<name>/`. When `furnace
 * remove` / `rename` do not touch that tree, a create → rename → remove
 * sequence leaves a scaffold whose `<name>` matches no component in
 * furnace.json. `validateAllComponents` scans the parent directory and
 * reports any entry whose name is not in `custom` / `overrides` / `stock`.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureDir, writeJson } from '../../utils/fs.js';

// Real fs + real readdir — the validator walks the engine dir directly,
// so a tmpdir fixture is the simplest way to cover the branch without
// building a detailed mock of readdir.

vi.mock('../furnace-validate-checks.js', () => ({
  validateStructure: vi.fn(() => []),
  validateAccessibility: vi.fn(() => []),
  validateCompatibility: vi.fn(() => []),
  validateTokenLink: vi.fn(() => []),
  validateRegistrationPatterns: vi.fn(() => []),
  validateJarMnEntries: vi.fn(() => []),
}));

import { validateAllComponents } from '../furnace-validate.js';

describe('validateAllComponents — orphan xpcshell scaffolds', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fireforge-validate-xpcshell-'));
    await writeJson(join(root, 'fireforge.json'), {
      name: 'Fresh',
      vendor: 'Vendor',
      appId: 'org.example.fresh',
      binaryName: 'freshforge',
      firefox: { version: '140.9.0esr', product: 'firefox-esr' },
    });
    // Minimal furnace.json: one known custom component with no scaffold.
    await writeJson(join(root, 'furnace.json'), {
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {},
    });
    // Empty components directories so the orchestration loops don't
    // surface missing-component-dir errors.
    await ensureDir(join(root, 'components/custom'));
    await ensureDir(join(root, 'components/overrides'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('flags an xpcshell scaffold whose component is not in furnace.json', async () => {
    // Deploy a scaffold for a component that no longer exists in the config.
    const scaffoldDir = join(
      root,
      'engine/browser/base/content/test/freshforge-xpcshell/moz-qa-xpc-renamed'
    );
    await ensureDir(scaffoldDir);
    await writeFile(join(scaffoldDir, 'xpcshell.toml'), '[DEFAULT]\nfirefox-appdir = "browser"\n');
    await writeFile(join(scaffoldDir, 'test_moz_qa_xpc_renamed_packaged.js'), '// stub\n');

    const results = await validateAllComponents(root);
    const orphanIssues = results.get('moz-qa-xpc-renamed') ?? [];
    expect(orphanIssues).toContainEqual(
      expect.objectContaining({
        check: 'orphan-xpcshell-scaffold',
        severity: 'error',
        component: 'moz-qa-xpc-renamed',
      })
    );
  });

  it('does not flag a scaffold whose component is still declared in furnace.json', async () => {
    // A known custom component with a scaffold under its name should
    // pass the orphan check — the validator is explicitly scoped to
    // "no matching component in furnace.json".
    await writeJson(join(root, 'furnace.json'), {
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {
        'moz-known-xpc': {
          description: 'Known xpcshell component',
          targetPath: 'toolkit/content/widgets/moz-known-xpc',
          register: false,
          localized: false,
        },
      },
    });
    await ensureDir(join(root, 'components/custom/moz-known-xpc'));
    const scaffoldDir = join(
      root,
      'engine/browser/base/content/test/freshforge-xpcshell/moz-known-xpc'
    );
    await ensureDir(scaffoldDir);
    await writeFile(join(scaffoldDir, 'xpcshell.toml'), '[DEFAULT]\n');

    const results = await validateAllComponents(root);
    const issues = results.get('moz-known-xpc') ?? [];
    expect(issues.some((issue) => issue.check === 'orphan-xpcshell-scaffold')).toBe(false);
  });

  it('does not flag chrome-doc packaging tests as component xpcshell orphans', async () => {
    const scaffoldDir = join(
      root,
      'engine/browser/base/content/test/freshforge-xpcshell/mybrowser'
    );
    await ensureDir(scaffoldDir);
    await writeFile(join(scaffoldDir, 'xpcshell.toml'), '[DEFAULT]\n');
    await writeFile(join(scaffoldDir, 'test_mybrowser_packaging.js'), '// chrome-doc probe\n');

    const results = await validateAllComponents(root);
    const issues = results.get('mybrowser') ?? [];
    expect(issues.some((issue) => issue.check === 'orphan-xpcshell-scaffold')).toBe(false);
  });

  it('stays silent on a project that never used xpcshell scaffolding', async () => {
    // No `.<binary>-xpcshell` directory at all — the check should return
    // cleanly without walking anywhere else.
    const results = await validateAllComponents(root);
    for (const issues of results.values()) {
      expect(issues.some((issue) => issue.check === 'orphan-xpcshell-scaffold')).toBe(false);
    }
  });
});
