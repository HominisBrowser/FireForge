// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
  readText: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock('../parser-fallback.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../parser-fallback.js')>();
  return {
    ...actual,
    withParserFallback: vi.fn(actual.withParserFallback),
  };
});

import { pathExists, readText, writeText } from '../../utils/fs.js';
import { registerBrowserContent } from '../register-browser-content.js';

const mockPathExists = vi.mocked(pathExists);
const mockReadText = vi.mocked(readText);
const mockWriteText = vi.mocked(writeText);

const MOCK_JAR_MN = `
browser.jar:
%  content/browser %content/browser/
        content/browser/aboutDialog.js    (content/aboutDialog.js)
        content/browser/browser.js        (content/browser.js)
        content/browser/places.js         (content/places.js)
`.trimStart();

describe('registerBrowserContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(MOCK_JAR_MN);
    mockWriteText.mockResolvedValue(undefined);
  });

  it('inserts in alphabetical order (middle position)', async () => {
    const result = await registerBrowserContent('/engine', 'customPanel.js');

    expect(result.skipped).toBe(false);
    expect(result.manifest).toBe('browser/base/jar.mn');
    expect(mockWriteText).toHaveBeenCalled();

    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    const lines = written.split('\n');
    const customIdx = lines.findIndex((l: string) => l.includes('customPanel.js'));
    const browserIdx = lines.findIndex((l: string) => l.includes('browser.js'));
    const placesIdx = lines.findIndex((l: string) => l.includes('places.js'));

    expect(customIdx).toBeGreaterThan(browserIdx);
    expect(customIdx).toBeLessThan(placesIdx);
  });

  it('is idempotent — skips if already registered', async () => {
    mockReadText.mockResolvedValue(MOCK_JAR_MN.replace('places.js', 'customPanel.js'));

    const result = await registerBrowserContent('/engine', 'customPanel.js');
    expect(result.skipped).toBe(true);
    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it('throws when the manifest is missing', async () => {
    mockPathExists.mockResolvedValue(false);

    await expect(registerBrowserContent('/engine', 'customPanel.js')).rejects.toThrow(
      'Manifest not found'
    );
  });

  it('respects the dryRun flag (no file write)', async () => {
    const result = await registerBrowserContent(
      '/engine',
      'customPanel.js',
      undefined,
      undefined,
      true
    );

    expect(result.skipped).toBe(false);
    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it('uses custom sourcePath when provided', async () => {
    const result = await registerBrowserContent(
      '/engine',
      'customPanel.js',
      undefined,
      'modules/custom/customPanel.js'
    );

    expect(result.entry).toContain('modules/custom/customPanel.js');
  });

  it('inserts after a specific target when --after is provided', async () => {
    const result = await registerBrowserContent('/engine', 'customPanel.js', 'aboutDialog.js');

    expect(result.skipped).toBe(false);

    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    const lines = written.split('\n');
    const aboutIdx = lines.findIndex((l: string) => l.includes('aboutDialog.js'));
    const customIdx = lines.findIndex((l: string) => l.includes('customPanel.js'));

    expect(customIdx).toBe(aboutIdx + 1);
  });

  it('falls back to alphabetical when --after target is not found', async () => {
    const result = await registerBrowserContent('/engine', 'customPanel.js', 'nonexistent.js');

    expect(result.skipped).toBe(false);
    expect(result.afterFallback).toBe(true);
  });
});
