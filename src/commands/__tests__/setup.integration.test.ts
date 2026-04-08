// SPDX-License-Identifier: EUPL-1.2
import { access } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTempProject,
  removeTempProject,
  setInteractiveMode,
} from '../../test-utils/index.js';
import { readText } from '../../utils/fs.js';
import { setupCommand } from '../setup.js';

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  spinner: vi.fn(() => ({
    stop: vi.fn(),
    error: vi.fn(),
  })),
  cancel: vi.fn(),
  note: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
}));

describe('setupCommand integration', () => {
  let projectRoot: string;
  let restoreTTY: (() => void) | undefined;

  beforeEach(async () => {
    restoreTTY = setInteractiveMode(false);
    projectRoot = await createTempProject();
  });

  afterEach(async () => {
    restoreTTY?.();
    await removeTempProject(projectRoot);
  });

  it('creates a project non-interactively when required flags are provided', async () => {
    await setupCommand(projectRoot, {
      name: 'MyBrowser',
      vendor: 'My Company',
      appId: 'org.example.mybrowser',
      binaryName: 'mybrowser',
      firefoxVersion: '140.0esr',
      product: 'firefox-esr',
      license: 'EUPL-1.2',
    });

    const config = await readText(join(projectRoot, 'fireforge.json'));
    expect(config).toContain('"binaryName": "mybrowser"');
    await expect(access(join(projectRoot, 'configs'))).resolves.toBeUndefined();
    await expect(access(join(projectRoot, 'patches'))).resolves.toBeUndefined();
  });

  it('overwrites an existing config when force is set', async () => {
    await setupCommand(projectRoot, {
      name: 'FirstBrowser',
      vendor: 'First Company',
      appId: 'org.example.firstbrowser',
      binaryName: 'firstbrowser',
      firefoxVersion: '140.0',
      product: 'firefox',
      force: true,
    });

    await setupCommand(projectRoot, {
      name: 'SecondBrowser',
      vendor: 'Second Company',
      appId: 'org.example.secondbrowser',
      binaryName: 'secondbrowser',
      firefoxVersion: '140.0esr',
      product: 'firefox-esr',
      force: true,
    });

    const config = await readText(join(projectRoot, 'fireforge.json'));
    expect(config).toContain('"name": "SecondBrowser"');
    expect(config).toContain('"binaryName": "secondbrowser"');
  });

  it('fails in non-interactive mode when required options are missing', async () => {
    await expect(
      setupCommand(projectRoot, {
        name: 'MissingFields',
      })
    ).rejects.toThrow('Missing required options for non-interactive mode');
  });

  it.each([
    ['EUPL-1.2', 'EUROPEAN UNION PUBLIC LICENCE'],
    ['MPL-2.0', 'Mozilla Public License, v. 2.0'],
    ['GPL-2.0-or-later', 'GNU GENERAL PUBLIC LICENSE'],
    ['0BSD', `Copyright (c) ${new Date().getFullYear()} My Company`],
  ] as const)('renders a valid LICENSE file for %s', async (license, expectedSnippet) => {
    await setupCommand(projectRoot, {
      name: 'MyBrowser',
      vendor: 'My Company',
      appId: 'org.example.mybrowser',
      binaryName: 'mybrowser',
      firefoxVersion: '140.0esr',
      product: 'firefox-esr',
      license,
    });

    const licenseText = await readText(join(projectRoot, 'LICENSE'));
    expect(licenseText).toContain(expectedSnippet);
    if (license === '0BSD') {
      expect(licenseText).not.toContain('[year]');
      expect(licenseText).not.toContain('[fullname]');
    }
  });
});
