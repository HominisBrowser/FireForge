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
import { readJson, readText } from '../../utils/fs.js';
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

  it('maps unregistered components too — their files deploy under the elements chrome URL', async () => {
    // Deploy copies files and writes jar.mn `content/global/elements/…`
    // entries regardless of `register` (only the customElements.js
    // registration is gated), so an unregistered component's imports are
    // just as real. Pre-0.41.0 the sync skipped them and their chrome
    // imports silently degraded to the wildcard `any` shim.
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
    expect(unregistered.changed).toBe(true);
    expect(unregistered.added).toEqual(['chrome://global/content/elements/moz-quiet.mjs']);
  });

  it('maps a register:false library component (kind: "library" requires register: false)', async () => {
    await seedComponent('moz-shared', ['widget-base.mjs']);
    await writeFile(jsconfigPath, JSON.stringify({}) + '\n');

    const result = await syncFurnaceJsconfigPaths(
      projectRoot,
      makeConfig({
        'moz-shared': {
          description: 'Shared base classes',
          targetPath: 'toolkit/content/widgets/moz-shared',
          register: false,
          kind: 'library',
          localized: false,
        },
      })
    );
    expect(result.added).toEqual(['chrome://global/content/elements/widget-base.mjs']);

    const written = await readJson<JsconfigFixture>(jsconfigPath);
    expect(written.compilerOptions?.paths).toEqual({
      'chrome://global/content/elements/widget-base.mjs': [
        '../components/custom/moz-shared/widget-base.mjs',
      ],
    });
  });

  it('keeps (never prunes) a hand-written mapping for an unregistered component', async () => {
    // Pre-0.41.0 such an entry passed isManagedEntry but was absent from
    // the desired set, so every sync pruned it as "stale" — a hand mapping
    // was not a durable workaround.
    await seedComponent('moz-shared', ['widget-base.mjs']);
    await writeFile(
      jsconfigPath,
      JSON.stringify({
        compilerOptions: {
          paths: {
            'chrome://global/content/elements/widget-base.mjs': [
              '../components/custom/moz-shared/widget-base.mjs',
            ],
          },
        },
      }) + '\n'
    );

    const result = await syncFurnaceJsconfigPaths(
      projectRoot,
      makeConfig({
        'moz-shared': {
          description: 'Shared base classes',
          targetPath: 'toolkit/content/widgets/moz-shared',
          register: false,
          kind: 'library',
          localized: false,
        },
      })
    );
    expect(result.pruned).toEqual([]);
    expect(result.changed).toBe(false);

    const written = await readJson<JsconfigFixture>(jsconfigPath);
    expect(written.compilerOptions?.paths).toEqual({
      'chrome://global/content/elements/widget-base.mjs': [
        '../components/custom/moz-shared/widget-base.mjs',
      ],
    });
  });

  it('is a no-op without typecheckJsconfig', async () => {
    const config = makeConfig({});
    delete config.typecheckJsconfig;
    const disabled = await syncFurnaceJsconfigPaths(projectRoot, config);
    expect(disabled.changed).toBe(false);
  });

  it('is idempotent: a second run reports no changes', async () => {
    await seedComponent('moz-widget', ['moz-widget.mjs', 'widget-helper.mjs']);
    await seedComponent('moz-shared', ['widget-base.mjs']);
    await writeFile(jsconfigPath, JSON.stringify({}) + '\n');
    const config = makeConfig({
      'moz-widget': {
        description: 'Widget',
        targetPath: 'toolkit/content/widgets/moz-widget',
        register: true,
        localized: false,
      },
      'moz-shared': {
        description: 'Shared base classes',
        targetPath: 'toolkit/content/widgets/moz-shared',
        register: false,
        kind: 'library',
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

  it('errors with guidance when the JSONC file cannot be parsed', async () => {
    await writeFile(jsconfigPath, '{ "compilerOptions": ');

    await expect(syncFurnaceJsconfigPaths(projectRoot, makeConfig({}))).rejects.toThrow(
      /Could not parse tools\/jsconfig\.json as JSONC/
    );
  });

  it('errors with guidance when the JSONC root is not an object', async () => {
    await writeFile(jsconfigPath, '[]\n');

    await expect(syncFurnaceJsconfigPaths(projectRoot, makeConfig({}))).rejects.toThrow(
      /expected an object jsconfig file/
    );
  });

  it('preserves JSONC comments while editing managed paths', async () => {
    await seedComponent('moz-widget', ['moz-widget.mjs']);
    await writeFile(jsconfigPath, '{\n  // comment\n  "compilerOptions": {}\n}\n');

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
    const written = await readText(jsconfigPath);
    expect(written).toContain('// comment');
    expect(written).toContain('chrome://global/content/elements/moz-widget.mjs');
  });

  it('updates a managed chrome-module entry when its target changed', async () => {
    await seedComponent('moz-widget', ['moz-widget.mjs']);
    await writeFile(
      jsconfigPath,
      JSON.stringify({
        compilerOptions: {
          paths: {
            'chrome://global/content/elements/moz-widget.mjs': [
              '../components/custom/moz-widget/old-location.mjs',
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

    expect(result.updated).toEqual(['chrome://global/content/elements/moz-widget.mjs']);
    const written = await readJson<JsconfigFixture>(jsconfigPath);
    expect(written.compilerOptions?.paths).toMatchObject({
      'chrome://global/content/elements/moz-widget.mjs': [
        '../components/custom/moz-widget/moz-widget.mjs',
      ],
    });
  });
});

// ── Item D (0.32.0): root-level jsconfig must emit ./-relative paths (TS5090) ──
describe('syncFurnaceJsconfigPaths — root-level jsconfig (./-relative, TS5090)', () => {
  let projectRoot: string;
  let rootJsconfigPath: string;

  // jsconfig sits beside the components tree (no `tools/` hop), so
  // `relative()` would yield a bare `components/...` value that TS rejects
  // without baseUrl.
  function rootConfig(): FurnaceConfig {
    return {
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {
        'moz-widget': {
          description: 'Widget',
          targetPath: 'toolkit/content/widgets/moz-widget',
          register: true,
          localized: false,
        },
      },
      typecheckJsconfig: 'jsconfig.json',
    };
  }

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-jsconfig-root-');
    rootJsconfigPath = join(projectRoot, 'jsconfig.json');
    const dir = join(projectRoot, 'components', 'custom', 'moz-widget');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'moz-widget.mjs'), '// module\n');
  });
  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('emits a ./-prefixed relative value and no baseUrl', async () => {
    await writeFile(
      rootJsconfigPath,
      JSON.stringify({ compilerOptions: { checkJs: true } }) + '\n'
    );

    await syncFurnaceJsconfigPaths(projectRoot, rootConfig());

    const written = await readJson<JsconfigFixture>(rootJsconfigPath);
    expect(written.compilerOptions?.paths).toEqual({
      'chrome://global/content/elements/moz-widget.mjs': [
        './components/custom/moz-widget/moz-widget.mjs',
      ],
    });
    expect(written.compilerOptions).not.toHaveProperty('baseUrl');
  });

  it('is a no-op on the second run (no stale rewrite of the ./-prefixed value)', async () => {
    await writeFile(rootJsconfigPath, JSON.stringify({}) + '\n');
    const config = rootConfig();

    const first = await syncFurnaceJsconfigPaths(projectRoot, config);
    expect(first.changed).toBe(true);
    const second = await syncFurnaceJsconfigPaths(projectRoot, config);
    expect(second.changed).toBe(false);
    expect(second.updated).toEqual([]);
  });

  it('does not churn a hand-written bare or ./-prefixed value (both treated as non-stale)', async () => {
    const key = 'chrome://global/content/elements/moz-widget.mjs';
    for (const handWritten of [
      'components/custom/moz-widget/moz-widget.mjs', // bare (legacy / workaround)
      './components/custom/moz-widget/moz-widget.mjs', // already prefixed
    ]) {
      await writeFile(
        rootJsconfigPath,
        JSON.stringify({ compilerOptions: { paths: { [key]: [handWritten] } } }) + '\n'
      );
      const result = await syncFurnaceJsconfigPaths(projectRoot, rootConfig());
      expect(result.changed).toBe(false);
      expect(result.updated).toEqual([]);
      const written = await readJson<JsconfigFixture>(rootJsconfigPath);
      // The operator's chosen form is preserved verbatim.
      expect(written.compilerOptions?.paths?.[key]).toEqual([handWritten]);
    }
  });

  it('the emitted paths type-check under TypeScript without baseUrl (no TS5090, no TS5101)', async () => {
    await writeFile(rootJsconfigPath, JSON.stringify({}) + '\n');
    await syncFurnaceJsconfigPaths(projectRoot, rootConfig());
    const written = await readJson<JsconfigFixture>(rootJsconfigPath);

    const ts = await import('typescript');
    const probe = join(projectRoot, 'probe.ts');
    await writeFile(probe, 'export const x = 1;\n');

    const buildDiagnostics = (compilerOptions: Record<string, unknown>): number[] => {
      const { options } = ts.convertCompilerOptionsFromJson(compilerOptions, projectRoot);
      const program = ts.createProgram([probe], options);
      return [...program.getOptionsDiagnostics()].map((d) => d.code);
    };

    // Synced (./-prefixed) options raise neither the non-relative-paths
    // error (TS5090) nor the baseUrl-deprecated error (TS5101).
    const synced = buildDiagnostics(written.compilerOptions ?? {});
    expect(synced).not.toContain(5090);
    expect(synced).not.toContain(5101);

    // Control: the bare form TS5090s — proving the ./ prefix is what avoids it.
    const bare = buildDiagnostics({
      paths: {
        'chrome://global/content/elements/moz-widget.mjs': [
          'components/custom/moz-widget/moz-widget.mjs',
        ],
      },
    });
    expect(bare).toContain(5090);
  });
});
