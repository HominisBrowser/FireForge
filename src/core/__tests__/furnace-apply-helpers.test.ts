// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyCustomComponent,
  applyOverrideComponent,
  computeComponentChecksums,
  extractComponentChecksums,
  hasComponentChanged,
  prefixChecksums,
} from '../furnace-apply-helpers.js';

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
  readText: vi.fn(),
  copyFile: vi.fn(),
  ensureDir: vi.fn(),
}));

vi.mock('../furnace-registration.js', () => ({
  addCustomElementRegistration: vi.fn(),
  addJarMnEntries: vi.fn(),
}));

import { readdir } from 'node:fs/promises';
vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
}));

import { copyFile, ensureDir, pathExists, readText } from '../../utils/fs.js';
import { addCustomElementRegistration, addJarMnEntries } from '../furnace-registration.js';

const mockReaddir = vi.mocked(readdir);
const mockPathExists = vi.mocked(pathExists);
const mockReadText = vi.mocked(readText);
const mockCopyFile = vi.mocked(copyFile);
const mockEnsureDir = vi.mocked(ensureDir);
const mockAddCEReg = vi.mocked(addCustomElementRegistration);
const mockAddJarMn = vi.mocked(addJarMnEntries);

function fakeEntry(name: string, isFile = true): import('node:fs').Dirent {
  return { name, isFile: () => isFile } as unknown as import('node:fs').Dirent;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('computeComponentChecksums', () => {
  it('checksums .mjs, .css, and .ftl files', async () => {
    mockReaddir.mockResolvedValueOnce([
      fakeEntry('comp.mjs'),
      fakeEntry('comp.css'),
      fakeEntry('comp.ftl'),
      fakeEntry('override.json'),
      fakeEntry('readme.md'),
    ] as never);
    mockReadText.mockResolvedValue('content');

    const result = await computeComponentChecksums('/comp');

    expect(Object.keys(result)).toEqual(['comp.mjs', 'comp.css', 'comp.ftl']);
    expect(mockReadText).toHaveBeenCalledTimes(3);
  });

  it('skips directories', async () => {
    mockReaddir.mockResolvedValueOnce([fakeEntry('sub', false)] as never);

    const result = await computeComponentChecksums('/comp');

    expect(Object.keys(result)).toHaveLength(0);
  });

  it('normalizes BOM and CRLF before hashing', async () => {
    mockReaddir.mockResolvedValueOnce([fakeEntry('comp.mjs')] as never);
    mockReadText.mockResolvedValueOnce('\uFEFFline1\r\nline2');

    const withBom = await computeComponentChecksums('/comp');

    mockReaddir.mockResolvedValueOnce([fakeEntry('comp.mjs')] as never);
    mockReadText.mockResolvedValueOnce('line1\nline2');

    const withoutBom = await computeComponentChecksums('/comp');

    expect(withBom['comp.mjs']).toBe(withoutBom['comp.mjs']);
  });
});

describe('hasComponentChanged', () => {
  it('returns false when checksums match', async () => {
    mockReaddir.mockResolvedValueOnce([fakeEntry('comp.mjs')] as never);
    mockReadText.mockResolvedValue('content');

    // Get current checksums first
    const checksums = await computeComponentChecksums('/comp');

    mockReaddir.mockResolvedValueOnce([fakeEntry('comp.mjs')] as never);
    mockReadText.mockResolvedValue('content');

    const changed = await hasComponentChanged('/comp', checksums);
    expect(changed).toBe(false);
  });

  it('returns true when file count differs', async () => {
    mockReaddir.mockResolvedValueOnce([fakeEntry('a.mjs'), fakeEntry('b.css')] as never);
    mockReadText.mockResolvedValue('content');

    const changed = await hasComponentChanged('/comp', { 'a.mjs': 'hash1' });
    expect(changed).toBe(true);
  });

  it('returns true when hash differs', async () => {
    mockReaddir.mockResolvedValueOnce([fakeEntry('a.mjs')] as never);
    mockReadText.mockResolvedValue('new content');

    const changed = await hasComponentChanged('/comp', { 'a.mjs': 'old-hash' });
    expect(changed).toBe(true);
  });
});

describe('extractComponentChecksums', () => {
  it('extracts prefixed checksums for a component', () => {
    const all = {
      'custom/btn/btn.mjs': 'hash1',
      'custom/btn/btn.css': 'hash2',
      'override/card/card.css': 'hash3',
    };

    const result = extractComponentChecksums(all, 'custom', 'btn');

    expect(result).toEqual({ 'btn.mjs': 'hash1', 'btn.css': 'hash2' });
  });

  it('returns empty object for undefined input', () => {
    expect(extractComponentChecksums(undefined, 'custom', 'btn')).toEqual({});
  });
});

describe('prefixChecksums', () => {
  it('adds type/name/ prefix to all keys', () => {
    const result = prefixChecksums({ 'a.mjs': 'h1', 'b.css': 'h2' }, 'custom', 'btn');

    expect(result).toEqual({
      'custom/btn/a.mjs': 'h1',
      'custom/btn/b.css': 'h2',
    });
  });
});

describe('applyCustomComponent', () => {
  it('rejects invalid component names', async () => {
    await expect(
      applyCustomComponent('/engine', 'INVALID', '/comp', {
        description: 'test',
        targetPath: 'toolkit/content/widgets/invalid',
        register: false,
        localized: false,
      })
    ).rejects.toThrow('Invalid component name');
  });

  it('copies .mjs and .css files in live mode', async () => {
    mockReaddir.mockResolvedValueOnce([
      fakeEntry('my-btn.mjs'),
      fakeEntry('my-btn.css'),
      fakeEntry('readme.md'),
    ] as never);

    const result = await applyCustomComponent('/engine', 'my-btn', '/comp/my-btn', {
      description: 'Button',
      targetPath: 'toolkit/content/widgets/my-btn',
      register: false,
      localized: false,
    });

    expect(mockEnsureDir).toHaveBeenCalled();
    expect(mockCopyFile).toHaveBeenCalledTimes(2);
    // 2 copied files + jar.mn entry = 3 affected paths
    expect(result.affectedPaths).toHaveLength(3);
    expect(result.stepErrors).toHaveLength(0);
  });

  it('registers in customElements.js when register is true', async () => {
    mockReaddir.mockResolvedValueOnce([fakeEntry('my-btn.mjs')] as never);

    await applyCustomComponent('/engine', 'my-btn', '/comp/my-btn', {
      description: 'Button',
      targetPath: 'toolkit/content/widgets/my-btn',
      register: true,
      localized: false,
    });

    expect(mockAddCEReg).toHaveBeenCalledWith(
      '/engine',
      'my-btn',
      'chrome://global/content/elements/my-btn.mjs'
    );
    expect(mockAddJarMn).toHaveBeenCalled();
  });

  it('collects step errors without throwing', async () => {
    mockReaddir.mockResolvedValueOnce([fakeEntry('my-btn.mjs')] as never);
    mockAddCEReg.mockRejectedValueOnce(new Error('parse error'));

    const result = await applyCustomComponent('/engine', 'my-btn', '/comp/my-btn', {
      description: 'Button',
      targetPath: 'toolkit/content/widgets/my-btn',
      register: true,
      localized: false,
    });

    expect(result.stepErrors).toHaveLength(1);
    expect(result.stepErrors[0]?.step).toBe('customElements.js registration');
  });

  it('copies .ftl file when localized', async () => {
    mockReaddir.mockResolvedValueOnce([fakeEntry('my-btn.mjs')] as never);
    mockPathExists.mockResolvedValue(true);

    await applyCustomComponent('/engine', 'my-btn', '/comp/my-btn', {
      description: 'Button',
      targetPath: 'toolkit/content/widgets/my-btn',
      register: false,
      localized: true,
    });

    // 1 .mjs copy + 1 .ftl copy
    expect(mockCopyFile).toHaveBeenCalledTimes(2);
  });

  it('returns dry-run actions without copying', async () => {
    mockReaddir.mockResolvedValueOnce([fakeEntry('my-btn.mjs'), fakeEntry('my-btn.css')] as never);
    mockPathExists.mockResolvedValue(false);

    const result = await applyCustomComponent(
      '/engine',
      'my-btn',
      '/comp/my-btn',
      {
        description: 'Button',
        targetPath: 'toolkit/content/widgets/my-btn',
        register: true,
        localized: false,
      },
      true
    );

    expect(result.actions).toBeDefined();
    expect(result.affectedPaths).toHaveLength(0);
    expect(mockCopyFile).not.toHaveBeenCalled();
  });
});

describe('applyOverrideComponent', () => {
  it('throws when target path does not exist', async () => {
    mockPathExists.mockResolvedValue(false);

    await expect(
      applyOverrideComponent('/engine', 'moz-card', '/comp/moz-card', {
        type: 'css-only',
        description: 'Card override',
        basePath: 'toolkit/content/widgets/moz-card',
        baseVersion: '145.0',
      })
    ).rejects.toThrow('Override target path not found');
  });

  it('copies only CSS files for css-only overrides', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReaddir.mockResolvedValueOnce([
      fakeEntry('moz-card.css'),
      fakeEntry('moz-card.mjs'),
      fakeEntry('override.json'),
    ] as never);

    const result = await applyOverrideComponent('/engine', 'moz-card', '/comp/moz-card', {
      type: 'css-only',
      description: 'Card override',
      basePath: 'toolkit/content/widgets/moz-card',
      baseVersion: '145.0',
    });

    expect(mockCopyFile).toHaveBeenCalledTimes(1);
    expect(result.affectedPaths).toHaveLength(1);
  });

  it('copies .mjs and .css for full overrides', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReaddir.mockResolvedValueOnce([
      fakeEntry('moz-card.css'),
      fakeEntry('moz-card.mjs'),
      fakeEntry('override.json'),
    ] as never);

    const result = await applyOverrideComponent('/engine', 'moz-card', '/comp/moz-card', {
      type: 'full',
      description: 'Full override',
      basePath: 'toolkit/content/widgets/moz-card',
      baseVersion: '145.0',
    });

    expect(mockCopyFile).toHaveBeenCalledTimes(2);
    expect(result.affectedPaths).toHaveLength(2);
  });

  it('throws when no matching files are found', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReaddir.mockResolvedValueOnce([fakeEntry('readme.md')] as never);

    await expect(
      applyOverrideComponent('/engine', 'moz-card', '/comp/moz-card', {
        type: 'css-only',
        description: 'Card override',
        basePath: 'toolkit/content/widgets/moz-card',
        baseVersion: '145.0',
      })
    ).rejects.toThrow('No matching files');
  });

  it('returns dry-run actions without copying', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReaddir.mockResolvedValueOnce([fakeEntry('moz-card.css')] as never);

    const result = await applyOverrideComponent(
      '/engine',
      'moz-card',
      '/comp/moz-card',
      {
        type: 'css-only',
        description: 'Card override',
        basePath: 'toolkit/content/widgets/moz-card',
        baseVersion: '145.0',
      },
      true
    );

    expect(result.actions).toBeDefined();
    expect(result.affectedPaths).toHaveLength(0);
    expect(mockCopyFile).not.toHaveBeenCalled();
  });
});
