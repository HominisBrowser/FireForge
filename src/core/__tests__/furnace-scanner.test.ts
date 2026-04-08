// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
  readText: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: vi.fn(),
  };
});

import { readdir } from 'node:fs/promises';

import { pathExists, readText } from '../../utils/fs.js';
import {
  getComponentDetails,
  isComponentInEngine,
  scanCustomElementsRegistrations,
  scanWidgetsDirectory,
} from '../furnace-scanner.js';

describe('furnace-scanner helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns no registrations when customElements.js is missing', async () => {
    vi.mocked(pathExists).mockResolvedValue(false);

    await expect(scanCustomElementsRegistrations('/engine')).resolves.toEqual(new Map());
  });

  it('parses custom element registrations and skips callbacks without nearby imports', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readText).mockResolvedValue(
      [
        'lazy.customElements.setElementCreationCallback("moz-button", () => {',
        '  import("chrome://global/content/elements/moz-button.mjs");',
        '});',
        'lazy.customElements.setElementCreationCallback("moz-panel", () => {',
        '  // no import nearby',
        '});',
        'lazy.customElements.setElementCreationCallback("moz-card", () => {',
        '  doSomething();',
        '  doSomethingElse();',
        '  import("chrome://global/content/elements/moz-card.mjs");',
        '});',
        '',
      ].join('\n')
    );

    await expect(scanCustomElementsRegistrations('/engine')).resolves.toEqual(
      new Map([
        ['moz-button', 'chrome://global/content/elements/moz-button.mjs'],
        ['moz-card', 'chrome://global/content/elements/moz-card.mjs'],
      ])
    );
  });

  it('returns no scanned components when the widgets directory is missing', async () => {
    vi.mocked(pathExists).mockResolvedValue(false);

    await expect(scanWidgetsDirectory('/engine')).resolves.toEqual([]);
    expect(readdir).not.toHaveBeenCalled();
  });

  it('scans moz-* widget directories and annotates css, ftl, and registration status', async () => {
    vi.mocked(pathExists).mockImplementation((filePath) => {
      if (filePath === '/engine/toolkit/content/widgets') return Promise.resolve(true);
      if (filePath === '/engine/toolkit/content/customElements.js') return Promise.resolve(true);
      return Promise.resolve(
        filePath === '/engine/toolkit/locales/en-US/toolkit/global/moz-card.ftl'
      );
    });
    vi.mocked(readText).mockResolvedValue(
      [
        'lazy.customElements.setElementCreationCallback("moz-card", () => {',
        '  import("chrome://global/content/elements/moz-card.mjs");',
        '});',
        '',
      ].join('\n')
    );
    vi.mocked(readdir).mockImplementation((dirPath) => {
      if (dirPath === '/engine/toolkit/content/widgets') {
        return Promise.resolve([
          { name: 'moz-card', isDirectory: () => true },
          { name: 'moz-broken', isDirectory: () => true },
          { name: 'not-a-component', isDirectory: () => true },
        ] as unknown as Awaited<ReturnType<typeof readdir>>);
      }

      if (dirPath === '/engine/toolkit/content/widgets/moz-card') {
        return Promise.resolve([
          { name: 'moz-card.mjs', isDirectory: () => false, isFile: () => true },
          { name: 'moz-card.css', isDirectory: () => false, isFile: () => true },
        ] as unknown as Awaited<ReturnType<typeof readdir>>);
      }

      if (dirPath === '/engine/toolkit/content/widgets/moz-broken') {
        return Promise.resolve([
          { name: 'README.md', isDirectory: () => false, isFile: () => true },
        ] as unknown as Awaited<ReturnType<typeof readdir>>);
      }

      throw new Error(`Unexpected readdir: ${String(dirPath)}`);
    });

    await expect(scanWidgetsDirectory('/engine')).resolves.toEqual([
      {
        tagName: 'moz-card',
        sourcePath: 'toolkit/content/widgets/moz-card',
        hasCSS: true,
        hasFTL: true,
        isRegistered: true,
      },
    ]);
  });

  it('returns null from getComponentDetails when the component is missing or has no module', async () => {
    vi.mocked(pathExists).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    vi.mocked(readdir).mockResolvedValueOnce([
      { name: 'README.md', isDirectory: () => false, isFile: () => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);

    await expect(getComponentDetails('/engine', 'moz-missing')).resolves.toBeNull();
    await expect(getComponentDetails('/engine', 'moz-empty')).resolves.toBeNull();
  });

  it('returns component details with css, ftl, and registration status', async () => {
    vi.mocked(pathExists).mockImplementation((filePath) => {
      if (filePath === '/engine/toolkit/content/widgets/moz-panel') return Promise.resolve(true);
      if (filePath === '/engine/toolkit/content/customElements.js') return Promise.resolve(true);
      return Promise.resolve(
        filePath === '/engine/toolkit/locales/en-US/toolkit/global/moz-panel.ftl'
      );
    });
    vi.mocked(readdir).mockResolvedValue([
      { name: 'moz-panel.mjs', isDirectory: () => false, isFile: () => true },
      { name: 'moz-panel.css', isDirectory: () => false, isFile: () => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);
    vi.mocked(readText).mockResolvedValue(
      [
        'lazy.customElements.setElementCreationCallback("moz-panel", () => {',
        '  import("chrome://global/content/elements/moz-panel.mjs");',
        '});',
        '',
      ].join('\n')
    );

    await expect(getComponentDetails('/engine', 'moz-panel')).resolves.toEqual({
      tagName: 'moz-panel',
      sourcePath: 'toolkit/content/widgets/moz-panel',
      hasCSS: true,
      hasFTL: true,
      isRegistered: true,
    });
  });

  it('checks whether a component directory exists in the engine tree', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);

    await expect(isComponentInEngine('/engine', 'moz-card')).resolves.toBe(true);
    expect(pathExists).toHaveBeenCalledWith('/engine/toolkit/content/widgets/moz-card');
  });
});
