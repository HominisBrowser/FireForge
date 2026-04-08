// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
  readText: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock('../../utils/platform.js', () => ({
  getPlatform: vi.fn(() => 'linux'),
}));

vi.mock('../../errors/build.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../errors/build.js')>();
  return actual;
});

import type { FireForgeConfig } from '../../types/config.js';
import { pathExists, readText, writeText } from '../../utils/fs.js';
import { generateMozconfig } from '../mach-mozconfig.js';

const mockPathExists = vi.mocked(pathExists);
const mockReadText = vi.mocked(readText);
const mockWriteText = vi.mocked(writeText);

const config = {
  name: 'TestBrowser',
  vendor: 'TestVendor',
  appId: 'test.browser.id',
  binaryName: 'testbrowser',
} as FireForgeConfig;

beforeEach(() => {
  vi.clearAllMocks();
  mockWriteText.mockResolvedValue(undefined);
});

describe('generateMozconfig', () => {
  it('generates mozconfig from common and platform templates', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText
      .mockResolvedValueOnce('COMMON_OPT=${name}')
      .mockResolvedValueOnce('PLATFORM_OPT=${vendor}');

    await generateMozconfig('/configs', '/engine', config);

    expect(mockWriteText).toHaveBeenCalledWith(
      '/engine/mozconfig',
      expect.stringContaining('COMMON_OPT=TestBrowser')
    );
    expect(mockWriteText).toHaveBeenCalledWith(
      '/engine/mozconfig',
      expect.stringContaining('PLATFORM_OPT=TestVendor')
    );
  });

  it('skips common template when it does not exist', async () => {
    mockPathExists
      .mockResolvedValueOnce(false) // common does not exist
      .mockResolvedValueOnce(true); // platform exists
    mockReadText.mockResolvedValue('PLATFORM=${binaryName}');

    await generateMozconfig('/configs', '/engine', config);

    const written = mockWriteText.mock.calls[0]?.[1] as string;
    expect(written).not.toContain('Common configuration');
    expect(written).toContain('PLATFORM=testbrowser');
  });

  it('throws when platform template does not exist', async () => {
    mockPathExists
      .mockResolvedValueOnce(true) // common exists
      .mockResolvedValueOnce(false); // platform does not exist

    await expect(generateMozconfig('/configs', '/engine', config)).rejects.toThrow(
      'Platform mozconfig not found'
    );
  });

  it('replaces all template variables', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText
      .mockResolvedValueOnce('${name} ${vendor}')
      .mockResolvedValueOnce('${appId} ${binaryName}');

    await generateMozconfig('/configs', '/engine', config);

    const written = mockWriteText.mock.calls[0]?.[1] as string;
    expect(written).toContain('TestBrowser TestVendor');
    expect(written).toContain('test.browser.id testbrowser');
  });
});
