// SPDX-License-Identifier: EUPL-1.2
/**
 * Tests for Furnace-maintained jsconfig `compilerOptions.paths` entries
 * (field report D3). Real temp directories — the module's contract is
 * mostly about what it writes and, just as importantly, what it refuses
 * to touch.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempProject, removeTempProject } from '../../test-utils/index.js';
import type { FurnaceConfig } from '../../types/furnace.js';
import { readJson } from '../../utils/fs.js';
import { findJsconfigPathsDrift, syncFurnaceJsconfigPaths } from '../furnace-jsconfig.js';

interface JsconfigFixture {
  compilerOptions?: {
    paths?: Record<string, string[]>;
    checkJs?: boolean;
    [key: string]: unknown;
  };
  include?: string[];
  [key: string]: unknown;
}

function makeConfig(custom: FurnaceConfig['custom']): FurnaceConfig {
  return {
    version: 1,
    componentPrefix: 'moz-',
    stock: [],
    overrides: {},
    custom,
    typecheckJsconfig: 'tools/jsconfig.json',
  };
}

describe('syncFurnaceJsconfigPaths', () => {
  let projectRoot: string;
  let jsconfigPath: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-jsconfig-');
    await mkdir(join(projectRoot, 'tools'), { recursive: true });
    jsconfigPath = join(projectRoot, 'tools', 'jsconfig.json');
  });
  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  async function seedComponent(name: string, files: string[]): Promise<void> {
    const dir = join(projectRoot, 'components', 'custom', name);
    await mkdir(dir, { recursive: true });
    for (const file of files) {
      await writeFile(join(dir, file), '// module\n');
    }
  }

  it('adds chrome-module entries for every .mjs of registered custom components', async () => {
    await seedComponent('moz-widget', ['moz-widget.mjs', 'widget-helper.mjs', 'moz-widget.css']);
    await writeFile(jsconfigPath, JSON.stringify({ compilerOptions: { checkJs: true } }) + '\n');

    const result = await syncFurnaceJsconfigPaths(
      projectRoot,
      makeConfig({
        'moz-widget': {
          description: 'Widget',
          targetPath: 'toolkit/content/widgets/moz-widget',
          register: true,
          localized: false,
        },
      })
    );

    expect(result.changed).toBe(true);
    expect(result.added.sort()).toEqual([
      'chrome://global/content/elements/moz-widget.mjs',
      'chrome://global/content/elements/widget-helper.mjs',
    ]);

    const written = await readJson<JsconfigFixture>(jsconfigPath);
    expect(written.compilerOptions?.checkJs).toBe(true);
    expect(written.compilerOptions?.paths).toEqual({
      'chrome://global/content/elements/moz-widget.mjs': [
        '../components/custom/moz-widget/moz-widget.mjs',
      ],
      'chrome://global/content/elements/widget-helper.mjs': [
        '../components/custom/moz-widget/widget-helper.mjs',
      ],
    });
    // No baseUrl is required or written — paths resolve against the
    // config directory (baseUrl is deprecated territory in newer TS).
    expect(written.compilerOptions).not.toHaveProperty('baseUrl');
  });

  it('preserves unmanaged paths entries and unrelated jsconfig fields verbatim', async () => {
    await seedComponent('moz-widget', ['moz-widget.mjs']);
    await writeFile(
      jsconfigPath,
      JSON.stringify({
        compilerOptions: {
          checkJs: true,
          paths: {
            // Hand-written entry pointing outside the Furnace workspace —
            // same chrome prefix, but not Furnace-managed.
            'chrome://global/content/elements/upstream-widget.mjs': [
              '../engine/toolkit/content/widgets/upstream-widget.mjs',
            ],
            'resource:///modules/*': ['../engine/browser/modules/*'],
          },
        },
        include: ['../components/**/*.mjs'],
      }) + '\n'
    );

    await syncFurnaceJsconfigPaths(
      projectRoot,
      makeConfig({
        'moz-widget': {
          description: 'Widget',
          targetPath: 'toolkit/content/widgets/moz-widget',
          register: true,
          localized: false,
        },
      })
    );

    const written = await readJson<JsconfigFixture>(jsconfigPath);
    expect(written.include).toEqual(['../components/**/*.mjs']);
    expect(written.compilerOptions?.paths).toMatchObject({
      'chrome://global/content/elements/upstream-widget.mjs': [
        '../engine/toolkit/content/widgets/upstream-widget.mjs',
      ],
      'resource:///modules/*': ['../engine/browser/modules/*'],
      'chrome://global/content/elements/moz-widget.mjs': [
        '../components/custom/moz-widget/moz-widget.mjs',
      ],
    });
  });

  it('prunes managed entries when their helper is removed (composes with D1 pruning)', async () => {
    await seedComponent('moz-widget', ['moz-widget.mjs']);
    await writeFile(
      jsconfigPath,
      JSON.stringify({
        compilerOptions: {
          paths: {
            'chrome://global/content/elements/moz-widget.mjs': [
              '../components/custom/moz-widget/moz-widget.mjs',
            ],
            'chrome://global/content/elements/widget-helper-old.mjs': [
              '../components/custom/moz-widget/widget-helper-old.mjs',
            ],
          },
        },
      }) + '\n'
    );

    const result = await syncFurnaceJsconfigPaths(
      projectRoot,
      makeConfig({
        'moz-widget': {
          description: 'Widget',
          targetPath: 'toolkit/content/widgets/moz-widget',
          register: true,
          localized: false,
        },
      })
    );

    expect(result.pruned).toEqual(['chrome://global/content/elements/widget-helper-old.mjs']);
    const written = await readJson<JsconfigFixture>(jsconfigPath);
    expect(Object.keys(written.compilerOptions?.paths ?? {})).toEqual([
      'chrome://global/content/elements/moz-widget.mjs',
    ]);
  });

  it('skips unregistered components and is a no-op without typecheckJsconfig', async () => {
    await seedComponent('moz-quiet', ['moz-quiet.mjs']);
    await writeFile(jsconfigPath, JSON.stringify({}) + '\n');

    const unregistered = await syncFurnaceJsconfigPaths(
      projectRoot,
      makeConfig({
        'moz-quiet': {
          description: 'Unregistered',
          targetPath: 'browser/components/quiet',
          register: false,
          localized: false,
        },
      })
    );
    expect(unregistered.changed).toBe(false);

    const config = makeConfig({});
    delete config.typecheckJsconfig;
    const disabled = await syncFurnaceJsconfigPaths(projectRoot, config);
    expect(disabled.changed).toBe(false);
  });

  it('is idempotent: a second run reports no changes', async () => {
    await seedComponent('moz-widget', ['moz-widget.mjs', 'widget-helper.mjs']);
    await writeFile(jsconfigPath, JSON.stringify({}) + '\n');
    const config = makeConfig({
      'moz-widget': {
        description: 'Widget',
        targetPath: 'toolkit/content/widgets/moz-widget',
        register: true,
        localized: false,
      },
    });

    const first = await syncFurnaceJsconfigPaths(projectRoot, config);
    expect(first.changed).toBe(true);
    const second = await syncFurnaceJsconfigPaths(projectRoot, config);
    expect(second.changed).toBe(false);
  });

  it('dry-run reports the diff without writing', async () => {
    await seedComponent('moz-widget', ['moz-widget.mjs']);
    const original = JSON.stringify({ compilerOptions: { checkJs: true } }) + '\n';
    await writeFile(jsconfigPath, original);
    const config = makeConfig({
      'moz-widget': {
        description: 'Widget',
        targetPath: 'toolkit/content/widgets/moz-widget',
        register: true,
        localized: false,
      },
    });

    const drift = await findJsconfigPathsDrift(projectRoot, config);
    expect(drift.changed).toBe(true);
    expect(drift.added).toEqual(['chrome://global/content/elements/moz-widget.mjs']);

    const { readFile } = await import('node:fs/promises');
    expect(await readFile(jsconfigPath, 'utf-8')).toBe(original);
  });

  it('errors with guidance when the configured jsconfig is missing', async () => {
    await expect(syncFurnaceJsconfigPaths(projectRoot, makeConfig({}))).rejects.toThrow(
      /typecheckJsconfig.*does not exist/s
    );
  });

  it('errors clearly on JSONC content (comments are not plain JSON)', async () => {
    await writeFile(jsconfigPath, '{\n  // comment\n  "compilerOptions": {}\n}\n');

    await expect(syncFurnaceJsconfigPaths(projectRoot, makeConfig({}))).rejects.toThrow(/JSONC/);
  });
});
