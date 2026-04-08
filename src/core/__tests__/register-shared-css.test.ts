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
import { registerSharedCSS } from '../register-shared-css.js';

const mockPathExists = vi.mocked(pathExists);
const mockReadText = vi.mocked(readText);
const mockWriteText = vi.mocked(writeText);

const MOCK_JAR_INC_MN = `
  skin/classic/browser/autocomplete.css    (../shared/autocomplete.css)
  skin/classic/browser/browser.css         (../shared/browser.css)
  skin/classic/browser/zoom.css            (../shared/zoom.css)
`.trimStart();

describe('registerSharedCSS', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(MOCK_JAR_INC_MN);
    mockWriteText.mockResolvedValue(undefined);
  });

  it('inserts CSS entry in alphabetical order (middle)', async () => {
    const result = await registerSharedCSS('/engine', 'custom.css');

    expect(result.skipped).toBe(false);
    expect(result.manifest).toBe('browser/themes/shared/jar.inc.mn');
    expect(mockWriteText).toHaveBeenCalled();

    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    const lines = written.split('\n');
    const customIdx = lines.findIndex((l: string) => l.includes('custom.css'));
    const browserIdx = lines.findIndex((l: string) => l.includes('browser.css'));
    const zoomIdx = lines.findIndex((l: string) => l.includes('zoom.css'));

    expect(customIdx).toBeGreaterThan(browserIdx);
    expect(customIdx).toBeLessThan(zoomIdx);
  });

  it('is idempotent — skips if already registered', async () => {
    const content =
      MOCK_JAR_INC_MN + '  skin/classic/browser/custom.css    (../shared/custom.css)\n';
    mockReadText.mockResolvedValue(content);

    const result = await registerSharedCSS('/engine', 'custom.css');
    expect(result.skipped).toBe(true);
    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it('throws when the manifest is missing', async () => {
    mockPathExists.mockResolvedValue(false);

    await expect(registerSharedCSS('/engine', 'custom.css')).rejects.toThrow('Manifest not found');
  });

  it('respects the dryRun flag (no file write)', async () => {
    const result = await registerSharedCSS('/engine', 'custom.css', undefined, true);

    expect(result.skipped).toBe(false);
    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it('strips .css extension from fileName for the entry name', async () => {
    const result = await registerSharedCSS('/engine', 'custom.css');

    expect(result.entry).toContain('skin/classic/browser/custom.css');
    expect(result.entry).toContain('(../shared/custom.css)');
  });

  it('inserts after a specific target when --after is provided', async () => {
    const result = await registerSharedCSS('/engine', 'custom.css', 'autocomplete.css');

    expect(result.skipped).toBe(false);

    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    const lines = written.split('\n');
    const autoIdx = lines.findIndex((l: string) => l.includes('autocomplete.css'));
    const customIdx = lines.findIndex((l: string) => l.includes('custom.css'));

    expect(customIdx).toBe(autoIdx + 1);
  });

  it('falls back to alphabetical when --after target is not found', async () => {
    const result = await registerSharedCSS('/engine', 'custom.css', 'nonexistent.css');

    expect(result.skipped).toBe(false);
    expect(result.afterFallback).toBe(true);
  });
});
