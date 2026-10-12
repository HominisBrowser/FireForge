// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFsMock } from '../../test-utils/module-mocks.js';
import type { FireForgeConfig, PatchLintTokenScale } from '../../types/config.js';
import { pathExists, readText } from '../../utils/fs.js';
import { loadFurnaceConfig } from '../furnace-config.js';
import { lintPatchedCss } from '../patch-lint-css.js';
import { findOffScaleAtom, lintTokenScales } from '../patch-lint-token-scale.js';

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
