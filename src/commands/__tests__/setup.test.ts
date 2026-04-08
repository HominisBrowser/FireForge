// SPDX-License-Identifier: EUPL-1.2
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeProjectPaths } from '../../test-utils/index.js';

const promptMocks = vi.hoisted(() => ({
  group: vi.fn(),
}));

vi.mock('@clack/prompts', () => ({
  group: promptMocks.group,
  confirm: vi.fn(),
  text: vi.fn(),
  select: vi.fn(),
  note: vi.fn(),
}));

vi.mock('../../core/config.js', () => ({
  configExists: vi.fn().mockResolvedValue(false),
  writeConfig: vi.fn().mockResolvedValue(undefined),
  getProjectPaths: vi.fn(),
}));

vi.mock('../../utils/fs.js', () => ({
  ensureDir: vi.fn().mockResolvedValue(undefined),
  pathExists: vi.fn().mockResolvedValue(false),
  readText: vi.fn().mockResolvedValue(''),
  writeText: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  spinner: vi.fn(() => ({
    stop: vi.fn(),
    error: vi.fn(),
  })),
  cancel: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
}));

import * as prompts from '@clack/prompts';

import { configExists, getProjectPaths, writeConfig } from '../../core/config.js';
import { setInteractiveMode } from '../../test-utils/index.js';
import { ensureDir } from '../../utils/fs.js';
import { cancel, spinner } from '../../utils/logger.js';
import { registerSetup, setupCommand } from '../setup.js';

describe('setupCommand interactive defaults', () => {
  let restoreTTY: (() => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProjectPaths).mockReturnValue(makeProjectPaths());
    restoreTTY = setInteractiveMode(true);
  });

  afterEach(() => {
    restoreTTY?.();
  });

  it('uses the default ESR version when the interactive prompt returns no version', async () => {
    promptMocks.group.mockResolvedValue({
      name: 'AuditFox',
      vendor: 'Audit Corp',
      appId: undefined,
      binaryName: undefined,
      firefoxVersion: undefined,
      product: undefined,
      license: 'EUPL-1.2',
    });

    await expect(setupCommand('/project')).resolves.toBeUndefined();

    expect(writeConfig).toHaveBeenCalledWith(
      '/project',
      expect.objectContaining({
        appId: 'org.auditfox.browser',
        binaryName: 'auditfox',
        firefox: {
          version: '140.0esr',
          product: 'firefox-esr',
        },
      })
    );
  });
});

describe('setupCommand non-interactive', () => {
  let restoreTTY: (() => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProjectPaths).mockReturnValue(makeProjectPaths());
    restoreTTY = setInteractiveMode(false);
  });

  afterEach(() => {
    restoreTTY?.();
    vi.mocked(configExists).mockResolvedValue(false);
  });

  it('creates config in non-interactive mode with valid options', async () => {
    await setupCommand('/project', {
      name: 'TestBrowser',
      vendor: 'TestCorp',
      appId: 'org.testcorp.browser',
      binaryName: 'testbrowser',
      firefoxVersion: '140.0esr',
      product: 'firefox-esr',
      license: 'MPL-2.0',
    });

    expect(writeConfig).toHaveBeenCalledWith(
      '/project',
      expect.objectContaining({
        name: 'TestBrowser',
        vendor: 'TestCorp',
        appId: 'org.testcorp.browser',
        binaryName: 'testbrowser',
      })
    );
  });

  it('creates required directory structure', async () => {
    await setupCommand('/project', {
      name: 'TestBrowser',
      vendor: 'TestCorp',
      appId: 'org.testcorp.browser',
      binaryName: 'testbrowser',
      firefoxVersion: '140.0esr',
      product: 'firefox-esr',
      license: 'EUPL-1.2',
    });

    const ensureDirCalls = vi.mocked(ensureDir).mock.calls.map(([p]) => p);
    expect(ensureDirCalls).toEqual(
      expect.arrayContaining([
        expect.stringContaining('patches'),
        expect.stringContaining('configs'),
      ])
    );
  });

  it('infers product from ESR version string', async () => {
    await setupCommand('/project', {
      name: 'TestBrowser',
      vendor: 'TestCorp',
      appId: 'org.testcorp.browser',
      binaryName: 'testbrowser',
      firefoxVersion: '140.0esr',
      license: 'EUPL-1.2',
    });

    const writtenConfig = vi.mocked(writeConfig).mock.calls[0]?.[1];
    expect(writtenConfig).toBeDefined();
    expect(writtenConfig?.firefox.product).toBe('firefox-esr');
  });

  it('prompts for overwrite when config already exists in interactive mode', async () => {
    restoreTTY?.();
    restoreTTY = setInteractiveMode(true);
    vi.mocked(configExists).mockResolvedValue(true);
    vi.mocked(prompts.confirm).mockResolvedValue(true);

    promptMocks.group.mockResolvedValue({
      name: 'AuditFox',
      vendor: 'Audit Corp',
      appId: undefined,
      binaryName: undefined,
      firefoxVersion: undefined,
      product: undefined,
      license: 'EUPL-1.2',
    });

    // Should still complete — the overwrite prompt is part of the group
    await expect(setupCommand('/project')).resolves.toBeUndefined();
  });

  it('cancels when overwrite is declined interactively', async () => {
    restoreTTY?.();
    restoreTTY = setInteractiveMode(true);
    vi.mocked(configExists).mockResolvedValue(true);
    vi.mocked(prompts.confirm).mockResolvedValue(false);

    await expect(setupCommand('/project')).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledWith('Setup cancelled');
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it('rejects overwrite in non-interactive mode without force', async () => {
    vi.mocked(configExists).mockResolvedValue(true);

    await expect(
      setupCommand('/project', {
        name: 'TestBrowser',
        vendor: 'TestCorp',
        appId: 'org.testcorp.browser',
        binaryName: 'testbrowser',
        firefoxVersion: '140.0esr',
      })
    ).rejects.toThrow('Use --force to overwrite');
  });

  it('reports project creation failures on the spinner before rethrowing', async () => {
    vi.mocked(writeConfig).mockRejectedValueOnce(new Error('disk full'));
    const spinnerInstance = { stop: vi.fn(), error: vi.fn() };
    vi.mocked(spinner).mockReturnValueOnce(spinnerInstance as never);

    await expect(
      setupCommand('/project', {
        name: 'TestBrowser',
        vendor: 'TestCorp',
        appId: 'org.testcorp.browser',
        binaryName: 'testbrowser',
        firefoxVersion: '140.0esr',
      })
    ).rejects.toThrow('disk full');

    expect(spinnerInstance.error).toHaveBeenCalledWith('Failed to create project');
  });

  it('registers the CLI action and forwards parsed product and license options', async () => {
    const program = new Command();
    const withErrorHandling = <T extends unknown[]>(
      fn: (...args: T) => Promise<void>
    ): ((...args: T) => Promise<void>) => fn;

    registerSetup(program, {
      getProjectRoot: () => '/project',
      withErrorHandling,
    } as never);

    await program.parseAsync([
      'node',
      'fireforge',
      'setup',
      '--name',
      'CliBrowser',
      '--vendor',
      'CliCorp',
      '--app-id',
      'org.clicorp.browser',
      '--binary-name',
      'clibrowser',
      '--firefox-version',
      '147.0b1',
      '--product',
      'firefox-beta',
      '--license',
      'MPL-2.0',
      '--force',
    ]);

    const writtenConfig = vi.mocked(writeConfig).mock.calls.at(-1)?.[1];
    expect(writtenConfig).toBeDefined();
    expect(writtenConfig).toMatchObject({
      firefox: { product: 'firefox-beta', version: '147.0b1' },
      license: 'MPL-2.0',
    });
  });
});
