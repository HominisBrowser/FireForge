// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runCheckJs } from '../patch-lint-checkjs.js';

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
  readText: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  verbose: vi.fn(),
}));

import { pathExists } from '../../utils/fs.js';

const mockPathExists = vi.mocked(pathExists);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runCheckJs', () => {
  it('returns empty when no files are provided', async () => {
    const issues = await runCheckJs('/engine', new Set());
    expect(issues).toHaveLength(0);
  });

  it('returns empty when owned files do not exist on disk', async () => {
    mockPathExists.mockResolvedValue(false);
    const issues = await runCheckJs('/engine', new Set(['missing/Module.sys.mjs']));
    expect(issues).toHaveLength(0);
  });

  it('detects type errors in patch-owned files', async () => {
    // This test exercises the real TypeScript compiler. It creates a
    // temporary file with an intentional type error and verifies that
    // runCheckJs reports it.
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');

    const tmpDir = await mkdtemp(join(tmpdir(), 'ff-checkjs-'));
    const filePath = join(tmpDir, 'Bad.sys.mjs');
    await writeFile(
      filePath,
      ['/** @type {number} */', 'export const value = "not a number";', ''].join('\n')
    );

    // Restore real pathExists for the temp file
    mockPathExists.mockImplementation(async (p) => {
      const { existsSync } = await import('node:fs');
      return existsSync(p);
    });

    try {
      const issues = await runCheckJs(tmpDir, new Set(['Bad.sys.mjs']));
      // TypeScript should flag the type mismatch
      expect(issues.length).toBeGreaterThanOrEqual(1);
      expect(issues.some((i) => i.check === 'checkjs-type-error')).toBe(true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
