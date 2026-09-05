// SPDX-License-Identifier: EUPL-1.2
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFsMock, createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('../../utils/fs.js', () => createFsMock());

vi.mock('../../utils/logger.js', () => createLoggerMock());

vi.mock('../state-file.js', () => ({
  withStateFileLock: vi.fn(async (_path: string, operation: () => Promise<unknown>) => operation()),
  quarantineStateFile: vi.fn(),
}));

import { ConfigError, ConfigNotFoundError } from '../../errors/config.js';
import { nativePath } from '../../test-utils/index.js';
import type { FireForgeConfig, FireForgeState } from '../../types/config.js';
import { pathExists, pathExistsStrict, readJson, writeJson } from '../../utils/fs.js';
import { verbose, warn } from '../../utils/logger.js';
import {
  configExists,
  loadConfig,
  loadState,
  mutateConfig,
  updateState,
  validateConfig,
  writeConfig,
  writeConfigDocument,
} from '../config.js';
import { quarantineStateFile, withStateFileLock } from '../state-file.js';

const mockPathExists = vi.mocked(pathExists);
const mockPathExistsStrict = vi.mocked(pathExistsStrict);
const mockReadJson = vi.mocked(readJson);
const mockWriteJson = vi.mocked(writeJson);
const mockVerbose = vi.mocked(verbose);
const mockWarn = vi.mocked(warn);
const mockWithStateFileLock = vi.mocked(withStateFileLock);
const mockQuarantineStateFile = vi.mocked(quarantineStateFile);

function makeValidConfig(overrides: Partial<FireForgeConfig> = {}): FireForgeConfig {
  const { firefox, build, wire, license, ...rest } = overrides;

  return {
    name: 'My Browser',
    vendor: 'Acme',
    appId: 'org.acme.browser',
    binaryName: 'mybrowser',
    firefox: {
      version: '140.9.0esr',
      product: 'firefox-esr',
      ...(firefox ?? {}),
    },
    build: { jobs: 16, ...(build ?? {}) },
    license: license ?? 'MPL-2.0',
    wire: { subscriptDir: 'browser/base/content', ...(wire ?? {}) },
    ...rest,
  };
}

describe('config helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithStateFileLock.mockImplementation(async (_path, operation) => operation());
    mockQuarantineStateFile.mockResolvedValue(undefined);
  });

  it('checks whether the config file exists', async () => {
    mockPathExistsStrict.mockResolvedValueOnce(true);

    await expect(configExists('/project')).resolves.toBe(true);
    expect(mockPathExistsStrict).toHaveBeenCalledWith(nativePath('/project/fireforge.json'));
  });
});

describe('validateConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a strongly typed config for valid input', () => {
    expect(validateConfig(makeValidConfig())).toEqual(makeValidConfig());
  });

  it('accepts and normalizes an optional pinned firefox sha256', () => {
    const digest = 'A'.repeat(64);
    const base = makeValidConfig();

    expect(
      validateConfig({ ...base, firefox: { ...base.firefox, sha256: digest } }).firefox.sha256
    ).toBe(digest.toLowerCase());
  });

  it('accepts the firefox.allowUnverifiedDownload opt-out and rejects non-booleans', () => {
    const base = makeValidConfig();
    expect(
      validateConfig({ ...base, firefox: { ...base.firefox, allowUnverifiedDownload: true } })
        .firefox.allowUnverifiedDownload
    ).toBe(true);
    expect(validateConfig(base).firefox.allowUnverifiedDownload).toBeUndefined();
    expect(() =>
      validateConfig({ ...base, firefox: { ...base.firefox, allowUnverifiedDownload: 'yes' } })
    ).toThrow('Config field "firefox.allowUnverifiedDownload" must be a boolean');
  });

  it('accepts an optional firefox release-candidate build directory', () => {
    const base = makeValidConfig();

    expect(
      validateConfig({ ...base, firefox: { ...base.firefox, candidate: 'build2' } }).firefox
        .candidate
    ).toBe('build2');
  });

  it('rejects malformed firefox candidate values', () => {
    const base = makeValidConfig();

    for (const bad of ['2', 'buildx', 'build0', '../build2', 'build2/..', 'build2\\evil']) {
      expect(() =>
        validateConfig({ ...base, firefox: { ...base.firefox, candidate: bad } })
      ).toThrow('Config field "firefox.candidate" must look like "buildN" (e.g. "build2")');
    }
  });

  it('accepts Developer Edition beta versions', () => {
    expect(
      validateConfig(
        makeValidConfig({
          firefox: { version: '152.0b6', product: 'firefox-devedition' },
        })
      ).firefox.product
    ).toBe('firefox-devedition');
  });

  it('rejects Developer Edition with non-beta versions', () => {
    expect(() =>
      validateConfig(
        makeValidConfig({
          firefox: { version: '152.0', product: 'firefox-devedition' },
        })
      )
    ).toThrow('Product "firefox-devedition" requires a beta version');
  });

  it('accepts a valid patchPolicy block', () => {
    const config = validateConfig({
      ...makeValidConfig(),
      patchPolicy: {
        filenamePattern:
          '^(?<order>\\d{3})-(?<category>branding|infra|ui)-(?<slug>[a-z0-9-]+)\\.patch$',
        requireDescription: true,
        allowGaps: false,
        mutationMode: 'force',
        ranges: [
          { from: 1, to: 99, category: 'branding' },
          { from: 100, to: 199, category: 'infra' },
          { from: 200, to: 299, category: 'ui' },
        ],
        reservedRanges: [
          {
            from: 900,
            to: 999,
            allowed: [
              {
                filename: '900-infra-bootstrap-workaround.patch',
                files: ['tools/build.rs'],
                adr: 'docs/architecture/adr/0001-bootstrap-workaround.md',
              },
            ],
          },
        ],
      },
    });

    expect(config.patchPolicy?.mutationMode).toBe('force');
    expect(config.patchPolicy?.ranges.map((range) => range.category)).toEqual([
      'branding',
      'infra',
      'ui',
    ]);
  });

  it('rejects malformed patchPolicy filename regexes', () => {
    expect(() =>
      validateConfig({
        ...makeValidConfig(),
        patchPolicy: {
          filenamePattern: '(?<order>',
          ranges: [{ from: 1, to: 99, category: 'infra' }],
        },
      })
    ).toThrow('patchPolicy.filenamePattern');
  });

  it('rejects overlapping patchPolicy ranges', () => {
    expect(() =>
      validateConfig({
        ...makeValidConfig(),
        patchPolicy: {
          ranges: [
            { from: 1, to: 50, category: 'infra' },
            { from: 50, to: 99, category: 'ui' },
          ],
        },
      })
    ).toThrow('overlapping ranges');
  });

  it('rejects malformed firefox sha256 pins', () => {
    const base = makeValidConfig();

    expect(() =>
      validateConfig({ ...base, firefox: { ...base.firefox, sha256: 'not-a-sha' } })
    ).toThrow('Config field "firefox.sha256" must be a 64-character SHA-256 hex digest');
  });

  it('logs unknown root keys and ignores them', () => {
    const config = validateConfig({
      ...makeValidConfig(),
      experimental: { enabled: true },
    });

    expect(config).toEqual(makeValidConfig());
    expect(mockVerbose).toHaveBeenCalledWith(
      'Unknown config key "experimental" in fireforge.json — it will be ignored.'
    );
  });

  it('rejects a non-object config document', () => {
    expect(() => validateConfig('not an object')).toThrow('Config must be an object');
  });

  it.each([
    ['name', { ...makeValidConfig(), name: 42 }],
    ['vendor', { ...makeValidConfig(), vendor: 42 }],
    ['appId', { ...makeValidConfig(), appId: 42 }],
    ['binaryName', { ...makeValidConfig(), binaryName: 42 }],
  ])('rejects non-string required field %s', (_field, rawConfig) => {
    expect(() => validateConfig(rawConfig)).toThrow(ConfigError);
  });

  it('rejects binaryName path traversal and separators', () => {
    expect(() => validateConfig(makeValidConfig({ binaryName: '../bad/browser' }))).toThrow(
      'Config field "binaryName" must not contain path separators, "..", or null bytes'
    );
  });

  it('rejects binaryName with null bytes', () => {
    expect(() => validateConfig(makeValidConfig({ binaryName: 'bad\0browser' }))).toThrow(
      'must not contain path separators, "..", or null bytes'
    );
  });

  it('rejects binaryName that is an absolute path', () => {
    // Windows-style absolute path bypasses the separator check but must
    // still be caught by the isExplicitAbsolutePath guard.
    expect(() => validateConfig(makeValidConfig({ binaryName: 'C:\\browser' }))).toThrow(
      'must not contain path separators'
    );
  });

  it('rejects an invalid appId', () => {
    expect(() => validateConfig(makeValidConfig({ appId: 'bad app id' }))).toThrow(
      'Config field "appId" must be a valid reverse-domain identifier'
    );
  });

  it('rejects a non-object firefox section', () => {
    expect(() => validateConfig({ ...makeValidConfig(), firefox: 'bad' })).toThrow(
      'Config field "firefox" must be an object'
    );
  });

  it('rejects an invalid Firefox version', () => {
    expect(() =>
      validateConfig(makeValidConfig({ firefox: { version: 'zero', product: 'firefox-esr' } }))
    ).toThrow('Config field "firefox.version" must be a valid Firefox version');
  });

  it('rejects an invalid Firefox product', () => {
    expect(() =>
      validateConfig({
        ...makeValidConfig(),
        firefox: { version: '140.9.0esr', product: 'fennec' as never },
      })
    ).toThrow(
      'Config field "firefox.product" must be one of: firefox, firefox-esr, firefox-beta, firefox-devedition'
    );
  });

  it('rejects invalid optional build, wire, and license fields', () => {
    expect(() => validateConfig({ ...makeValidConfig(), build: 'bad' })).toThrow(
      'Config field "build" must be an object'
    );
    expect(() => validateConfig({ ...makeValidConfig(), build: { jobs: 'bad' } })).toThrow(
      'Config field "build.jobs" must be a positive integer'
    );
    expect(() => validateConfig({ ...makeValidConfig(), build: { jobs: 0 } })).toThrow(
      'Config field "build.jobs" must be a positive integer'
    );
    expect(() => validateConfig({ ...makeValidConfig(), wire: 'bad' })).toThrow(
      'Config field "wire" must be an object'
    );
    expect(() =>
      validateConfig({ ...makeValidConfig(), wire: { subscriptDir: '../bad' } })
    ).toThrow('Config field "wire.subscriptDir" must stay within engine/');
    expect(() =>
      validateConfig({ ...makeValidConfig(), wire: { subscriptDir: '/tmp/elsewhere' } })
    ).toThrow('Config field "wire.subscriptDir" must stay within engine/');
    expect(() => validateConfig({ ...makeValidConfig(), license: 'Apache-2.0' as never })).toThrow(
      'Config field "license" must be one of: EUPL-1.2, MPL-2.0, 0BSD, GPL-2.0-or-later'
    );
  });

  // The thresholds were module constants until 0.45.0, and under the
  // recommended `--max-warnings 0` posture the "soft" 750 band is a hard
  // failure, so a project that needs a different number needs a dial.
  it('accepts patchLint.fileSizeThresholds and merges partial tiers', () => {
    const config = validateConfig(
      makeValidConfig({
        patchLint: {
          fileSizeThresholds: { general: { warning: 800 }, test: { notice: 900, error: 2000 } },
        },
      })
    );
    expect(config.patchLint?.fileSizeThresholds).toEqual({
      general: { warning: 800 },
      test: { notice: 900, error: 2000 },
    });
  });

  it('rejects malformed patchLint.fileSizeThresholds', () => {
    expect(() =>
      validateConfig(makeValidConfig({ patchLint: { fileSizeThresholds: 5 as never } }))
    ).toThrow('Config field "patchLint.fileSizeThresholds" must be a plain object');

    expect(() =>
      validateConfig(makeValidConfig({ patchLint: { fileSizeThresholds: { nope: {} } as never } }))
    ).toThrow('has unknown key "nope"');

    expect(() =>
      validateConfig(
        makeValidConfig({ patchLint: { fileSizeThresholds: { general: 3 } as never } })
      )
    ).toThrow('Config field "patchLint.fileSizeThresholds.general" must be a plain object');

    expect(() =>
      validateConfig(
        makeValidConfig({ patchLint: { fileSizeThresholds: { general: { warning: 0 } } } })
      )
    ).toThrow(
      'Config field "patchLint.fileSizeThresholds.general.warning" must be a positive integer'
    );

    expect(() =>
      validateConfig(
        makeValidConfig({ patchLint: { fileSizeThresholds: { general: { nope: 5 } } as never } })
      )
    ).toThrow('Config field "patchLint.fileSizeThresholds.general" has unknown key "nope"');
  });

  // Ordering is checked against the merged triple, so setting only one
  // field cannot silently land it below the default beneath it, which
  // would disable a band rather than fail anything.
  it('rejects an override that lands out of order against the defaults', () => {
    expect(() =>
      validateConfig(
        makeValidConfig({ patchLint: { fileSizeThresholds: { general: { warning: 400 } } } })
      )
    ).toThrow(/notice <= warning <= error \(resolved: 500\/400\/900\)/);
  });

  it('accepts patchLint.checkJsExtraShim and rejects malformed shim paths', () => {
    expect(
      validateConfig(
        makeValidConfig({
          patchLint: { checkJs: true, checkJsExtraShim: 'tools/types/extras.d.ts' },
        })
      ).patchLint?.checkJsExtraShim
    ).toBe('tools/types/extras.d.ts');

    expect(() => validateConfig(makeValidConfig({ patchLint: { checkJsExtraShim: '' } }))).toThrow(
      'Config field "patchLint.checkJsExtraShim" must be a non-empty string'
    );

    expect(() =>
      validateConfig(makeValidConfig({ patchLint: { checkJsExtraShim: 42 as never } }))
    ).toThrow('Config field "patchLint.checkJsExtraShim" must be a non-empty string');

    expect(() =>
      validateConfig(makeValidConfig({ patchLint: { checkJsExtraShim: '../escape.d.ts' } }))
    ).toThrow('Config field "patchLint.checkJsExtraShim" must be a project-relative path');

    expect(() =>
      validateConfig(makeValidConfig({ patchLint: { checkJsExtraShim: '/abs/extras.d.ts' } }))
    ).toThrow('Config field "patchLint.checkJsExtraShim" must be a project-relative path');
  });

  it('accepts patchLint.checkJsStrict with checkJs and validates checkJsCompilerOptions', () => {
    expect(
      validateConfig(
        makeValidConfig({
          patchLint: {
            checkJs: true,
            checkJsStrict: true,
            checkJsCompilerOptions: { strictNullChecks: false },
          },
        })
      ).patchLint
    ).toEqual({
      checkJs: true,
      checkJsStrict: true,
      checkJsCompilerOptions: { strictNullChecks: false },
    });

    expect(() => validateConfig(makeValidConfig({ patchLint: { checkJsStrict: true } }))).toThrow(
      'Config field "patchLint.checkJsStrict" requires "patchLint.checkJs": true'
    );

    expect(() =>
      validateConfig(
        makeValidConfig({
          patchLint: { checkJs: false, checkJsStrict: true },
        })
      )
    ).toThrow('Config field "patchLint.checkJsStrict" requires "patchLint.checkJs": true');

    expect(() =>
      validateConfig(
        makeValidConfig({
          patchLint: {
            checkJs: true,
            checkJsCompilerOptions: { strictNullChecks: false },
          },
        })
      )
    ).toThrow(
      'Config field "patchLint.checkJsCompilerOptions" requires "patchLint.checkJsStrict": true'
    );

    // Cross-field validation of checkJsTestFiles / checkJsTestShim.
    expect(
      validateConfig(
        makeValidConfig({
          patchLint: {
            checkJs: true,
            checkJsTestFiles: true,
            checkJsTestShim: 'shims/test-harness.d.ts',
          },
        })
      ).patchLint
    ).toEqual({
      checkJs: true,
      checkJsTestFiles: true,
      checkJsTestShim: 'shims/test-harness.d.ts',
    });
    expect(() =>
      validateConfig(makeValidConfig({ patchLint: { checkJsTestFiles: true } }))
    ).toThrow('Config field "patchLint.checkJsTestFiles" requires "patchLint.checkJs": true');
    expect(() =>
      validateConfig(
        makeValidConfig({
          patchLint: { checkJs: true, checkJsTestShim: 'shims/test-harness.d.ts' },
        })
      )
    ).toThrow(
      'Config field "patchLint.checkJsTestShim" requires "patchLint.checkJsTestFiles": true'
    );
    expect(() =>
      validateConfig(
        makeValidConfig({
          patchLint: { checkJs: true, checkJsTestFiles: true, checkJsTestShim: '/abs.d.ts' },
        })
      )
    ).toThrow('Config field "patchLint.checkJsTestShim" must be a project-relative path');

    expect(() =>
      validateConfig(
        makeValidConfig({
          patchLint: { checkJs: true, checkJsStrict: true, checkJsCompilerOptions: 'bad' as never },
        })
      )
    ).toThrow('Config field "patchLint.checkJsCompilerOptions" must be a plain object');

    expect(() =>
      validateConfig(
        makeValidConfig({
          patchLint: {
            checkJs: true,
            checkJsStrict: true,
            checkJsCompilerOptions: { noEmit: true } as never,
          },
        })
      )
    ).toThrow('Config field "patchLint.checkJsCompilerOptions" has unknown key "noEmit"');

    expect(() =>
      validateConfig(
        makeValidConfig({
          patchLint: {
            checkJs: true,
            checkJsStrict: true,
            checkJsCompilerOptions: { strictNullChecks: 'no' as never },
          },
        })
      )
    ).toThrow('Config field "patchLint.checkJsCompilerOptions.strictNullChecks" must be a boolean');

    expect(() =>
      validateConfig(
        makeValidConfig({ patchLint: { checkJs: true, checkJsStrict: 'yes' as never } })
      )
    ).toThrow('Config field "patchLint.checkJsStrict" must be a boolean');
  });

  it('accepts and validates a checkJsCompilerOptions paths mapping (item C route 2)', () => {
    expect(
      validateConfig(
        makeValidConfig({
          patchLint: {
            checkJs: true,
            checkJsStrict: true,
            checkJsCompilerOptions: { paths: { 'resource:///modules/foo/*': ['./*'] } },
          },
        })
      ).patchLint?.checkJsCompilerOptions
    ).toEqual({ paths: { 'resource:///modules/foo/*': ['./*'] } });

    expect(() =>
      validateConfig(
        makeValidConfig({
          patchLint: {
            checkJs: true,
            checkJsStrict: true,
            checkJsCompilerOptions: { paths: { 'a/*': 'not-an-array' as never } },
          },
        })
      )
    ).toThrow(
      'Config field "patchLint.checkJsCompilerOptions.paths.a/*" must be an array of strings'
    );

    expect(() =>
      validateConfig(
        makeValidConfig({
          patchLint: {
            checkJs: true,
            checkJsStrict: true,
            checkJsCompilerOptions: { paths: { 'a/*/*': ['./*'] } },
          },
        })
      )
    ).toThrow('may contain at most one "*"');
  });

  it('accepts a well-formed typecheck block and surfaces field-level errors otherwise', () => {
    const config = validateConfig({
      ...makeValidConfig(),
      typecheck: {
        projects: ['components/custom/jsconfig.json', 'engine/browser/base/jsconfig.json'],
        extraShim: 'tools/types/mybrowser-globals.d.ts',
      },
    });
    expect(config.typecheck).toEqual({
      projects: ['components/custom/jsconfig.json', 'engine/browser/base/jsconfig.json'],
      extraShim: 'tools/types/mybrowser-globals.d.ts',
    });

    expect(() => validateConfig({ ...makeValidConfig(), typecheck: 'bad' })).toThrow(
      'Config field "typecheck" must be an object'
    );

    expect(() => validateConfig({ ...makeValidConfig(), typecheck: {} })).toThrow(
      'Config field "typecheck.projects" is required when "typecheck" is set'
    );

    expect(() => validateConfig({ ...makeValidConfig(), typecheck: { projects: 'bad' } })).toThrow(
      'Config field "typecheck.projects" must be an array of strings'
    );

    expect(() => validateConfig({ ...makeValidConfig(), typecheck: { projects: [] } })).toThrow(
      'Config field "typecheck.projects" must not be empty'
    );

    expect(() =>
      validateConfig({ ...makeValidConfig(), typecheck: { projects: ['', 'b'] } })
    ).toThrow('Config field "typecheck.projects[0]" must be a non-empty string');

    expect(() =>
      validateConfig({ ...makeValidConfig(), typecheck: { projects: ['ok', 42] } })
    ).toThrow('Config field "typecheck.projects[1]" must be a non-empty string');

    expect(() =>
      validateConfig({ ...makeValidConfig(), typecheck: { projects: ['../escape/jsconfig.json'] } })
    ).toThrow('Config field "typecheck.projects[0]" must be a project-relative path');

    expect(() =>
      validateConfig({ ...makeValidConfig(), typecheck: { projects: ['/abs/jsconfig.json'] } })
    ).toThrow('Config field "typecheck.projects[0]" must be a project-relative path');

    expect(() =>
      validateConfig({
        ...makeValidConfig(),
        typecheck: { projects: ['ok/jsconfig.json'], extraShim: '../escape.d.ts' },
      })
    ).toThrow('Config field "typecheck.extraShim" must be a project-relative path');

    // The undefinedIdentifiers gate validates like the other
    // severity gates in both blocks.
    const withGates = validateConfig({
      ...makeValidConfig(),
      typecheck: { projects: ['ok/jsconfig.json'], undefinedIdentifiers: 'error' },
      patchLint: { checkJs: true, undefinedIdentifiers: 'off' },
    });
    expect(withGates.typecheck?.undefinedIdentifiers).toBe('error');
    expect(withGates.patchLint?.undefinedIdentifiers).toBe('off');

    expect(() =>
      validateConfig({
        ...makeValidConfig(),
        typecheck: { projects: ['ok/jsconfig.json'], undefinedIdentifiers: 'loud' },
      })
    ).toThrow('typecheck.undefinedIdentifiers');
  });

  it('parses typecheck.projectOverrides (per-project shim override / opt-out)', () => {
    const config = validateConfig({
      ...makeValidConfig(),
      typecheck: {
        projects: ['a/jsconfig.json', 'b/jsconfig.json'],
        extraShim: 'shims/hub.d.ts',
        projectOverrides: { 'a/jsconfig.json': null, 'b/jsconfig.json': 'shims/b.d.ts' },
      },
    });
    expect(config.typecheck?.projectOverrides).toEqual({
      'a/jsconfig.json': null,
      'b/jsconfig.json': 'shims/b.d.ts',
    });

    // Non-object map.
    expect(() =>
      validateConfig({
        ...makeValidConfig(),
        typecheck: { projects: ['a/jsconfig.json'], projectOverrides: 'bad' },
      })
    ).toThrow('Config field "typecheck.projectOverrides" must be an object');

    // Key not in projects.
    expect(() =>
      validateConfig({
        ...makeValidConfig(),
        typecheck: { projects: ['a/jsconfig.json'], projectOverrides: { 'c/jsconfig.json': null } },
      })
    ).toThrow(/does not match any entry in "typecheck.projects"/);

    // Override value with a non-relative path.
    expect(() =>
      validateConfig({
        ...makeValidConfig(),
        typecheck: {
          projects: ['a/jsconfig.json'],
          projectOverrides: { 'a/jsconfig.json': '/abs/shim.d.ts' },
        },
      })
    ).toThrow(/must be a project-relative path/);
  });

  it('returns config.typecheck === undefined when the block is absent (default-off)', () => {
    expect(validateConfig(makeValidConfig()).typecheck).toBeUndefined();
  });

  it('accepts a well-formed markerComment and rejects malformed values', () => {
    expect(validateConfig({ ...makeValidConfig(), markerComment: 'MYBROWSER' }).markerComment).toBe(
      'MYBROWSER'
    );

    expect(() => validateConfig({ ...makeValidConfig(), markerComment: '' })).toThrow(
      /must not be empty/
    );
    expect(() => validateConfig({ ...makeValidConfig(), markerComment: ' MYBROWSER ' })).toThrow(
      /leading or trailing whitespace/
    );
    expect(() => validateConfig({ ...makeValidConfig(), markerComment: 'two\nlines' })).toThrow(
      /newlines or "\*\/"/
    );
    expect(() => validateConfig({ ...makeValidConfig(), markerComment: 'a*/b' })).toThrow(
      /newlines or "\*\/"/
    );
    expect(() => validateConfig({ ...makeValidConfig(), markerComment: 42 as never })).toThrow(
      /must be a string/
    );
  });
});

describe('config persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads and validates the config file', async () => {
    mockPathExistsStrict.mockResolvedValueOnce(true);
    mockReadJson.mockResolvedValueOnce(makeValidConfig());

    await expect(loadConfig('/project')).resolves.toEqual(makeValidConfig());
    expect(mockReadJson).toHaveBeenCalledWith(nativePath('/project/fireforge.json'));
  });

  it('throws a ConfigNotFoundError when fireforge.json is missing', async () => {
    mockPathExistsStrict.mockResolvedValueOnce(false);

    await expect(loadConfig('/project')).rejects.toBeInstanceOf(ConfigNotFoundError);
  });

  it('wraps non-ConfigError exceptions from readJson in a ConfigError', async () => {
    mockPathExistsStrict.mockResolvedValueOnce(true);
    mockReadJson.mockRejectedValueOnce(new TypeError('Unexpected token'));

    const err = await loadConfig('/project').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).message).toContain('Invalid fireforge.json');
  });

  it('re-throws ConfigError subclasses without wrapping', async () => {
    mockPathExistsStrict.mockResolvedValueOnce(true);
    mockReadJson.mockResolvedValueOnce('not-an-object');

    await expect(loadConfig('/project')).rejects.toBeInstanceOf(ConfigError);
  });

  it('stringifies non-Error throwables in loadConfig catch', async () => {
    mockPathExistsStrict.mockResolvedValueOnce(true);
    mockReadJson.mockRejectedValueOnce('raw string error');

    const err = await loadConfig('/project').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).message).toContain('raw string error');
  });

  it('writes validated and raw config documents', async () => {
    await writeConfig('/project', makeValidConfig());
    await writeConfigDocument('/project', { custom: { enabled: true } });

    expect(mockWriteJson).toHaveBeenNthCalledWith(
      1,
      nativePath('/project/fireforge.json'),
      makeValidConfig()
    );
    expect(mockWriteJson).toHaveBeenNthCalledWith(2, nativePath('/project/fireforge.json'), {
      custom: { enabled: true },
    });
  });

  it('mutates a valid config path and revalidates it by default', () => {
    expect(mutateConfig(makeValidConfig(), 'build.jobs', 32)).toEqual(
      makeValidConfig({ build: { jobs: 32 } })
    );
  });

  it('rejects invalid mutations unless skipValidation is enabled', () => {
    expect(() => mutateConfig(makeValidConfig(), 'build.jobs', 'many')).toThrow(ConfigError);

    expect(mutateConfig(makeValidConfig(), 'build.jobs', 'many', true)).toEqual({
      ...makeValidConfig(),
      build: { jobs: 'many' },
    });
  });

  describe('prototype-pollution sentinel rejection', () => {
    // The canonical pollution probe: after the guarded call runs, a
    // freshly-constructed object must not expose the attempted sentinel
    // write via its prototype chain. We run the probe on a key that is
    // not otherwise present on `Object.prototype` so an accidental
    // pass through would be immediately visible.
    const PROBE_KEY = 'fireforgePollutionProbe';

    afterEach(() => {
      // Defensive cleanup: if any assertion somehow pollutes the chain
      // (it shouldn't, since the guard throws), remove it so downstream
      // tests don't inherit the poisoned prototype. `Reflect.deleteProperty`
      // sidesteps `@typescript-eslint/no-dynamic-delete` for a probe key
      // that is intentionally parameterised.
      Reflect.deleteProperty(Object.prototype, PROBE_KEY);
    });

    it('rejects a leading __proto__ segment before any clone or mutation', () => {
      expect(() =>
        mutateConfig(makeValidConfig(), `__proto__.${PROBE_KEY}`, 'polluted', true)
      ).toThrow(/reserved segment "__proto__"/);
      expect(({} as Record<string, unknown>)[PROBE_KEY]).toBeUndefined();
    });

    it('rejects a standalone constructor segment', () => {
      expect(() => mutateConfig(makeValidConfig(), 'constructor', 'polluted', true)).toThrow(
        /reserved segment "constructor"/
      );
    });

    it('rejects a nested prototype segment', () => {
      expect(() =>
        mutateConfig(makeValidConfig(), `nested.prototype.${PROBE_KEY}`, 'polluted', true)
      ).toThrow(/reserved segment "prototype"/);
      expect(({} as Record<string, unknown>)[PROBE_KEY]).toBeUndefined();
    });

    it('rejects a trailing __proto__ segment even when preceded by legitimate names', () => {
      expect(() => mutateConfig(makeValidConfig(), 'build.__proto__', 'polluted', true)).toThrow(
        /reserved segment "__proto__"/
      );
    });
  });

  it('loads an empty state when the state file is missing', async () => {
    mockPathExists.mockResolvedValueOnce(false);

    await expect(loadState('/project')).resolves.toEqual({});
  });

  it('loads and returns saved state data', async () => {
    const state: FireForgeState = { baseCommit: 'abc123', buildMode: 'release' };
    mockPathExists.mockResolvedValueOnce(true);
    mockReadJson.mockResolvedValueOnce(state);

    await expect(loadState('/project')).resolves.toEqual(state);
  });

  it('warns and resets when the state file is corrupted', async () => {
    mockPathExists.mockResolvedValueOnce(true);
    mockReadJson.mockRejectedValueOnce(new Error('bad json'));

    await expect(loadState('/project')).resolves.toEqual({});
    expect(mockQuarantineStateFile).toHaveBeenCalledWith(
      nativePath('/project/.fireforge/state.json')
    );
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('could not be parsed: bad json'));
  });

  it('salvages valid fields from an invalid state file and rewrites the sanitized result', async () => {
    mockPathExists.mockResolvedValueOnce(true);
    mockReadJson.mockResolvedValueOnce({
      baseCommit: 'abc123',
      buildMode: 123,
      pendingResolution: {
        patchFilename: 'broken.patch',
        originalError: 'failed',
      },
    });
    mockQuarantineStateFile.mockResolvedValueOnce('state.json.corrupt-2026-04-07T00-00-00-000Z');

    await expect(loadState('/project')).resolves.toEqual({
      baseCommit: 'abc123',
      pendingResolution: {
        patchFilename: 'broken.patch',
        originalError: 'failed',
      },
    });

    expect(mockWriteJson).toHaveBeenCalledWith(nativePath('/project/.fireforge/state.json'), {
      baseCommit: 'abc123',
      pendingResolution: {
        patchFilename: 'broken.patch',
        originalError: 'failed',
      },
    });
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('Recovered valid fields: baseCommit, pendingResolution.')
    );
  });

  it('merges incremental updates', async () => {
    mockPathExists.mockResolvedValueOnce(true);
    mockReadJson.mockResolvedValueOnce({ baseCommit: 'abc123' });

    await updateState('/project', { buildMode: 'debug' });

    expect(mockWriteJson).toHaveBeenNthCalledWith(1, nativePath('/project/.fireforge/state.json'), {
      baseCommit: 'abc123',
      buildMode: 'debug',
    });
  });

  it('supports transactional updater callbacks for nested state updates', async () => {
    mockPathExists.mockResolvedValueOnce(true);
    mockReadJson.mockResolvedValueOnce({
      pendingResolution: {
        patchFilename: 'failed.patch',
        originalError: 'first failure',
      },
    });

    await updateState('/project', (current) => ({
      ...current,
      pendingResolution: {
        patchFilename: 'failed.patch',
        originalError: 'retry failed',
      },
    }));

    expect(mockWriteJson).toHaveBeenCalledWith(nativePath('/project/.fireforge/state.json'), {
      pendingResolution: {
        patchFilename: 'failed.patch',
        originalError: 'retry failed',
      },
    });
  });
});
