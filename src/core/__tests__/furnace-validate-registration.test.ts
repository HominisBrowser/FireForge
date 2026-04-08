// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn() };
});

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
  readText: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  warn: vi.fn(),
}));

vi.mock('../config.js', () => ({
  getProjectPaths: vi.fn(() => ({ engine: '/engine' })),
  loadConfig: vi.fn().mockResolvedValue({ binaryName: 'nightlyfox' }),
}));

vi.mock('../furnace-config.js', () => ({
  getFurnacePaths: vi.fn(() => ({ customDir: '/project/components/custom' })),
}));

vi.mock('../token-manager.js', () => ({
  getTokensCssPath: vi.fn((binaryName: string) => `chrome://browser/skin/${binaryName}.css`),
}));

import { readdir } from 'node:fs/promises';

import type { CustomComponentConfig } from '../../types/furnace.js';
import { pathExists, readText } from '../../utils/fs.js';
import { warn } from '../../utils/logger.js';
import { loadConfig } from '../config.js';
import {
  checkRegistrationConsistency,
  validateTokenLink,
} from '../furnace-validate-registration.js';

const COMPONENT_CONFIG: CustomComponentConfig = {
  description: 'Dock component',
  localized: false,
  register: true,
  targetPath: 'toolkit/content',
};

describe('furnace registration validation helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pathExists).mockResolvedValue(false);
    vi.mocked(readText).mockResolvedValue('');
  });

  it('returns an empty status when the source component directory is missing', async () => {
    await expect(
      checkRegistrationConsistency('/project', 'moz-dock', COMPONENT_CONFIG)
    ).resolves.toEqual({
      sourceExists: false,
      targetExists: false,
      filesInSync: true,
      jarMnCss: false,
      jarMnMjs: false,
      customElementsPresent: false,
      customElementsCorrectBlock: false,
      driftedFiles: [],
      missingTargetFiles: [],
    });
  });

  it('detects missing target files, drift, and registration placement', async () => {
    vi.mocked(pathExists).mockImplementation((filePath: string) =>
      Promise.resolve(
        [
          '/project/components/custom/moz-dock',
          '/engine/toolkit/content',
          '/engine/toolkit/content/moz-dock.css',
          '/engine/toolkit/content/jar.mn',
          '/engine/toolkit/content/customElements.js',
        ].includes(filePath)
      )
    );
    vi.mocked(readdir).mockResolvedValue([
      { isFile: () => true, name: 'moz-dock.css' },
      { isFile: () => true, name: 'moz-dock.mjs' },
      { isFile: () => false, name: 'ignored-dir' },
    ] as never);
    vi.mocked(readText).mockImplementation((filePath: string) => {
      if (filePath.endsWith('moz-dock.css')) return Promise.resolve('same-content');
      if (filePath.endsWith('moz-dock.mjs')) {
        return Promise.resolve(filePath.startsWith('/project/') ? 'src' : 'dest');
      }
      if (filePath.endsWith('jar.mn')) {
        return Promise.resolve('content/global/elements/moz-dock.css');
      }
      if (filePath.endsWith('customElements.js')) {
        return Promise.resolve(`
          customElements.setElementCreationCallback("moz-dock", () => {});
          document.addEventListener("DOMContentLoaded", () => {});
        `);
      }
      return Promise.resolve('');
    });

    await expect(
      checkRegistrationConsistency('/project', 'moz-dock', COMPONENT_CONFIG)
    ).resolves.toEqual(
      expect.objectContaining({
        sourceExists: true,
        targetExists: true,
        filesInSync: false,
        jarMnCss: true,
        jarMnMjs: false,
        customElementsPresent: true,
        customElementsCorrectBlock: false,
        driftedFiles: [],
        missingTargetFiles: ['moz-dock.mjs'],
      })
    );
  });

  it('detects drifted files and correctly placed custom elements', async () => {
    vi.mocked(pathExists).mockImplementation((filePath: string) =>
      Promise.resolve(
        [
          '/project/components/custom/moz-dock',
          '/engine/toolkit/content',
          '/engine/toolkit/content/moz-dock.css',
          '/engine/toolkit/content/moz-dock.mjs',
          '/engine/toolkit/content/jar.mn',
          '/engine/toolkit/content/customElements.js',
        ].includes(filePath)
      )
    );
    vi.mocked(readdir).mockResolvedValue([{ isFile: () => true, name: 'moz-dock.mjs' }] as never);
    vi.mocked(readText).mockImplementation((filePath: string) => {
      if (filePath === '/project/components/custom/moz-dock/moz-dock.mjs') {
        return Promise.resolve('source');
      }
      if (filePath === '/engine/toolkit/content/moz-dock.mjs') return Promise.resolve('target');
      if (filePath.endsWith('jar.mn')) {
        return Promise.resolve(
          'content/global/elements/moz-dock.css\ncontent/global/elements/moz-dock.mjs'
        );
      }
      if (filePath.endsWith('customElements.js')) {
        return Promise.resolve(`
          document.addEventListener("DOMContentLoaded", () => {
            customElements.setElementCreationCallback("moz-dock", () => {});
          });
        `);
      }
      return Promise.resolve('');
    });

    await expect(
      checkRegistrationConsistency('/project', 'moz-dock', COMPONENT_CONFIG)
    ).resolves.toEqual(
      expect.objectContaining({
        filesInSync: false,
        jarMnCss: true,
        jarMnMjs: true,
        customElementsPresent: true,
        customElementsCorrectBlock: true,
        driftedFiles: ['moz-dock.mjs'],
      })
    );
  });

  it('warns when tokenized component CSS is not linked from browser.xhtml', async () => {
    vi.mocked(pathExists).mockImplementation((filePath: string) =>
      Promise.resolve(
        ['/component/moz-dock.css', '/engine/browser/base/content/browser.xhtml'].includes(filePath)
      )
    );
    vi.mocked(readText).mockImplementation((filePath: string) => {
      if (filePath === '/component/moz-dock.css') {
        return Promise.resolve('.dock { color: var(--ff-token-color); }');
      }
      return Promise.resolve('<html></html>');
    });

    await expect(
      validateTokenLink('/component', 'moz-dock', '/project', '--ff-token')
    ).resolves.toEqual([
      expect.objectContaining({
        component: 'moz-dock',
        check: 'missing-token-link',
        severity: 'warning',
      }),
    ]);
  });

  it('returns no token-link issues when config lookup fails or prerequisites are absent', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readText).mockResolvedValue('.dock { color: var(--ff-token-color); }');
    vi.mocked(loadConfig).mockRejectedValueOnce(new Error('broken config'));

    await expect(
      validateTokenLink('/component', 'moz-dock', '/project', '--ff-token')
    ).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      'Could not resolve token CSS link target for moz-dock during validation: broken config'
    );
    await expect(validateTokenLink('/component', 'moz-dock', '/project')).resolves.toEqual([]);
  });
});
