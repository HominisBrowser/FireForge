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
import { registerFireForgeModule } from '../register-module.js';

const mockPathExists = vi.mocked(pathExists);
const mockReadText = vi.mocked(readText);
const mockWriteText = vi.mocked(writeText);

const MOCK_MOZ_BUILD = `
EXTRA_JS_MODULES += [
    "AlphaModule.sys.mjs",
    "BravoModule.sys.mjs",
    "ZuluModule.sys.mjs",
]
`.trimStart();

describe('registerFireForgeModule', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(MOCK_MOZ_BUILD);
    mockWriteText.mockResolvedValue(undefined);
  });

  it('inserts module entry in alphabetical order', async () => {
    const result = await registerFireForgeModule(
      '/engine',
      'CharlieModule.sys.mjs',
      'browser/modules/testbrowser'
    );

    expect(result.skipped).toBe(false);
    expect(result.manifest).toBe('browser/modules/testbrowser/moz.build');
    expect(mockWriteText).toHaveBeenCalled();

    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    const lines = written.split('\n');
    const charlieIdx = lines.findIndex((l: string) => l.includes('CharlieModule'));
    const bravoIdx = lines.findIndex((l: string) => l.includes('BravoModule'));
    const zuluIdx = lines.findIndex((l: string) => l.includes('ZuluModule'));

    expect(charlieIdx).toBeGreaterThan(bravoIdx);
    expect(charlieIdx).toBeLessThan(zuluIdx);
  });

  it('is idempotent — skips if already registered', async () => {
    const result = await registerFireForgeModule(
      '/engine',
      'BravoModule.sys.mjs',
      'browser/modules/testbrowser'
    );

    expect(result.skipped).toBe(true);
    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it('throws when moz.build is missing', async () => {
    mockPathExists.mockResolvedValue(false);

    await expect(
      registerFireForgeModule('/engine', 'CharlieModule.sys.mjs', 'browser/modules/testbrowser')
    ).rejects.toThrow('Manifest not found');
  });

  it('respects the dryRun flag (no file write)', async () => {
    const result = await registerFireForgeModule(
      '/engine',
      'CharlieModule.sys.mjs',
      'browser/modules/testbrowser',
      true
    );

    expect(result.skipped).toBe(false);
    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it('formats the entry with 4-space indent and trailing comma', async () => {
    const result = await registerFireForgeModule(
      '/engine',
      'CharlieModule.sys.mjs',
      'browser/modules/testbrowser'
    );

    expect(result.entry).toBe('    "CharlieModule.sys.mjs",');
  });
});
