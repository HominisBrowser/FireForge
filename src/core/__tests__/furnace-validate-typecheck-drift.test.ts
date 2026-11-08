// SPDX-License-Identifier: EUPL-1.2
/**
 * `furnace validate` drift findings for the files Furnace maintains for a
 * consumer typecheck: each `typecheckJsconfig` entry and `typecheckTagMap`.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureDir, writeJson } from '../../utils/fs.js';

vi.mock('../furnace-validate-checks.js', () => ({
  validateStructure: vi.fn(() => []),
  validateAccessibility: vi.fn(() => []),
  validateCompatibility: vi.fn(() => []),
  validateTokenLink: vi.fn(() => []),
  validateRegistrationPatterns: vi.fn(() => []),
  validateJarMnEntries: vi.fn(() => []),
}));

import { reportJsconfigPathsSync } from '../furnace-jsconfig.js';
import { validateAllComponents } from '../furnace-validate.js';

describe('validateAllComponents — typecheck file drift', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fireforge-validate-typecheck-'));
    await writeJson(join(root, 'fireforge.json'), {
      name: 'Fresh',
      vendor: 'Vendor',
      appId: 'org.example.fresh',
      binaryName: 'freshforge',
      firefox: { version: '140.9.0esr', product: 'firefox-esr' },
    });
    await writeJson(join(root, 'furnace.json'), {
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {
        'moz-x': {
          description: 'x',
          targetPath: 'toolkit/content/widgets/moz-x',
          register: true,
          localized: false,
        },
      },
      typecheckJsconfig: ['a/jsconfig.json', 'b/jsconfig.json'],
      typecheckTagMap: 'types/tags.d.ts',
    });
    await ensureDir(join(root, 'components/custom/moz-x'));
    await ensureDir(join(root, 'components/overrides'));
    await writeFile(
      join(root, 'components/custom/moz-x/moz-x.mjs'),
      'export class MozX extends HTMLElement {}\ncustomElements.define("moz-x", MozX);\n'
    );
    await ensureDir(join(root, 'a'));
    await ensureDir(join(root, 'b'));
    await writeFile(join(root, 'a/jsconfig.json'), '{}\n');
    await writeFile(join(root, 'b/jsconfig.json'), '{}\n');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('names each stale jsconfig and a stale tag map, and clears once deployed', async () => {
    const drift = (await validateAllComponents(root)).get('furnace') ?? [];
    expect(drift.map((issue) => [issue.check, issue.message.split(' ')[0]])).toEqual([
      ['jsconfig-paths-drift', 'a/jsconfig.json'],
      ['jsconfig-paths-drift', 'b/jsconfig.json'],
      ['tag-map-drift', 'types/tags.d.ts'],
    ]);

    const { loadFurnaceConfig } = await import('../furnace-config.js');
    await reportJsconfigPathsSync(root, await loadFurnaceConfig(root), false);
    expect((await validateAllComponents(root)).get('furnace') ?? []).toEqual([]);
  });

  it('in source mode judges the tracked copy of an engine/ jsconfig as an error naming furnace types', async () => {
    await writeJson(join(root, 'fireforge.json'), {
      name: 'Fresh',
      vendor: 'Vendor',
      appId: 'org.example.fresh',
      binaryName: 'freshforge',
      firefox: { version: '140.9.0esr', product: 'firefox-esr' },
      test: { reapOrphans: 'owned' },
      sources: {
        schemaVersion: 1,
        mode: 'authored',
        root: 'src',
        metadataRoot: '.fireforge-sources',
        pristineCommit: 'a'.repeat(40),
      },
    });
    const { loadFurnaceConfig } = await import('../furnace-config.js');
    const config = await loadFurnaceConfig(root);
    await writeJson(join(root, 'furnace.json'), {
      ...config,
      typecheckJsconfig: ['engine/browser/base/content/jsconfig.json'],
    });
    await ensureDir(join(root, 'src/browser/base/content'));
    await writeFile(join(root, 'src/browser/base/content/jsconfig.json'), '{}\n');

    const drift = (await validateAllComponents(root)).get('furnace') ?? [];
    expect(drift.map((issue) => [issue.check, issue.severity])).toEqual([
      ['jsconfig-paths-drift', 'error'],
      ['tag-map-drift', 'error'],
    ]);
    expect(drift[0]?.message).toContain('Run "fireforge furnace types"');
    expect(drift[1]?.message).toBe(
      'types/tags.d.ts does not exist. Run "fireforge furnace types" and commit the result.'
    );

    await reportJsconfigPathsSync(root, await loadFurnaceConfig(root), false, undefined, 'src');
    expect((await validateAllComponents(root)).get('furnace') ?? []).toEqual([]);
    // Paths are computed for engine/browser/base/content, four levels below the root.
    const written = JSON.parse(
      await readFile(join(root, 'src/browser/base/content/jsconfig.json'), 'utf8')
    ) as { compilerOptions: { paths: Record<string, string[]> } };
    expect(written.compilerOptions.paths).toEqual({
      'chrome://global/content/elements/moz-x.mjs': [
        '../../../../components/custom/moz-x/moz-x.mjs',
      ],
    });
  });
});
