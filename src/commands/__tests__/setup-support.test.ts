// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

const promptMocks = vi.hoisted(() => ({
  group: vi.fn(),
  text: vi.fn(),
  select: vi.fn(),
}));

vi.mock('@clack/prompts', () => ({
  group: promptMocks.group,
  text: promptMocks.text,
  select: promptMocks.select,
}));

vi.mock('node:os', () => ({
  cpus: vi.fn(() => []),
}));

vi.mock('../../core/config.js', () => ({
  getProjectPaths: vi.fn(() => ({
    root: '/project',
    config: '/project/fireforge.json',
    fireforgeDir: '/project/.fireforge',
    state: '/project/.fireforge/state.json',
    engine: '/project/engine',
    patches: '/project/patches',
    configs: '/project/configs',
    src: '/project/src',
    componentsDir: '/project/components',
  })),
  writeConfig: vi.fn().mockResolvedValue(undefined),
  loadConfig: vi.fn().mockResolvedValue({ binaryName: 'nightlyfox' }),
}));

vi.mock('../../utils/fs.js', () => ({
  ensureDir: vi.fn().mockResolvedValue(undefined),
  pathExists: vi.fn().mockResolvedValue(false),
  readText: vi.fn().mockResolvedValue(''),
  writeText: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../utils/logger.js', () => ({
  cancel: vi.fn(),
}));

vi.mock('../../utils/package-root.js', () => ({
  getPackageRoot: vi.fn(() => '/pkg'),
}));

vi.mock('../../utils/validation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/validation.js')>();
  return {
    ...actual,
    inferProductFromVersion: vi.fn(actual.inferProductFromVersion),
  };
});

import { cpus } from 'node:os';

import { loadConfig, writeConfig } from '../../core/config.js';
import { pathExists, readText, writeText } from '../../utils/fs.js';
import { cancel } from '../../utils/logger.js';
import { inferProductFromVersion } from '../../utils/validation.js';
import {
  buildSetupConfig,
  parseFirefoxProductOption,
  parseProjectLicenseOption,
  resolveSetupInputs,
  validateSetupOptions,
  writeSetupProjectFiles,
} from '../setup-support.js';

interface PromptConfig {
  message: string;
  validate: (value: string) => string | undefined;
}

function findPromptConfig(message: string): PromptConfig | undefined {
  const matchingCall = promptMocks.text.mock.calls.find((args): args is [PromptConfig] => {
    const [config] = args as [unknown];
    return (
      config !== undefined &&
      typeof config === 'object' &&
      config !== null &&
      'message' in config &&
      (config as { message: string }).message === message
    );
  });

  return matchingCall?.[0];
}

describe('setup-support', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(cpus).mockReturnValue([] as never);
    vi.mocked(pathExists).mockResolvedValue(false);
    vi.mocked(readText).mockResolvedValue('');
    vi.mocked(writeText).mockResolvedValue(undefined);
    vi.mocked(writeConfig).mockResolvedValue(undefined);
    vi.mocked(loadConfig).mockResolvedValue({ binaryName: 'nightlyfox' } as never);
    vi.mocked(inferProductFromVersion).mockImplementation((version) => {
      if (version.endsWith('esr')) return 'firefox-esr';
      if (/b\d+$/i.test(version)) return 'firefox-beta';
      return 'firefox';
    });
    promptMocks.text.mockReset();
    promptMocks.select.mockReset();
    promptMocks.group.mockReset();
  });

  it('parses optional CLI product and license values', () => {
    expect(parseFirefoxProductOption(undefined)).toBeUndefined();
    expect(parseFirefoxProductOption('firefox-beta')).toBe('firefox-beta');
    expect(() => parseFirefoxProductOption('waterfox')).toThrow('Invalid product');

    expect(parseProjectLicenseOption(undefined)).toBeUndefined();
    expect(parseProjectLicenseOption('0BSD')).toBe('0BSD');
    expect(() => parseProjectLicenseOption('MIT')).toThrow('Invalid license');
  });

  it('validates setup option shapes strictly', () => {
    expect(() => {
      validateSetupOptions({ name: '' });
    }).toThrow('Name is required');
    expect(() => {
      validateSetupOptions({ name: 'x'.repeat(51) });
    }).toThrow('50 characters or less');
    expect(() => {
      validateSetupOptions({ vendor: '   ' });
    }).toThrow('Vendor is required');
    expect(() => {
      validateSetupOptions({ appId: 'not-an-app-id' });
    }).toThrow('Invalid app ID');
    expect(() => {
      validateSetupOptions({ binaryName: 'Bad Name' });
    }).toThrow('Binary name');
    expect(() => {
      validateSetupOptions({ firefoxVersion: 'bad-version' });
    }).toThrow('Invalid Firefox version format');
    expect(() => {
      validateSetupOptions({ product: 'bad' as never });
    }).toThrow('Invalid product');
    expect(() => {
      validateSetupOptions({ license: 'bad' as never });
    }).toThrow('Invalid license');
  });

  it('returns direct non-interactive inputs when all required values are provided', async () => {
    await expect(
      resolveSetupInputs(
        {
          name: 'NightlyFox',
          vendor: 'Mozillaish',
          appId: 'org.example.nightlyfox',
          binaryName: 'nightlyfox',
          firefoxVersion: '147.0b1',
        },
        false
      )
    ).resolves.toEqual({
      finalName: 'NightlyFox',
      finalVendor: 'Mozillaish',
      finalAppId: 'org.example.nightlyfox',
      finalBinaryName: 'nightlyfox',
      finalFirefoxVersion: '147.0b1',
      finalProduct: 'firefox-beta',
      finalLicense: 'EUPL-1.2',
    });
  });

  it('rejects incomplete non-interactive setup input', async () => {
    await expect(resolveSetupInputs({ name: 'NightlyFox' }, false)).rejects.toThrow(
      'Missing required options for non-interactive mode'
    );
  });

  it('resolves interactive defaults and fallback product selection', async () => {
    vi.mocked(inferProductFromVersion).mockReturnValue(undefined);
    promptMocks.text.mockImplementation(({ message }: { message: string }) => {
      if (message === 'What is the name of your browser?') return 'Audit Fox';
      if (message === 'What is your vendor/company name?') return 'Audit Corp';
      return undefined;
    });
    promptMocks.select.mockImplementation(({ message }: { message: string }) => {
      if (message === 'Which Firefox product?') return 'firefox-beta';
      return '0BSD';
    });
    promptMocks.group.mockImplementation(
      async (questions: Record<string, (ctx: unknown) => unknown>) => {
        const results: Record<string, unknown> = {};
        for (const [key, resolver] of Object.entries(questions)) {
          results[key] = await resolver({ results });
        }
        return results;
      }
    );

    await expect(resolveSetupInputs({}, true)).resolves.toEqual({
      finalName: 'Audit Fox',
      finalVendor: 'Audit Corp',
      finalAppId: 'org.auditfox.browser',
      finalBinaryName: 'auditfox',
      finalFirefoxVersion: '140.0esr',
      finalProduct: 'firefox-beta',
      finalLicense: '0BSD',
    });

    const namePrompt = findPromptConfig('What is the name of your browser?');
    const vendorPrompt = findPromptConfig('What is your vendor/company name?');
    const appIdPrompt = findPromptConfig('Application ID (reverse-domain format)');
    const binaryPrompt = findPromptConfig('Binary name (executable name)');
    const versionPrompt = findPromptConfig('Firefox version to base on');

    expect(namePrompt?.validate('')).toBe('Name is required');
    expect(namePrompt?.validate('x'.repeat(51))).toBe('Name must be 50 characters or less');
    expect(namePrompt?.validate('Audit Fox')).toBeUndefined();
    expect(vendorPrompt?.validate('')).toBe('Vendor is required');
    expect(vendorPrompt?.validate('Audit Corp')).toBeUndefined();
    expect(appIdPrompt?.validate('bad-id')).toContain('reverse-domain');
    expect(appIdPrompt?.validate('org.auditfox.browser')).toBeUndefined();
    expect(binaryPrompt?.validate('Bad Name')).toContain('Must start with a letter');
    expect(binaryPrompt?.validate('auditfox')).toBeUndefined();
    expect(versionPrompt?.validate('bad-version')).toContain('Invalid Firefox version format');
    expect(versionPrompt?.validate('147.0b1')).toBeUndefined();
  });

  it('rejects invalid derived app IDs from interactive defaults', async () => {
    promptMocks.group.mockResolvedValue({
      name: '!!!',
      vendor: 'Audit Corp',
      appId: undefined,
      binaryName: undefined,
      firefoxVersion: '140.0esr',
      product: 'firefox-esr',
      license: 'EUPL-1.2',
    });

    await expect(resolveSetupInputs({}, true)).rejects.toThrow('Derived appId');
  });

  it('rejects invalid resolved Firefox versions from interactive defaults', async () => {
    promptMocks.group.mockResolvedValue({
      name: 'AuditFox',
      vendor: 'Audit Corp',
      appId: 'org.auditfox.browser',
      binaryName: 'auditfox',
      firefoxVersion: 'bad-version',
      product: 'firefox',
      license: 'EUPL-1.2',
    });

    await expect(resolveSetupInputs({}, true)).rejects.toThrow('Default Firefox version');
  });

  it('falls back to firefox when direct non-interactive product inference cannot resolve', async () => {
    vi.mocked(inferProductFromVersion).mockReturnValue(undefined);

    await expect(
      resolveSetupInputs(
        {
          name: 'NightlyFox',
          vendor: 'Mozillaish',
          appId: 'org.example.nightlyfox',
          binaryName: 'nightlyfox',
          firefoxVersion: '147.0',
        },
        false
      )
    ).resolves.toEqual(
      expect.objectContaining({
        finalProduct: 'firefox',
      })
    );
  });

  it('turns prompt cancellation into a cancellation error', async () => {
    promptMocks.group.mockImplementation(
      (_questions: unknown, options?: { onCancel?: () => void }) => {
        options?.onCancel?.();
        return Promise.resolve({});
      }
    );

    await expect(resolveSetupInputs({}, true)).rejects.toThrow('cancel');
    expect(cancel).toHaveBeenCalledWith('Setup cancelled');
  });

  it('builds config with at least one build job', () => {
    vi.mocked(cpus).mockReturnValue([] as never);

    expect(
      buildSetupConfig({
        finalName: 'Audit Fox',
        finalVendor: 'Audit Corp',
        finalAppId: 'org.auditfox.browser',
        finalBinaryName: 'auditfox',
        finalFirefoxVersion: '140.0esr',
        finalProduct: 'firefox-esr',
        finalLicense: 'EUPL-1.2',
      })
    ).toEqual(
      expect.objectContaining({
        build: { jobs: 1 },
      })
    );
  });

  it('writes project files, appends missing ignores, and renders templates', async () => {
    vi.mocked(pathExists).mockImplementation((filePath: string) =>
      Promise.resolve(
        [
          '/project/.gitignore',
          '/pkg/templates/licenses/0BSD.md',
          '/pkg/templates/configs',
          '/pkg/templates/configs/common.mozconfig',
        ].includes(filePath)
      )
    );
    vi.mocked(readText).mockImplementation((filePath: string) => {
      if (filePath === '/project/.gitignore') return Promise.resolve('node_modules\ndist\n');
      if (filePath === '/pkg/templates/licenses/0BSD.md')
        return Promise.resolve('[year] [fullname]');
      if (filePath === '/pkg/templates/configs/common.mozconfig') {
        return Promise.resolve(
          'ac_add_options --with-app-name=${name} ${vendor} ${appId} ${binaryName}'
        );
      }
      return Promise.resolve(
        filePath === '/project/.gitignore'
          ? 'node_modules\ndist\n'
          : filePath === '/pkg/templates/licenses/0BSD.md'
            ? '[year] [fullname]'
            : ''
      );
    });

    await writeSetupProjectFiles('/project', {
      name: 'Audit Fox',
      vendor: 'Audit Corp',
      appId: 'org.auditfox.browser',
      binaryName: 'auditfox',
      license: '0BSD',
      firefox: { version: '140.0esr', product: 'firefox-esr' },
      build: { jobs: 4 },
    });

    expect(writeText).toHaveBeenCalledWith(
      '/project/.gitignore',
      'node_modules\ndist\nengine/\n.fireforge/\n'
    );
    expect(writeText).toHaveBeenCalledWith(
      '/project/package.json',
      JSON.stringify({ private: true, license: '0BSD' }, null, 2) + '\n'
    );
    expect(writeText).toHaveBeenCalledWith(
      '/project/LICENSE',
      expect.stringContaining('Audit Corp')
    );
    expect(writeText).toHaveBeenCalledWith(
      '/project/configs/common.mozconfig',
      'ac_add_options --with-app-name=Audit Fox Audit Corp org.auditfox.browser auditfox'
    );
  });

  it('creates a fresh gitignore and exits early when config templates are absent', async () => {
    vi.mocked(pathExists).mockResolvedValue(false);

    await writeSetupProjectFiles('/project', {
      name: 'Audit Fox',
      vendor: 'Audit Corp',
      appId: 'org.auditfox.browser',
      binaryName: 'auditfox',
      license: 'EUPL-1.2',
      firefox: { version: '140.0esr', product: 'firefox-esr' },
      build: { jobs: 4 },
    });

    expect(writeText).toHaveBeenCalledWith(
      '/project/.gitignore',
      'node_modules/\ndist/\nengine/\n.fireforge/\n'
    );
  });
});
