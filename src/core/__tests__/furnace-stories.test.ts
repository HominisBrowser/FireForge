// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn() };
});

vi.mock('../../utils/fs.js', () => ({
  ensureDir: vi.fn(),
  pathExists: vi.fn(),
  removeDir: vi.fn(),
  removeFile: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock('../config.js', () => ({
  getProjectPaths: vi.fn(() => ({ engine: '/project/engine' })),
  loadConfig: vi.fn(() => ({ license: 'MPL-2.0' })),
}));

vi.mock('../furnace-config.js', () => ({
  loadFurnaceConfig: vi.fn(),
}));

vi.mock('../license-headers.js', () => ({
  getLicenseHeader: vi.fn(() => '/* LICENSE */'),
  DEFAULT_LICENSE: 'MPL-2.0',
}));

import { readdir } from 'node:fs/promises';

import { ensureDir, pathExists, removeDir, removeFile, writeText } from '../../utils/fs.js';
import { loadFurnaceConfig } from '../furnace-config.js';
import {
  cleanStories,
  generateStoryContent,
  getStoriesDir,
  syncStories,
} from '../furnace-stories.js';

const mockReaddir = vi.mocked(readdir);
const mockPathExists = vi.mocked(pathExists);
const mockRemoveDir = vi.mocked(removeDir);
const mockRemoveFile = vi.mocked(removeFile);
const mockWriteText = vi.mocked(writeText);
const mockLoadFurnaceConfig = vi.mocked(loadFurnaceConfig);
const mockEnsureDir = vi.mocked(ensureDir);

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureDir.mockResolvedValue(undefined);
  mockWriteText.mockResolvedValue(undefined);
  mockRemoveDir.mockResolvedValue(undefined);
  mockRemoveFile.mockResolvedValue(undefined);
});

describe('generateStoryContent', () => {
  it('uses the correct title category for stock type', () => {
    const content = generateStoryContent('moz-button', 'Button', 'stock');
    expect(content).toContain('title: "Design System/Stock/Button"');
  });

  it('uses the correct title category for override type', () => {
    const content = generateStoryContent('moz-button', 'Button', 'override', '/* LIC */');
    expect(content).toContain('title: "Design System/Overrides/Button"');
  });

  it('uses the correct title category for custom type', () => {
    const content = generateStoryContent('moz-widget', 'Widget', 'custom', '/* LIC */');
    expect(content).toContain('title: "Design System/Custom/Widget"');
  });

  it('derives chrome URI from toolkit modulePath', () => {
    const content = generateStoryContent(
      'moz-button',
      'Button',
      'stock',
      '/* LIC */',
      'toolkit/content/widgets/moz-button.mjs'
    );
    expect(content).toContain('chrome://global/content/widgets/moz-button.mjs');
  });

  it('derives chrome URI from browser modulePath', () => {
    const content = generateStoryContent(
      'moz-panel',
      'Panel',
      'stock',
      '/* LIC */',
      'browser/base/content/panels/moz-panel.mjs'
    );
    expect(content).toContain('chrome://browser/content/panels/moz-panel.mjs');
  });

  it('uses default elements path when no modulePath', () => {
    const content = generateStoryContent('moz-button', 'Button', 'stock');
    expect(content).toContain('chrome://global/content/elements/moz-button.mjs');
  });
});

describe('getStoriesDir', () => {
  it('returns the correct path', () => {
    expect(getStoriesDir('/engine')).toBe('/engine/browser/components/storybook/stories');
  });
});

describe('syncStories', () => {
  it('creates story files for stock components that do not exist', async () => {
    mockLoadFurnaceConfig.mockResolvedValue({
      stock: ['moz-button'],
      overrides: {},
      custom: {},
    } as never);
    mockPathExists.mockResolvedValue(false);
    mockReaddir.mockResolvedValue([] as never);

    const result = await syncStories('/project');
    expect(result.created).toContain('moz-button.stories.mjs');
    expect(mockWriteText).toHaveBeenCalled();
  });

  it('skips stock components whose story already exists', async () => {
    mockLoadFurnaceConfig.mockResolvedValue({
      stock: ['moz-button'],
      overrides: {},
      custom: {},
    } as never);
    mockPathExists.mockResolvedValue(true);
    mockReaddir.mockResolvedValue([] as never);

    const result = await syncStories('/project');
    expect(result.created).toHaveLength(0);
  });

  it('always regenerates override stories', async () => {
    mockLoadFurnaceConfig.mockResolvedValue({
      stock: [],
      overrides: { 'moz-input': {} },
      custom: {},
    } as never);
    mockPathExists.mockResolvedValue(true);
    mockReaddir.mockResolvedValue([] as never);

    const result = await syncStories('/project');
    expect(result.updated).toContain('moz-input.stories.mjs');
  });

  it('creates override story when it does not exist', async () => {
    mockLoadFurnaceConfig.mockResolvedValue({
      stock: [],
      overrides: { 'moz-input': {} },
      custom: {},
    } as never);
    mockPathExists.mockResolvedValue(false);
    mockReaddir.mockResolvedValue([] as never);

    const result = await syncStories('/project');
    expect(result.created).toContain('moz-input.stories.mjs');
  });

  it('always regenerates custom stories', async () => {
    mockLoadFurnaceConfig.mockResolvedValue({
      stock: [],
      overrides: {},
      custom: { 'moz-widget': {} },
    } as never);
    mockPathExists.mockResolvedValue(true);
    mockReaddir.mockResolvedValue([] as never);

    const result = await syncStories('/project');
    expect(result.updated).toContain('moz-widget.stories.mjs');
  });

  it('removes stale story files', async () => {
    mockLoadFurnaceConfig.mockResolvedValue({
      stock: [],
      overrides: {},
      custom: {},
    } as never);
    mockReaddir.mockResolvedValue([{ isFile: () => true, name: 'stale.stories.mjs' }] as never);

    const result = await syncStories('/project');
    expect(result.removed).toContain('stale.stories.mjs');
    expect(mockRemoveFile).toHaveBeenCalled();
  });

  it('ignores non-story files during cleanup', async () => {
    mockLoadFurnaceConfig.mockResolvedValue({
      stock: [],
      overrides: {},
      custom: {},
    } as never);
    mockReaddir.mockResolvedValue([{ isFile: () => true, name: 'README.md' }] as never);

    const result = await syncStories('/project');
    expect(result.removed).toHaveLength(0);
  });
});

describe('cleanStories', () => {
  it('returns 0 when stories directory does not exist', async () => {
    mockPathExists.mockResolvedValue(false);

    const count = await cleanStories('/engine');
    expect(count).toBe(0);
    expect(mockRemoveDir).not.toHaveBeenCalled();
  });

  it('counts files and removes directory', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReaddir.mockResolvedValue([
      { isFile: () => true, name: 'a.stories.mjs' },
      { isFile: () => true, name: 'b.stories.mjs' },
      { isFile: () => false, name: 'subdir' },
    ] as never);

    const count = await cleanStories('/engine');
    expect(count).toBe(2);
    expect(mockRemoveDir).toHaveBeenCalled();
  });
});
