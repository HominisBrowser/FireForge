// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { addToken } from '../token-manager.js';

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
  readText: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  info: vi.fn(),
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
  // Default fixture so tests stay order-independent: `vi.clearAllMocks()`
  // clears call records but keeps implementations, so without this a test
  // that relies on an earlier test's mockImplementation breaks when run
  // in isolation (e.g. via `vitest -t`).
  mockReadText.mockImplementation(makeReadTextImpl(MOCK_TOKENS_CSS, MOCK_TOKENS_DOC));
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

  it('mirrors an override into existing :root[data-theme] blocks (FORGE F8)', async () => {
    const cssWithThemeBlocks = `${MOCK_TOKENS_CSS}
:root[data-theme="dark"] {
  --testbrowser-dark-override: #222;
}

:root[data-theme="light"] {
  --testbrowser-dark-override: #eee;
}
`;
    mockReadText.mockImplementation(makeReadTextImpl(cssWithThemeBlocks, MOCK_TOKENS_DOC));

    await addToken('/project', {
      tokenName: '--testbrowser-canvas-theme-test',
      value: '#fff',
      category: 'Colors — Canvas',
      mode: 'override',
      darkValue: '#000',
    });

    const cssCall = mockWriteText.mock.calls.find((c) => c[0].includes('testbrowser-tokens.css'));
    const cssContent = cssCall?.[1] ?? '';

    const darkBlockIdx = cssContent.indexOf(':root[data-theme="dark"]');
    const lightBlockIdx = cssContent.indexOf(':root[data-theme="light"]');
    expect(darkBlockIdx).toBeGreaterThan(-1);
    expect(lightBlockIdx).toBeGreaterThan(darkBlockIdx);

    // Dark value lands in the data-theme dark block, base value in light.
    const darkEntryIdx = cssContent.indexOf('--testbrowser-canvas-theme-test: #000', darkBlockIdx);
    expect(darkEntryIdx).toBeGreaterThan(darkBlockIdx);
    expect(darkEntryIdx).toBeLessThan(lightBlockIdx);
    const lightEntryIdx = cssContent.indexOf(
      '--testbrowser-canvas-theme-test: #fff',
      lightBlockIdx
    );
    expect(lightEntryIdx).toBeGreaterThan(lightBlockIdx);

    // Media-query dark override still written too — all four themed lists
    // now carry the token.
    const mediaIdx = cssContent.indexOf('prefers-color-scheme: dark');
    expect(cssContent.indexOf('--testbrowser-canvas-theme-test: #000', mediaIdx)).toBeGreaterThan(
      mediaIdx
    );
  });

  it('leaves files without data-theme blocks unchanged in shape (FORGE F8)', async () => {
    mockReadText.mockImplementation(makeReadTextImpl(MOCK_TOKENS_CSS, MOCK_TOKENS_DOC));

    await addToken('/project', {
      tokenName: '--testbrowser-canvas-no-theme-blocks',
      value: '#fff',
      category: 'Colors — Canvas',
      mode: 'override',
      darkValue: '#000',
    });

    const cssCall = mockWriteText.mock.calls.find((c) => c[0].includes('testbrowser-tokens.css'));
    const cssContent = cssCall?.[1] ?? '';
    expect(cssContent).not.toContain('data-theme');
  });

  it('inserts dark value inside the nested :root { } of the dark @media block', async () => {
    // 2026-04-21 eval: `token add --mode override --dark-value ...` inserted
    // the dark declaration after the nested `:root { }` had already closed,
    // producing a declaration outside any rule block. This test pins the
    // post-fix invariant: the dark declaration must live between the inner
    // `:root {` and its matching `}`, not between the inner `}` and the
    // outer `@media {` close.
    mockReadText.mockImplementation(makeReadTextImpl(MOCK_TOKENS_CSS, MOCK_TOKENS_DOC));

    await addToken('/project', {
      tokenName: '--testbrowser-canvas-dark-anchor',
      value: '#fff',
      category: 'Colors — Canvas',
      mode: 'override',
      darkValue: '#000',
    });

    const cssCall = mockWriteText.mock.calls.find((c) => c[0].includes('testbrowser-tokens.css'));
    expect(cssCall).toBeDefined();
    const cssContent = cssCall?.[1] ?? '';

    const lines = cssContent.split('\n');
    const darkMediaOpenIdx = lines.findIndex((line) => /prefers-color-scheme:\s*dark/.test(line));
    expect(darkMediaOpenIdx).toBeGreaterThanOrEqual(0);
    const rootOpenIdx = lines.findIndex(
      (line, idx) => idx > darkMediaOpenIdx && /:root\s*\{/.test(line)
    );
    expect(rootOpenIdx).toBeGreaterThan(darkMediaOpenIdx);
    const darkEntryIdx = lines.findIndex(
      (line, idx) => idx >= rootOpenIdx && line.includes('--testbrowser-canvas-dark-anchor: #000')
    );
    expect(darkEntryIdx).toBeGreaterThan(rootOpenIdx);
    // First `}` after the inner `:root {` is the nested root's own close;
    // the dark entry must appear before it. The depth counter is the
    // reliable way to find "the brace that closes the inner :root" — any
    // `}` after `rootOpenIdx` that brings depth back to 0 is the one.
    let depth = 0;
    let innerRootCloseIdx = -1;
    for (let i = rootOpenIdx; i < lines.length; i++) {
      const line = lines[i] ?? '';
      for (const ch of line) {
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            innerRootCloseIdx = i;
            break;
          }
        }
      }
      if (innerRootCloseIdx !== -1) break;
    }
    expect(innerRootCloseIdx).toBeGreaterThan(rootOpenIdx);
    expect(darkEntryIdx).toBeLessThan(innerRootCloseIdx);
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

const MOCK_TOKENS_CSS_WITH_VARIANT = `:root {
  /* ================================================= */
  /* = Colors — Canvas                              = */
  /* ================================================= */
  --testbrowser-canvas-bg: var(--background-color-box); /* auto */
}

:root[data-skin="precision"] {
  --testbrowser-canvas-bg: #fff; /* static */
}
`;

/** Mirrors how token coverage recognises a custom-property declaration. */
const TOKEN_DECL_REGEX = /^\s*(--[\w-]+)\s*:/;

function findTokensCssWrite(): string {
  const cssCall = mockWriteText.mock.calls.find((c) => c[0].includes('testbrowser-tokens.css'));
  return cssCall?.[1] ?? '';
}

describe('addToken --variant', () => {
  it('creates the :root[attr] block when absent and inserts the declaration into it', async () => {
    mockReadText.mockImplementation(makeReadTextImpl(MOCK_TOKENS_CSS, MOCK_TOKENS_DOC));

    const result = await addToken('/project', {
      tokenName: '--testbrowser-canvas-bg',
      value: '#101010',
      category: 'Colors — Canvas',
      mode: 'static',
      variant: '[data-skin=precision]',
    });

    expect(result.cssAdded).toBe(true);
    expect(result.skipped).toBe(false);
    // Variant overrides are CSS-only — the base token owns the docs row.
    expect(result.docsAdded).toBe(false);

    const css = findTokensCssWrite();
    // Unquoted --variant is normalized to the quoted Mozilla form.
    const blockIdx = css.indexOf(':root[data-skin="precision"] {');
    expect(blockIdx).toBeGreaterThan(-1);

    // The declaration sits inside the new block (after its `{`, before `}`).
    const declIdx = css.indexOf('--testbrowser-canvas-bg: #101010;', blockIdx);
    const blockCloseIdx = css.indexOf('}', blockIdx);
    expect(declIdx).toBeGreaterThan(blockIdx);
    expect(declIdx).toBeLessThan(blockCloseIdx);

    // New block lands after the base :root and before the dark @media block.
    expect(blockIdx).toBeLessThan(css.indexOf('@media (prefers-color-scheme: dark)'));
  });

  it('appends into an existing :root[attr] block without creating a second one', async () => {
    mockReadText.mockImplementation(
      makeReadTextImpl(MOCK_TOKENS_CSS_WITH_VARIANT, MOCK_TOKENS_DOC)
    );

    const result = await addToken('/project', {
      tokenName: '--testbrowser-canvas-fg',
      value: '#eee',
      category: 'Colors — Canvas',
      mode: 'static',
      variant: '[data-skin="precision"]',
    });

    expect(result.cssAdded).toBe(true);
    const css = findTokensCssWrite();
    // Exactly one precision block.
    const occurrences = css.split(':root[data-skin="precision"]').length - 1;
    expect(occurrences).toBe(1);
    // Both the pre-existing and the new declaration live in that block.
    expect(css).toContain('--testbrowser-canvas-bg: #fff;');
    expect(css).toContain('--testbrowser-canvas-fg: #eee;');
  });

  it('is idempotent within the variant block', async () => {
    mockReadText.mockImplementation(
      makeReadTextImpl(MOCK_TOKENS_CSS_WITH_VARIANT, MOCK_TOKENS_DOC)
    );

    const result = await addToken('/project', {
      tokenName: '--testbrowser-canvas-bg',
      value: '#fff',
      category: 'Colors — Canvas',
      mode: 'static',
      variant: '[data-skin=precision]',
    });

    expect(result.skipped).toBe(true);
    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it('supports boolean attribute variants like [data-private]', async () => {
    mockReadText.mockImplementation(makeReadTextImpl(MOCK_TOKENS_CSS, MOCK_TOKENS_DOC));

    const result = await addToken('/project', {
      tokenName: '--testbrowser-canvas-bg',
      value: '#000',
      category: 'Colors — Canvas',
      mode: 'static',
      variant: '[data-private]',
    });

    expect(result.cssAdded).toBe(true);
    expect(findTokensCssWrite()).toContain(':root[data-private] {');
  });

  it('produces a declaration token coverage still recognises', async () => {
    mockReadText.mockImplementation(makeReadTextImpl(MOCK_TOKENS_CSS, MOCK_TOKENS_DOC));

    await addToken('/project', {
      tokenName: '--testbrowser-canvas-bg',
      value: '#101010',
      category: 'Colors — Canvas',
      mode: 'static',
      variant: '[data-skin=precision]',
    });

    const css = findTokensCssWrite();
    const declared = css
      .split('\n')
      .map((line) => TOKEN_DECL_REGEX.exec(line)?.[1])
      .filter((name): name is string => name !== undefined);
    expect(declared).toContain('--testbrowser-canvas-bg');
  });

  it('rejects an invalid --variant selector', async () => {
    mockReadText.mockImplementation(makeReadTextImpl(MOCK_TOKENS_CSS, MOCK_TOKENS_DOC));

    await expect(
      addToken('/project', {
        tokenName: '--testbrowser-canvas-bg',
        value: '#101010',
        category: 'Colors — Canvas',
        mode: 'static',
        variant: '.not-an-attr',
      })
    ).rejects.toThrow(/--variant/);
  });

  it('rejects combining --variant with --mode override', async () => {
    mockReadText.mockImplementation(makeReadTextImpl(MOCK_TOKENS_CSS, MOCK_TOKENS_DOC));

    await expect(
      addToken('/project', {
        tokenName: '--testbrowser-canvas-bg',
        value: '#101010',
        category: 'Colors — Canvas',
        mode: 'override',
        darkValue: '#000',
        variant: '[data-skin=precision]',
      })
    ).rejects.toThrow(/Cannot combine --variant with --mode override/);
  });
});

describe('addToken missing-category bypasses (FORGE G3)', () => {
  it('a TOC comment merely mentioning the category no longer satisfies the banner lookup', async () => {
    // Bypass 1 of the 2026-07-30 silent-no-op incident: a `/* ====`-opened
    // comment containing "Colors — Terminal" as a substring satisfied the
    // loose lookup even though no such section exists.
    const cssWithToc =
      ':root {\n' +
      '  /* ================================================================\n' +
      '   * Planned: Colors — Terminal (not yet sectioned)\n' +
      '   * ================================================================ */\n' +
      '  --testbrowser-space-small: 4px; /* static, fork-specific */\n' +
      '}\n';
    mockReadText.mockImplementation(makeReadTextImpl(cssWithToc, MOCK_TOKENS_DOC));

    await expect(
      addToken('/project', {
        tokenName: '--testbrowser-terminal-bg',
        value: 'var(--background-color-box)',
        category: 'Colors — Terminal',
        mode: 'auto',
      })
    ).rejects.toThrow(/Category "Colors — Terminal" not found/);

    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it('a category name no longer matches a longer banner by substring', async () => {
    // Bypass 1b: `--category "Colors"` used to match the "Colors — Canvas"
    // banner and write the token into the wrong section.
    mockReadText.mockImplementation(makeReadTextImpl(MOCK_TOKENS_CSS, MOCK_TOKENS_DOC));

    await expect(
      addToken('/project', {
        tokenName: '--testbrowser-colors-x',
        value: '#123',
        category: 'Colors',
        mode: 'static',
      })
    ).rejects.toThrow(/Category "Colors" not found/);

    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it('--variant validates --category instead of silently discarding it', async () => {
    // Bypass 2: variant mode skipped the category system entirely, so the
    // required --category flag was accepted and ignored.
    mockReadText.mockImplementation(makeReadTextImpl(MOCK_TOKENS_CSS, MOCK_TOKENS_DOC));

    await expect(
      addToken('/project', {
        tokenName: '--testbrowser-canvas-bg',
        value: '#101010',
        category: 'Colors — Terminal',
        mode: 'static',
        variant: '[data-skin=precision]',
      })
    ).rejects.toThrow(/Category "Colors — Terminal" not found/);
  });

  it('rejects combining --variant with --create-category', async () => {
    mockReadText.mockImplementation(makeReadTextImpl(MOCK_TOKENS_CSS, MOCK_TOKENS_DOC));

    await expect(
      addToken('/project', {
        tokenName: '--testbrowser-canvas-bg',
        value: '#101010',
        category: 'Colors — Terminal',
        mode: 'static',
        variant: '[data-skin=precision]',
        createCategory: true,
      })
    ).rejects.toThrow(/--create-category cannot be combined with --variant/);
  });

  it('a token already declared in a DIFFERENT category refuses instead of skipping', async () => {
    // Bypass 3: the whole-file idempotency check returned skipped:true
    // (exit 0) and silently discarded --create-category when the token
    // name existed anywhere — including another category's section.
    mockReadText.mockImplementation(makeReadTextImpl(MOCK_TOKENS_CSS, MOCK_TOKENS_DOC));

    await expect(
      addToken('/project', {
        tokenName: '--testbrowser-space-small',
        value: '8px',
        category: 'Colors — Canvas',
        mode: 'static',
      })
    ).rejects.toThrow(/already declared outside category "Colors — Canvas"/);

    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it('a token already in the requested category still skips, naming its location', async () => {
    mockReadText.mockImplementation(makeReadTextImpl(MOCK_TOKENS_CSS, MOCK_TOKENS_DOC));

    const result = await addToken('/project', {
      tokenName: '--testbrowser-canvas-bg',
      value: 'var(--background-color-box)',
      category: 'Colors — Canvas',
      mode: 'auto',
    });

    expect(result.skipped).toBe(true);
    expect(result.skippedExisting).toMatchObject({ category: 'Colors — Canvas' });
    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it('dry-run agrees with the real run on the elsewhere-declared refusal', async () => {
    mockReadText.mockImplementation(makeReadTextImpl(MOCK_TOKENS_CSS, MOCK_TOKENS_DOC));

    await expect(
      addToken('/project', {
        tokenName: '--testbrowser-space-small',
        value: '8px',
        category: 'Colors — Canvas',
        mode: 'static',
        dryRun: true,
      })
    ).rejects.toThrow(/already declared outside category "Colors — Canvas"/);
  });
});

describe('addToken --create-category', () => {
  it('rejects a missing category without the flag and advertises --create-category', async () => {
    mockReadText.mockImplementation(makeReadTextImpl(MOCK_TOKENS_CSS, MOCK_TOKENS_DOC));

    await expect(
      addToken('/project', {
        tokenName: '--testbrowser-shadow-low',
        value: '0 1px 2px #000',
        category: 'Shadows',
        mode: 'static',
      })
    ).rejects.toThrow(/--create-category/);

    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it('declares the banner inside :root and inserts the token under it in one write', async () => {
    mockReadText.mockImplementation(makeReadTextImpl(MOCK_TOKENS_CSS, MOCK_TOKENS_DOC));

    const result = await addToken('/project', {
      tokenName: '--testbrowser-shadow-low',
      value: '0 1px 2px #000',
      category: 'Shadows',
      mode: 'static',
      createCategory: true,
    });

    expect(result.cssAdded).toBe(true);
    expect(result.categoryCreated).toBe(true);

    const cssCalls = mockWriteText.mock.calls.filter((c) =>
      c[0].includes('testbrowser-tokens.css')
    );
    // Exactly one CSS write — banner + token land in the same edit.
    expect(cssCalls).toHaveLength(1);
    const cssContent = cssCalls[0]?.[1] ?? '';

    const bannerIdx = cssContent.indexOf('/* = Shadows = */');
    const tokenIdx = cssContent.indexOf('--testbrowser-shadow-low: 0 1px 2px #000;');
    const rootCloseIdx = cssContent.indexOf('\n}');
    expect(bannerIdx).toBeGreaterThan(cssContent.indexOf('Spacing'));
    expect(tokenIdx).toBeGreaterThan(bannerIdx);
    expect(tokenIdx).toBeLessThan(rootCloseIdx);
  });

  it('round-trips: a category created by one add is found by the next add', async () => {
    mockReadText.mockImplementation(makeReadTextImpl(MOCK_TOKENS_CSS, MOCK_TOKENS_DOC));

    await addToken('/project', {
      tokenName: '--testbrowser-shadow-low',
      value: '0 1px 2px #000',
      category: 'Shadows',
      mode: 'static',
      createCategory: true,
    });

    const firstWrite =
      mockWriteText.mock.calls.find((c) => c[0].includes('testbrowser-tokens.css'))?.[1] ?? '';
    mockWriteText.mockClear();
    mockReadText.mockImplementation(makeReadTextImpl(firstWrite, MOCK_TOKENS_DOC));

    const second = await addToken('/project', {
      tokenName: '--testbrowser-shadow-high',
      value: '0 4px 8px #000',
      category: 'Shadows',
      mode: 'static',
    });

    expect(second.cssAdded).toBe(true);
    const secondWrite =
      mockWriteText.mock.calls.find((c) => c[0].includes('testbrowser-tokens.css'))?.[1] ?? '';
    // No duplicate banner; new token sits in the existing section.
    expect(secondWrite.match(/\/\* = Shadows = \*\//g)).toHaveLength(1);
    const bannerIdx = secondWrite.indexOf('/* = Shadows = */');
    expect(secondWrite.indexOf('--testbrowser-shadow-high')).toBeGreaterThan(bannerIdx);
  });

  it('does not declare a duplicate banner when the category already exists', async () => {
    mockReadText.mockImplementation(makeReadTextImpl(MOCK_TOKENS_CSS, MOCK_TOKENS_DOC));

    const result = await addToken('/project', {
      tokenName: '--testbrowser-space-large',
      value: '16px',
      category: 'Spacing',
      mode: 'static',
      createCategory: true,
    });

    expect(result.cssAdded).toBe(true);
    expect(result.categoryCreated).toBe(false);
    const cssContent =
      mockWriteText.mock.calls.find((c) => c[0].includes('testbrowser-tokens.css'))?.[1] ?? '';
    expect(cssContent.match(/= Spacing/g)).toHaveLength(1);
  });

  it('dry-run with --create-category validates without writing', async () => {
    mockReadText.mockImplementation(makeReadTextImpl(MOCK_TOKENS_CSS, MOCK_TOKENS_DOC));

    const result = await addToken('/project', {
      tokenName: '--testbrowser-shadow-low',
      value: '0 1px 2px #000',
      category: 'Shadows',
      mode: 'static',
      createCategory: true,
      dryRun: true,
    });

    expect(result.cssAdded).toBe(true);
    expect(result.skipped).toBe(false);
    expect(mockWriteText).not.toHaveBeenCalled();
  });
});
