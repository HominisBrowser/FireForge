// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn() };
});

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
}));

import { readdir } from 'node:fs/promises';

import { pathExists } from '../../utils/fs.js';
import { validateStructure } from '../furnace-validate-structure.js';

const mockPathExists = vi.mocked(pathExists);
const mockReaddir = vi.mocked(readdir);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('validateStructure', () => {
  it('reports missing .mjs for custom components', async () => {
    mockPathExists.mockResolvedValue(false);
    mockReaddir.mockResolvedValue([] as never);

    const issues = await validateStructure('/comp', 'moz-widget', 'custom');
    expect(issues.some((i) => i.check === 'missing-mjs')).toBe(true);
  });

  it('does not report missing .mjs for override components', async () => {
    mockPathExists.mockResolvedValue(false);
    mockReaddir.mockResolvedValue([] as never);

    const issues = await validateStructure('/comp', 'moz-widget', 'override');
    expect(issues.some((i) => i.check === 'missing-mjs')).toBe(false);
  });

  it('warns when .css is missing', async () => {
    mockPathExists.mockResolvedValue(false);
    mockReaddir.mockResolvedValue([] as never);

    const issues = await validateStructure('/comp', 'moz-widget', 'stock');
    expect(issues.some((i) => i.check === 'missing-css')).toBe(true);
  });

  it('reports filename mismatch for non-matching files', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReaddir.mockResolvedValue([{ isFile: () => true, name: 'wrong-name.mjs' }] as never);

    const issues = await validateStructure('/comp', 'moz-widget', 'custom');
    expect(issues.some((i) => i.check === 'filename-mismatch')).toBe(true);
  });

  it('allows files matching tag name prefix', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReaddir.mockResolvedValue([
      { isFile: () => true, name: 'moz-widget.mjs' },
      { isFile: () => true, name: 'moz-widget-utils.mjs' },
    ] as never);

    const issues = await validateStructure('/comp', 'moz-widget', 'custom');
    expect(issues.filter((i) => i.check === 'filename-mismatch')).toHaveLength(0);
  });

  it('skips test/spec/stories files', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReaddir.mockResolvedValue([
      { isFile: () => true, name: 'other.test.mjs' },
      { isFile: () => true, name: 'other.stories.mjs' },
    ] as never);

    const issues = await validateStructure('/comp', 'moz-widget', 'custom');
    expect(issues.filter((i) => i.check === 'filename-mismatch')).toHaveLength(0);
  });

  it('reports missing override.json for override type', async () => {
    mockPathExists.mockImplementation((p: string) => Promise.resolve(!p.endsWith('override.json')));
    mockReaddir.mockResolvedValue([] as never);

    const issues = await validateStructure('/comp', 'moz-widget', 'override');
    expect(issues.some((i) => i.check === 'missing-override-json')).toBe(true);
  });

  it('does not report missing override.json for custom type', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReaddir.mockResolvedValue([{ isFile: () => true, name: 'moz-widget.mjs' }] as never);

    const issues = await validateStructure('/comp', 'moz-widget', 'custom');
    expect(issues.some((i) => i.check === 'missing-override-json')).toBe(false);
  });
});
