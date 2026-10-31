// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFsMock } from '../../test-utils/module-mocks.js';
import type { FireForgeConfig, PatchLintTokenScale } from '../../types/config.js';
import { pathExists, readText } from '../../utils/fs.js';
import { loadFurnaceConfig } from '../furnace-config.js';
import { lintPatchedCss } from '../patch-lint-css.js';
import {
  findOffScaleAtom,
  lintTokenScaleFloors,
  lintTokenScales,
} from '../patch-lint-token-scale.js';

vi.mock('../../utils/fs.js', () => createFsMock());
vi.mock('../furnace-config.js', () => ({ loadFurnaceConfig: vi.fn() }));

const spacing: PatchLintTokenScale = {
  properties: ['gap', 'padding*', 'margin*'],
  prefix: '--tb-space-',
  allowLiterals: ['0', 'auto', '*%', '1px'],
  allow: ['--tb-page-padding', '--moz-*'],
};

describe('findOffScaleAtom', () => {
  it.each([
    ['var(--tb-space-8)', undefined],
    ['0 auto', undefined],
    ['50%', undefined],
    ['inherit', undefined],
    ['var(--tb-page-padding)', undefined],
    ['var(--moz-button-padding)', undefined],
    ['calc(var(--tb-space-8) - 1px)', undefined],
    ['var(--tb-gap-hook, var(--tb-space-4))', 'var(--tb-gap-hook)'],
    ['var(--tb-space-hook, var(--tb-space-4))', undefined],
    ['var(--tb-space-8) !important', undefined],
    ['7px', '7px'],
    ['10px 14px', '10px'],
    ['var(--tb-space-8, 8px)', '8px'],
    ['calc(var(--tb-space-8) + 9px)', '9px'],
    ['calc(var(--tb-space-8) * 2)', '2'],
    ['var(--other-space)', 'var(--other-space)'],
  ])('%s → %s', (value, expected) => {
    expect(findOffScaleAtom(value, spacing)).toBe(expected);
  });
});

describe('lintTokenScales', () => {
  it('flags off-scale declarations with their line, skipping comments, waivers and other properties', () => {
    const css = [
      '/* gap: 3px in a comment */',
      '.a {',
      '  gap: var(--tb-space-4);',
      '  padding-inline: 6px;',
      '  margin: 2px; /* fireforge-ignore: token-scale */',
      '  color: red;',
      '  --tb-local-gap: 5px;',
      '}',
      '@media (min-width: 600px) { .b { margin-top: 3px } }',
    ].join('\n');

    const issues = lintTokenScales('browser/themes/a.css', css, [spacing]);

    expect(issues.map((issue) => issue.message.split(' is off')[0])).toEqual([
      'Line 4: padding-inline: 6px',
      'Line 9: margin-top: 3px',
    ]);
    expect(issues[0]).toMatchObject({ check: 'token-scale', severity: 'error' });
    expect(issues[0]?.message).toContain('the --tb-space-* scale ("6px")');
    expect(lintTokenScales('a.css', css, [])).toEqual([]);
  });
});

describe('lintPatchedCss token scales', () => {
  const config = {
    name: 'TestBrowser',
    vendor: 'Test',
    appId: 'org.test.browser',
    binaryName: 'testbrowser',
    firefox: { version: '140.9.0esr', product: 'firefox-esr' },
    patchLint: { tokenScales: [spacing] },
  } as FireForgeConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadFurnaceConfig).mockRejectedValue(new Error('no config'));
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readText).mockResolvedValue('.a {\n  gap: 7px;\n}\n');
  });

  it('applies to CSS the patch creates, not to CSS it modifies', async () => {
    const created =
      'diff --git a/new.css b/new.css\nnew file mode 100644\n--- /dev/null\n+++ b/new.css\n' +
      '@@ -0,0 +1,3 @@\n+.a {\n+  gap: 7px;\n+}\n';
    const modified =
      'diff --git a/old.css b/old.css\n--- a/old.css\n+++ b/old.css\n' +
      '@@ -1,2 +1,3 @@\n .a {\n+  gap: 7px;\n }\n';

    const onCreated = await lintPatchedCss('/engine', ['new.css'], created, config);
    const onModified = await lintPatchedCss('/engine', ['old.css'], modified, config);

    expect(onCreated.map((issue) => issue.check)).toEqual(['token-scale']);
    expect(onModified.filter((issue) => issue.check === 'token-scale')).toEqual([]);
  });
});

describe('token scale extensions', () => {
  const tight: PatchLintTokenScale = {
    properties: ['gap', 'padding*', 'margin*'],
    prefix: ['--tb-space-', '--tb-gap-'],
    allowLiterals: ['0'],
    allowInCalc: ['2', '0.5'],
    offsetCap: 2,
  };

  it.each([
    ['var(--tb-gap-4)', undefined],
    ['calc(var(--tb-space-4) * 2)', undefined],
    ['2', '2'],
    ['calc(var(--tb-space-4) - 1px)', undefined],
    ['calc(var(--tb-space-4) - 1px - 1px)', undefined],
    ['calc(var(--tb-space-4) - 1px - 2px)', '2px'],
    ['calc(var(--tb-space-4) - 3px)', '3px'],
    ['calc(var(--tb-space-4) + 1px)', '1px'],
    ['calc(1px - var(--tb-space-4))', '1px'],
    ['calc(var(--tb-space-4)/2)', undefined],
    ['1px', '1px'],
  ])('%s → %s', (value, expected) => {
    expect(findOffScaleAtom(value, tight)).toBe(expected);
  });

  it('names every prefix of a listed scale in its message', () => {
    const [issue] = lintTokenScales('a.css', '.a { gap: 7px; }', [tight]);
    expect(issue?.message).toContain('off the --tb-space-* / --tb-gap-* scale');
  });

  it('skips descriptors inside descriptor at-rules, nested blocks included', () => {
    const typeScale: PatchLintTokenScale = {
      properties: ['font-weight', 'margin*'],
      prefix: '--tb-type-',
    };
    const css = [
      '@font-face {',
      '  font-family: X;',
      '  font-weight: 400;',
      '}',
      '@page { margin: 1in; @top-left { margin: 2px; } }',
      '.a { font-weight: 700; }',
    ].join('\n');
    const issues = lintTokenScales('a.css', css, [typeScale]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/^Line 6: font-weight: 700/);
  });

  it('does not judge a file a scale excludes', () => {
    const scale: PatchLintTokenScale = { ...spacing, exclude: ['**/vendor/*.css'] };
    expect(lintTokenScales('browser/vendor/tw.css', '.a { gap: 7px; }', [scale])).toEqual([]);
    expect(lintTokenScales('browser/own.css', '.a { gap: 7px; }', [scale])).toHaveLength(1);
  });

  it('accepts an allowValues declaration in every file the scale governs', () => {
    const scale: PatchLintTokenScale = {
      ...spacing,
      allowValues: [
        { property: 'margin-inline-start', value: '-3px  7px', reason: 'Docked bar offset' },
      ],
    };
    const css = [
      '.bar {',
      '  margin-inline-start: -3px\n    7px;',
      '  margin-inline-end: -3px 7px;',
      '  margin-inline-start: -3px 8px;',
      '}',
    ].join('\n');
    for (const file of ['browser/bar.css', 'browser/seam.css']) {
      const issues = lintTokenScales(file, css, [scale]);
      expect(issues.map((issue) => issue.message.split(' is off')[0])).toEqual([
        'Line 4: margin-inline-end: -3px 7px',
        'Line 5: margin-inline-start: -3px 8px',
      ]);
    }
  });

  it('fails a scale whose created stylesheets fall under minFiles', () => {
    const scale: PatchLintTokenScale = { ...spacing, minFiles: 2, exclude: ['skip/**'] };
    const files: [string, string][] = [
      ['a.css', '.a { gap: var(--tb-space-1); }'],
      ['skip/b.css', '.b { gap: var(--tb-space-1); }'],
      ['c.css', '.c { color: red; }'],
      ['d.js', 'gap: 1'],
    ];
    const issues = lintTokenScaleFloors(files, [scale, spacing]);
    expect(issues).toEqual([
      expect.objectContaining({ check: 'token-scale-vacuous', severity: 'error' }),
    ]);
    expect(issues[0]?.message).toContain(
      'governs 1 patch-created stylesheet(s), under its minFiles 2'
    );
    expect(lintTokenScaleFloors([...files, ['e.css', '.e { padding: 0 }']], [scale])).toEqual([]);
  });
});
