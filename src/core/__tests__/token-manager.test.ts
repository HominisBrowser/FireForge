// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { addToken } from '../token-manager.js';

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
  readText: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  warn: vi.fn(),
}));

vi.mock('../config.js', () => ({
  getProjectPaths: vi.fn(() => ({
    root: '/project',
    engine: '/project/engine',
    config: '/project/fireforge.json',
    fireforgeDir: '/project/.fireforge',
    state: '/project/.fireforge/state.json',
    patches: '/project/patches',
    configs: '/project/configs',
    src: '/project/src',
    componentsDir: '/project/components',
  })),
  loadConfig: vi.fn(() =>
    Promise.resolve({
      name: 'Test Browser',
      vendor: 'Test',
      appId: 'org.test.browser',
      binaryName: 'testbrowser',
      firefox: { version: '145.0', product: 'firefox' },
    })
  ),
}));

vi.mock('../furnace-config.js', () => ({
  loadFurnaceConfig: vi.fn(() => ({
    version: 1,
    componentPrefix: 'moz-',
    tokenPrefix: '--testbrowser-',
    stock: [],
    overrides: {},
    custom: {},
  })),
  getFurnacePaths: vi.fn(),
}));

import { pathExists, readText, writeText } from '../../utils/fs.js';
import { warn } from '../../utils/logger.js';
import { loadFurnaceConfig } from '../furnace-config.js';

const mockPathExists = vi.mocked(pathExists);
const mockReadText = vi.mocked(readText);
const mockWriteText = vi.mocked(writeText);

const MOCK_TOKENS_CSS = `:root {
  /* ================================================= */
  /* = Colors — Canvas                              = */
  /* ================================================= */
  --testbrowser-canvas-bg: var(--background-color-box); /* auto */
  --testbrowser-canvas-fg: var(--text-color); /* auto */

  /* ================================================= */
  /* = Spacing                                       = */
  /* ================================================= */
  --testbrowser-space-small: 4px; /* static, fork-specific */
}

@media (prefers-color-scheme: dark) {
  :root {
    --testbrowser-dark-override: #222;
  }
}
`;

const MOCK_TOKENS_CSS_MULTILINE = `:root {
  /* ================================================================
   * Colors — Canvas
   * ================================================================ */
  --testbrowser-canvas-bg: var(--background-color-box); /* auto */
  --testbrowser-canvas-fg: var(--text-color); /* auto */

  /* ================================================================
   * Spacing
   * ================================================================ */
  --testbrowser-space-small: 4px; /* static, fork-specific */
}

@media (prefers-color-scheme: dark) {
  :root {
    --testbrowser-dark-override: #222;
  }
}
`;

const MOCK_TOKENS_DOC = `# Design Tokens

## Token Table

| Category | Token | Value | Maps to | Mode |
|----------|-------|-------|---------|------|
| Colors — Canvas | \`--testbrowser-canvas-bg\` | \`var(--background-color-box)\` | --background-color-box | auto |
| Colors — Canvas | \`--testbrowser-canvas-fg\` | \`var(--text-color)\` | --text-color | auto |
| Spacing | \`--testbrowser-space-small\` | \`4px\` | — | static |

## Dark/Light Mode Behavior

| Mode | Count |
|------|-------|
| auto | 2 |
| static | 1 |
| override | 0 |

## Tokens not yet mapped

| Token | Value | Notes |
|-------|-------|-------|
| \`--testbrowser-space-small\` | \`4px\` | spacing |
`;

beforeEach(() => {
  vi.clearAllMocks();
  mockPathExists.mockResolvedValue(true);
});

function makeReadTextImpl(css: string, doc: string) {
  return (path: string): Promise<string> => {
    if (path.includes('testbrowser-tokens.css')) return Promise.resolve(css);
    if (path.includes('SRC_TOKENS.md')) return Promise.resolve(doc);
    return Promise.resolve('');
  };
}

describe('addToken', () => {
  it('inserts token in the correct CSS category section', async () => {
    mockReadText.mockImplementation(makeReadTextImpl(MOCK_TOKENS_CSS, MOCK_TOKENS_DOC));

    const result = await addToken('/project', {
      tokenName: '--testbrowser-canvas-dot-size',
      value: '1px',
      category: 'Colors — Canvas',
      mode: 'static',
      description: 'Dot grid dot diameter',
    });

    expect(result.cssAdded).toBe(true);
    expect(result.skipped).toBe(false);

    // Check CSS write
    const cssCall = mockWriteText.mock.calls.find((c) => c[0].includes('testbrowser-tokens.css'));
    expect(cssCall).toBeDefined();
    const cssContent = cssCall?.[1] ?? '';

    // Should be in Colors — Canvas section
    const canvasSectionIdx = cssContent.indexOf('Colors — Canvas');
    const dotSizeIdx = cssContent.indexOf('--testbrowser-canvas-dot-size');
    const spacingSectionIdx = cssContent.indexOf('Spacing');
    expect(dotSizeIdx).toBeGreaterThan(canvasSectionIdx);
    expect(dotSizeIdx).toBeLessThan(spacingSectionIdx);

    // Should have description comment and mode annotation
    expect(cssContent).toContain('/* Dot grid dot diameter */');
    expect(cssContent).toContain('/* static, fork-specific */');
  });

  it('generates correct mode annotation for auto with light-dark()', async () => {
    mockReadText.mockImplementation(makeReadTextImpl(MOCK_TOKENS_CSS, MOCK_TOKENS_DOC));

    await addToken('/project', {
      tokenName: '--testbrowser-canvas-adaptive',
      value: 'light-dark(#fff, #000)',
      category: 'Colors — Canvas',
      mode: 'auto',
    });

    const cssCall = mockWriteText.mock.calls.find((c) => c[0].includes('testbrowser-tokens.css'));
    expect(cssCall?.[1]).toContain('/* auto (light-dark) */');
  });

  it('generates correct mode annotation for static with var() reference', async () => {
    mockReadText.mockImplementation(makeReadTextImpl(MOCK_TOKENS_CSS, MOCK_TOKENS_DOC));

    await addToken('/project', {
      tokenName: '--testbrowser-canvas-ref',
      value: 'var(--background-color)',
      category: 'Colors — Canvas',
      mode: 'static',
    });

    const cssCall = mockWriteText.mock.calls.find((c) => c[0].includes('testbrowser-tokens.css'));
    // var() reference with static mode = "static" (not fork-specific)
    expect(cssCall?.[1]).toContain(
      '--testbrowser-canvas-ref: var(--background-color); /* static */'
    );
  });

  it('inserts docs table row in the correct category group', async () => {
    mockReadText.mockImplementation(makeReadTextImpl(MOCK_TOKENS_CSS, MOCK_TOKENS_DOC));

    await addToken('/project', {
      tokenName: '--testbrowser-canvas-dot-size',
      value: '1px',
      category: 'Colors — Canvas',
      mode: 'static',
      description: 'Dot grid dot diameter',
    });

    const docCall = mockWriteText.mock.calls.find((c) => c[0].includes('SRC_TOKENS.md'));
    expect(docCall).toBeDefined();
    const docContent = docCall?.[1] ?? '';

    // Should contain the new row
    expect(docContent).toContain('--testbrowser-canvas-dot-size');
    expect(docContent).toContain('`1px`');
  });

  it('adds literal values to the unmapped tokens table', async () => {
    mockReadText.mockImplementation(makeReadTextImpl(MOCK_TOKENS_CSS, MOCK_TOKENS_DOC));

    const result = await addToken('/project', {
      tokenName: '--testbrowser-canvas-dot-size',
      value: '1px',
      category: 'Colors — Canvas',
      mode: 'static',
    });

    expect(result.unmappedAdded).toBe(true);

    const docCall = mockWriteText.mock.calls.find((c) => c[0].includes('SRC_TOKENS.md'));
    const docContent = docCall?.[1] ?? '';
    // The unmapped table should include the new token
    const unmappedIdx = docContent.indexOf('not yet mapped');
    const tokenInUnmapped = docContent.indexOf('--testbrowser-canvas-dot-size', unmappedIdx);
    expect(tokenInUnmapped).toBeGreaterThan(unmappedIdx);
  });

  it('does NOT add var() references to the unmapped tokens table', async () => {
    mockReadText.mockImplementation(makeReadTextImpl(MOCK_TOKENS_CSS, MOCK_TOKENS_DOC));

    const result = await addToken('/project', {
      tokenName: '--testbrowser-canvas-ref',
      value: 'var(--background-color)',
      category: 'Colors — Canvas',
      mode: 'auto',
    });

    expect(result.unmappedAdded).toBe(false);
  });

  it('updates the mode count in the behavior table', async () => {
    mockReadText.mockImplementation(makeReadTextImpl(MOCK_TOKENS_CSS, MOCK_TOKENS_DOC));

    await addToken('/project', {
      tokenName: '--testbrowser-canvas-dot-size',
      value: '1px',
      category: 'Colors — Canvas',
      mode: 'static',
    });

    const docCall = mockWriteText.mock.calls.find((c) => c[0].includes('SRC_TOKENS.md'));
    const docContent = docCall?.[1] ?? '';
    // static count should be incremented from 1 to 2
    expect(docContent).toContain('| static | 2 |');
  });

  it('is idempotent — skips if token already exists in CSS', async () => {
    mockReadText.mockImplementation(makeReadTextImpl(MOCK_TOKENS_CSS, MOCK_TOKENS_DOC));

    const result = await addToken('/project', {
      tokenName: '--testbrowser-canvas-bg',
      value: 'var(--background-color-box)',
      category: 'Colors — Canvas',
      mode: 'auto',
    });

    expect(result.skipped).toBe(true);
    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it('validates token prefix against furnace config', async () => {
    await expect(
      addToken('/project', {
        tokenName: '--wrong-prefix-token',
        value: '1px',
        category: 'Colors — Canvas',
        mode: 'static',
      })
    ).rejects.toThrow('does not match the configured prefix');
  });

  it('requires dark-value for override mode', async () => {
    await expect(
      addToken('/project', {
        tokenName: '--testbrowser-test-override',
        value: '#fff',
        category: 'Colors — Canvas',
        mode: 'override',
      })
    ).rejects.toThrow('--dark-value');
  });

  it('validates prefix even in dry-run mode', async () => {
    await expect(
      addToken('/project', {
        tokenName: '--wrong-prefix-token',
        value: '1px',
        category: 'Colors — Canvas',
        mode: 'static',
        dryRun: true,
      })
    ).rejects.toThrow('does not match the configured prefix');
  });

  it('validates category existence even in dry-run mode', async () => {
    mockReadText.mockImplementation(makeReadTextImpl(MOCK_TOKENS_CSS, MOCK_TOKENS_DOC));

    await expect(
      addToken('/project', {
        tokenName: '--testbrowser-audit-token',
        value: '1px',
        category: 'Missing Category',
        mode: 'static',
        dryRun: true,
      })
    ).rejects.toThrow('Category "Missing Category" not found');
  });

  it('inserts dark value in @media block for override mode', async () => {
    mockReadText.mockImplementation(makeReadTextImpl(MOCK_TOKENS_CSS, MOCK_TOKENS_DOC));

    await addToken('/project', {
      tokenName: '--testbrowser-canvas-override-test',
      value: '#fff',
      category: 'Colors — Canvas',
      mode: 'override',
      darkValue: '#000',
    });

    const cssCall = mockWriteText.mock.calls.find((c) => c[0].includes('testbrowser-tokens.css'));
    expect(cssCall).toBeDefined();
    const cssContent = cssCall?.[1] ?? '';

    // Main value in :root
    expect(cssContent).toContain('--testbrowser-canvas-override-test: #fff; /* override */');

    // Dark value in @media block
    const darkMediaIdx = cssContent.indexOf('prefers-color-scheme: dark');
    const darkValueIdx = cssContent.indexOf(
      '--testbrowser-canvas-override-test: #000',
      darkMediaIdx
    );
    expect(darkValueIdx).toBeGreaterThan(darkMediaIdx);
  });

  it('handles multi-line category block headers', async () => {
    mockReadText.mockImplementation(makeReadTextImpl(MOCK_TOKENS_CSS_MULTILINE, MOCK_TOKENS_DOC));

    const result = await addToken('/project', {
      tokenName: '--testbrowser-canvas-dot-size',
      value: '1px',
      category: 'Colors — Canvas',
      mode: 'static',
      description: 'Dot grid dot diameter',
    });

    expect(result.cssAdded).toBe(true);
    expect(result.skipped).toBe(false);

    const cssCall = mockWriteText.mock.calls.find((c) => c[0].includes('testbrowser-tokens.css'));
    expect(cssCall).toBeDefined();
    const cssContent = cssCall?.[1] ?? '';

    // Should be in Colors — Canvas section (before Spacing section)
    const canvasSectionIdx = cssContent.indexOf('Colors — Canvas');
    const dotSizeIdx = cssContent.indexOf('--testbrowser-canvas-dot-size');
    const spacingSectionIdx = cssContent.indexOf('Spacing');
    expect(dotSizeIdx).toBeGreaterThan(canvasSectionIdx);
    expect(dotSizeIdx).toBeLessThan(spacingSectionIdx);

    // Should have description comment and mode annotation
    expect(cssContent).toContain('/* Dot grid dot diameter */');
    expect(cssContent).toContain('/* static, fork-specific */');
  });

  it('is idempotent with multi-line headers', async () => {
    mockReadText.mockImplementation(makeReadTextImpl(MOCK_TOKENS_CSS_MULTILINE, MOCK_TOKENS_DOC));

    const result = await addToken('/project', {
      tokenName: '--testbrowser-canvas-bg',
      value: 'var(--background-color-box)',
      category: 'Colors — Canvas',
      mode: 'auto',
    });

    expect(result.skipped).toBe(true);
    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it('warns when furnace config load fails with a non-FurnaceError', async () => {
    vi.mocked(loadFurnaceConfig).mockRejectedValueOnce(new Error('permission denied'));

    const result = await addToken('/project', {
      tokenName: '--testbrowser-canvas-gap',
      value: '12px',
      category: 'Spacing',
      mode: 'static',
    });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Skipping token prefix validation: permission denied')
    );
    expect(result.skipped).toBe(false);
  });

  it('rejects token names with whitespace', async () => {
    mockReadText.mockImplementation(makeReadTextImpl(MOCK_TOKENS_CSS, MOCK_TOKENS_DOC));

    await expect(
      addToken('/project', {
        tokenName: '--bad token',
        value: '1px',
        category: 'Colors — Canvas',
        mode: 'static',
      })
    ).rejects.toThrow('whitespace');
  });

  it('rejects token names with comment-breaking sequences', async () => {
    mockReadText.mockImplementation(makeReadTextImpl(MOCK_TOKENS_CSS, MOCK_TOKENS_DOC));

    await expect(
      addToken('/project', {
        tokenName: '--bad*/token',
        value: '1px',
        category: 'Colors — Canvas',
        mode: 'static',
      })
    ).rejects.toThrow('*/');
  });

  it('rejects token names with control characters', async () => {
    mockReadText.mockImplementation(makeReadTextImpl(MOCK_TOKENS_CSS, MOCK_TOKENS_DOC));

    await expect(
      addToken('/project', {
        tokenName: '--bad\nname',
        value: '1px',
        category: 'Colors — Canvas',
        mode: 'static',
      })
    ).rejects.toThrow(/whitespace/);
  });

  it('does not warn when furnace config is simply missing (FurnaceError)', async () => {
    const { FurnaceError } = await import('../../errors/furnace.js');
    vi.mocked(loadFurnaceConfig).mockRejectedValueOnce(
      new FurnaceError('Furnace configuration file not found: /project/furnace.json')
    );

    const result = await addToken('/project', {
      tokenName: '--testbrowser-canvas-gap',
      value: '12px',
      category: 'Spacing',
      mode: 'static',
    });

    expect(warn).not.toHaveBeenCalled();
    expect(result.skipped).toBe(false);
  });
});
