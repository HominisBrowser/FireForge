// SPDX-License-Identifier: EUPL-1.2
/**
 * Tests for Furnace-maintained jsconfig `compilerOptions.paths` entries.
 * Real temp directories. The module's contract is about what it writes and
 * about what it refuses to touch.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempProject, removeTempProject } from '../../test-utils/index.js';
import { createLoggerMock } from '../../test-utils/module-mocks.js';
import type { CustomComponentConfig, FurnaceConfig } from '../../types/furnace.js';
import { readJson, readText } from '../../utils/fs.js';
import { info } from '../../utils/logger.js';
import {
  findJsconfigPathsDrift,
  type JsconfigSyncResult,
  reportJsconfigPathsSync,
  syncFurnaceJsconfigPaths,
  typecheckJsconfigList,
} from '../furnace-jsconfig.js';
import { syncFurnaceTagMap } from '../furnace-tag-map.js';

vi.mock('../../utils/logger.js', () => createLoggerMock());

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

/** Syncs a config that names exactly one jsconfig and returns its result. */
async function syncOne(
  root: string,
  config: FurnaceConfig,
  options?: { dryRun?: boolean }
): Promise<JsconfigSyncResult> {
  const results = await syncFurnaceJsconfigPaths(root, config, options);
  expect(results).toHaveLength(1);
  return results[0] as JsconfigSyncResult;
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

    const result = await syncOne(
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
    // No baseUrl is required or written. Paths resolve against the config
    // directory (baseUrl is deprecated territory in newer TS).
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
            // Hand-written entry pointing outside the Furnace workspace:
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

    await syncOne(
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

    const result = await syncOne(
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
    // just as real. Skipping them silently degrades their chrome imports to
    // the wildcard `any` shim.
    await seedComponent('moz-quiet', ['moz-quiet.mjs']);
    await writeFile(jsconfigPath, JSON.stringify({}) + '\n');

    const unregistered = await syncOne(
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

    const result = await syncOne(
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
    // Such an entry passes isManagedEntry but is absent from the desired
    // set, so a naive sync prunes it as "stale" and a hand mapping is not a
    // durable workaround.
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

    const result = await syncOne(
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
    expect(await syncFurnaceJsconfigPaths(projectRoot, config)).toEqual([]);
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

    const first = await syncOne(projectRoot, config);
    expect(first.changed).toBe(true);
    const second = await syncOne(projectRoot, config);
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

    const drift = await findJsconfigPathsDrift(projectRoot, config, 'tools/jsconfig.json');
    expect(drift.changed).toBe(true);
    expect(drift.added).toEqual(['chrome://global/content/elements/moz-widget.mjs']);

    const { readFile } = await import('node:fs/promises');
    expect(await readFile(jsconfigPath, 'utf-8')).toBe(original);
  });

  it('errors with guidance when the configured jsconfig is missing', async () => {
    await expect(syncOne(projectRoot, makeConfig({}))).rejects.toThrow(
      /typecheckJsconfig.*does not exist/s
    );
  });

  it('errors with guidance when the JSONC file cannot be parsed', async () => {
    await writeFile(jsconfigPath, '{ "compilerOptions": ');

    await expect(syncOne(projectRoot, makeConfig({}))).rejects.toThrow(
      /Could not parse tools\/jsconfig\.json as JSONC/
    );
  });

  it('errors with guidance when the JSONC root is not an object', async () => {
    await writeFile(jsconfigPath, '[]\n');

    await expect(syncOne(projectRoot, makeConfig({}))).rejects.toThrow(
      /expected an object jsconfig file/
    );
  });

  it('preserves JSONC comments while editing managed paths', async () => {
    await seedComponent('moz-widget', ['moz-widget.mjs']);
    await writeFile(jsconfigPath, '{\n  // comment\n  "compilerOptions": {}\n}\n');

    const result = await syncOne(
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

    const result = await syncOne(
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

// A root-level jsconfig must emit ./-relative paths (TS5090).
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

    await syncOne(projectRoot, rootConfig());

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

    const first = await syncOne(projectRoot, config);
    expect(first.changed).toBe(true);
    const second = await syncOne(projectRoot, config);
    expect(second.changed).toBe(false);
    expect(second.updated).toEqual([]);
  });

  it('does not churn a hand-written bare or ./-prefixed value (both treated as non-stale)', async () => {
    const key = 'chrome://global/content/elements/moz-widget.mjs';
    for (const handWritten of [
      'components/custom/moz-widget/moz-widget.mjs', // bare (hand-written workaround)
      './components/custom/moz-widget/moz-widget.mjs', // already prefixed
    ]) {
      await writeFile(
        rootJsconfigPath,
        JSON.stringify({ compilerOptions: { paths: { [key]: [handWritten] } } }) + '\n'
      );
      const result = await syncOne(projectRoot, rootConfig());
      expect(result.changed).toBe(false);
      expect(result.updated).toEqual([]);
      const written = await readJson<JsconfigFixture>(rootJsconfigPath);
      // The operator's chosen form is preserved verbatim.
      expect(written.compilerOptions?.paths?.[key]).toEqual([handWritten]);
    }
  });

  it('the emitted paths type-check under TypeScript without baseUrl (no TS5090, no TS5101)', async () => {
    await writeFile(rootJsconfigPath, JSON.stringify({}) + '\n');
    await syncOne(projectRoot, rootConfig());
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

    // Control: the bare form TS5090s, showing the ./ prefix is what avoids it.
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

describe('syncFurnaceJsconfigPaths — a typecheckJsconfig list', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-jsconfig-list-');
    const dir = join(projectRoot, 'components', 'custom', 'moz-widget');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'moz-widget.mjs'), '// module\n');
    await mkdir(join(projectRoot, 'components', 'custom'), { recursive: true });
    await mkdir(join(projectRoot, 'engine', 'browser', 'content'), { recursive: true });
    await writeFile(join(projectRoot, 'components', 'custom', 'jsconfig.json'), '{}\n');
    await writeFile(join(projectRoot, 'engine', 'browser', 'content', 'jsconfig.json'), '{}\n');
  });
  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('writes each jsconfig its own relative paths and reports per file', async () => {
    const config: FurnaceConfig = {
      ...makeConfig({
        'moz-widget': {
          description: 'Widget',
          targetPath: 'toolkit/content/widgets/moz-widget',
          register: true,
          localized: false,
        },
      }),
      typecheckJsconfig: [
        'components/custom/jsconfig.json',
        'engine/browser/content/jsconfig.json',
      ],
    };

    const results = await syncFurnaceJsconfigPaths(projectRoot, config);
    expect(results.map((r) => [r.jsconfig, r.changed])).toEqual([
      ['components/custom/jsconfig.json', true],
      ['engine/browser/content/jsconfig.json', true],
    ]);
    const key = 'chrome://global/content/elements/moz-widget.mjs';
    const custom = await readJson<JsconfigFixture>(
      join(projectRoot, 'components', 'custom', 'jsconfig.json')
    );
    const content = await readJson<JsconfigFixture>(
      join(projectRoot, 'engine', 'browser', 'content', 'jsconfig.json')
    );
    expect(custom.compilerOptions?.paths?.[key]).toEqual(['./moz-widget/moz-widget.mjs']);
    expect(content.compilerOptions?.paths?.[key]).toEqual([
      '../../../components/custom/moz-widget/moz-widget.mjs',
    ]);

    // Drift is per file: one stale entry names only its own jsconfig.
    await writeFile(join(projectRoot, 'engine', 'browser', 'content', 'jsconfig.json'), '{}\n');
    const drift = await Promise.all(
      typecheckJsconfigList(config).map((file) => findJsconfigPathsDrift(projectRoot, config, file))
    );
    expect(drift.map((d) => [d.jsconfig, d.changed])).toEqual([
      ['components/custom/jsconfig.json', false],
      ['engine/browser/content/jsconfig.json', true],
    ]);

    await reportJsconfigPathsSync(projectRoot, config, false);
    expect(vi.mocked(info)).toHaveBeenCalledWith(
      expect.stringContaining('Updated engine/browser/content/jsconfig.json chrome-module paths')
    );
    expect(vi.mocked(info)).not.toHaveBeenCalledWith(
      expect.stringContaining('components/custom/jsconfig.json')
    );
  });
});

describe('typecheckTagMap', () => {
  let projectRoot: string;

  const component = (overrides: Partial<CustomComponentConfig> = {}): CustomComponentConfig => ({
    description: 'c',
    targetPath: 'toolkit/content/widgets/c',
    register: true,
    localized: false,
    ...overrides,
  });

  async function seed(name: string, files: Record<string, string>): Promise<void> {
    const dir = join(projectRoot, 'components', 'custom', name);
    await mkdir(dir, { recursive: true });
    for (const [file, content] of Object.entries(files)) {
      await writeFile(join(dir, file), content);
    }
  }

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-tag-map-');
  });
  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('maps exported element classes and skips libraries, unregistered and unexported ones', async () => {
    await seed('moz-named', {
      'moz-named.mjs':
        'export class MozNamed extends HTMLElement {}\ncustomElements.define("moz-named", MozNamed);\n',
    });
    await seed('moz-default', {
      'moz-default.mjs':
        'export default class MozDefault extends HTMLElement {}\ncustomElements.define("moz-default", MozDefault);\n',
    });
    await seed('moz-aliased', {
      'moz-aliased.mjs':
        'class Impl extends HTMLElement {}\nwindow.customElements.define("moz-aliased", Impl);\nexport { Impl as MozAliased };\n',
    });
    await seed('moz-hidden', {
      'moz-hidden.mjs':
        'class MozHidden extends HTMLElement {}\ncustomElements.define("moz-hidden", MozHidden);\n',
    });
    await seed('moz-link', {
      'moz-link.mjs':
        'export class MozLink extends HTMLAnchorElement {}\ncustomElements.define("moz-link", MozLink, { extends: "a" });\n',
    });
    await seed('moz-unregistered', {
      'moz-unregistered.mjs':
        'export class MozUnregistered extends HTMLElement {}\ncustomElements.define("moz-unregistered", MozUnregistered);\n',
    });
    await seed('moz-base', {
      'moz-base.mjs': 'export class MozBase extends HTMLElement {}\n',
    });
    const config: FurnaceConfig = {
      ...makeConfig({
        'moz-named': component(),
        'moz-default': component(),
        'moz-aliased': component(),
        'moz-hidden': component(),
        'moz-link': component(),
        'moz-unregistered': component({ register: false }),
        'moz-base': component({ register: false, kind: 'library' }),
      }),
      typecheckTagMap: 'types/tag-map.d.ts',
    };

    const result = await syncFurnaceTagMap(projectRoot, config);
    expect(result?.changed).toBe(true);
    const written = await readText(join(projectRoot, 'types', 'tag-map.d.ts'));
    expect(written).toContain('interface HTMLElementTagNameMap {\n');
    expect(written.split('\n').filter((line) => line.startsWith('  '))).toEqual([
      '  "moz-aliased": import("chrome://global/content/elements/moz-aliased.mjs").MozAliased;',
      '  "moz-default": import("chrome://global/content/elements/moz-default.mjs").default;',
      '  "moz-named": import("chrome://global/content/elements/moz-named.mjs").MozNamed;',
    ]);

    // Up to date: a dry run reports no drift, and furnace validate's check agrees.
    await expect(syncFurnaceTagMap(projectRoot, config, { dryRun: true })).resolves.toMatchObject({
      changed: false,
    });
    await seed('moz-hidden', {
      'moz-hidden.mjs':
        'export class MozHidden extends HTMLElement {}\ncustomElements.define("moz-hidden", MozHidden);\n',
    });
    await expect(syncFurnaceTagMap(projectRoot, config, { dryRun: true })).resolves.toMatchObject({
      changed: true,
    });
    expect(await readText(join(projectRoot, 'types', 'tag-map.d.ts'))).toBe(written);
  });

  it('is a no-op without typecheckTagMap', async () => {
    await expect(syncFurnaceTagMap(projectRoot, makeConfig({}))).resolves.toBeUndefined();
  });

  it('types createElement through the jsconfig paths Furnace writes', async () => {
    await seed('moz-named', {
      'moz-named.mjs':
        'export class MozNamed extends HTMLElement {\n  /** @type {number} */\n  count = 0;\n}\ncustomElements.define("moz-named", MozNamed);\n',
    });
    await mkdir(join(projectRoot, 'tools'), { recursive: true });
    await writeFile(
      join(projectRoot, 'tools', 'jsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          allowJs: true,
          checkJs: true,
          noEmit: true,
          strict: true,
          module: 'ESNext',
          target: 'ESNext',
          moduleResolution: 'Bundler',
          lib: ['ESNext', 'DOM'],
        },
        files: ['tag-map.d.ts', 'use.js'],
      }) + '\n'
    );
    await writeFile(
      join(projectRoot, 'tools', 'use.js'),
      [
        'const el = document.createElement("moz-named");',
        '/** @type {string} */',
        'export const wrong = el.count;',
        '',
      ].join('\n')
    );
    const config: FurnaceConfig = {
      ...makeConfig({ 'moz-named': component() }),
      typecheckTagMap: 'tools/tag-map.d.ts',
    };
    await reportJsconfigPathsSync(projectRoot, config, false);

    const ts = await import('typescript');
    const configPath = join(projectRoot, 'tools', 'jsconfig.json');
    const parsed = ts.parseJsonConfigFileContent(
      ts.readConfigFile(configPath, (path) => ts.sys.readFile(path)).config,
      ts.sys,
      join(projectRoot, 'tools')
    );
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    const diagnostics = ts.getPreEmitDiagnostics(program).map((d) => ({
      code: d.code,
      message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
    }));
    // `el` is MozNamed, so its number-typed member does not assign to string.
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe(2322);
    expect(diagnostics[0]?.message).toContain("Type 'number' is not assignable to type 'string'");
  });
});
