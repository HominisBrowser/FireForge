// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  countNonBinaryDiffLines,
  detectNewFilesInDiff,
  isTestFile,
  lintExportedPatch,
  lintModificationComments,
  lintModifiedFileHeaders,
  lintNewFileHeaders,
  lintPatchedCss,
  lintPatchedJs,
  lintPatchSize,
  resolvePatchSizeTier,
} from '../patch-lint.js';

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
  readText: vi.fn(),
}));

vi.mock('../furnace-config.js', () => ({
  loadFurnaceConfig: vi.fn(),
}));

import type { FireForgeConfig } from '../../types/config.js';
import { pathExists, readText } from '../../utils/fs.js';
import { loadFurnaceConfig } from '../furnace-config.js';

const mockPathExists = vi.mocked(pathExists);
const mockReadText = vi.mocked(readText);
const mockLoadFurnaceConfig = vi.mocked(loadFurnaceConfig);

const mockConfig: FireForgeConfig = {
  name: 'TestBrowser',
  vendor: 'Test',
  appId: 'org.test.browser',
  binaryName: 'testbrowser',
  firefox: { version: '140.9.0esr', product: 'firefox-esr' },
  license: 'MPL-2.0',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadFurnaceConfig.mockRejectedValue(new Error('no config'));
});

describe('lintPatchedCss', () => {
  it('returns empty for non-CSS files', async () => {
    const issues = await lintPatchedCss('/engine', ['foo.js', 'bar.mjs']);

    expect(issues).toEqual([]);
  });

  it('detects raw CSS color values', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('body { color: #ff0000; }');

    const issues = await lintPatchedCss('/engine', ['style.css']);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe('raw-color-value');
    expect(issues[0]?.severity).toBe('error');
  });

  it('detects introduced raw CSS color values from added diff lines', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('body { color: var(--brand-color); }\n.new { color: #ff0000; }');

    const diff =
      'diff --git a/style.css b/style.css\n' +
      '--- a/style.css\n' +
      '+++ b/style.css\n' +
      '@@ -1 +1,2 @@\n' +
      ' body { color: var(--brand-color); }\n' +
      '+.new { color: #ff0000; }\n';

    const issues = await lintPatchedCss('/engine', ['style.css'], diff);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe('raw-color-value');
    expect(issues[0]?.severity).toBe('error');
  });

  it('does not flag pre-existing raw CSS colors outside added diff lines', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('body { color: #ff0000; }\n.new { color: var(--brand-color); }');

    const diff =
      'diff --git a/style.css b/style.css\n' +
      '--- a/style.css\n' +
      '+++ b/style.css\n' +
      '@@ -1 +1,2 @@\n' +
      ' body { color: #ff0000; }\n' +
      '+.new { color: var(--brand-color); }\n';

    const issues = await lintPatchedCss('/engine', ['style.css'], diff);

    expect(issues.filter((i) => i.check === 'raw-color-value')).toHaveLength(0);
  });

  it('skips files that do not exist', async () => {
    mockPathExists.mockResolvedValue(false);

    const issues = await lintPatchedCss('/engine', ['missing.css']);

    expect(issues).toEqual([]);
  });

  it('strips block comments before scanning', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('/* color: #ff0000; */ body { display: block; }');

    const issues = await lintPatchedCss('/engine', ['style.css']);

    expect(issues).toEqual([]);
  });

  it('checks token prefix violations when config is available', async () => {
    mockLoadFurnaceConfig.mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      tokenPrefix: '--brand-',
      tokenAllowlist: [],
      stock: [],
      overrides: {},
      custom: {},
    });
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('body { color: var(--foreign-color); }');

    const issues = await lintPatchedCss('/engine', ['style.css']);

    expect(issues.some((i) => i.check === 'token-prefix-violation')).toBe(true);
    expect(issues.find((i) => i.check === 'token-prefix-violation')?.severity).toBe('error');
  });

  it('allows tokens matching the prefix', async () => {
    mockLoadFurnaceConfig.mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      tokenPrefix: '--brand-',
      tokenAllowlist: [],
      stock: [],
      overrides: {},
      custom: {},
    });
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('body { color: var(--brand-accent); }');

    const issues = await lintPatchedCss('/engine', ['style.css']);

    expect(issues.filter((i) => i.check === 'token-prefix-violation')).toHaveLength(0);
  });

  it('allows tokens on the allowlist', async () => {
    mockLoadFurnaceConfig.mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      tokenPrefix: '--brand-',
      tokenAllowlist: ['--foreign-color'],
      stock: [],
      overrides: {},
      custom: {},
    });
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('body { color: var(--foreign-color); }');

    const issues = await lintPatchedCss('/engine', ['style.css']);

    expect(issues.filter((i) => i.check === 'token-prefix-violation')).toHaveLength(0);
  });

  it('allows runtime variables listed in furnace.json runtimeVariables', async () => {
    mockLoadFurnaceConfig.mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      tokenPrefix: '--brand-',
      tokenAllowlist: [],
      runtimeVariables: ['--cam-x'],
      stock: [],
      overrides: {},
      custom: {},
    });
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('body { transform: translateX(var(--cam-x)); }');

    const issues = await lintPatchedCss('/engine', ['style.css']);

    expect(issues.filter((i) => i.check === 'token-prefix-violation')).toHaveLength(0);
  });

  it('auto-exempts variables declared and consumed in the same CSS file', async () => {
    mockLoadFurnaceConfig.mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      tokenPrefix: '--brand-',
      tokenAllowlist: [],
      stock: [],
      overrides: {},
      custom: {},
    });
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('body { --tile-z: 0; transform: translateZ(var(--tile-z)); }');

    const issues = await lintPatchedCss('/engine', ['style.css']);

    expect(issues.filter((i) => i.check === 'token-prefix-violation')).toHaveLength(0);
  });

  it('does not flag pre-existing stock vars outside added diff lines (Finding #10)', async () => {
    // Regression guard: a Furnace override of a stock component (e.g.
    // moz-card) carries the upstream file's full `var(--moz-card-*)`
    // vocabulary. The rule used to scan the whole file and flag every
    // inherited reference as a prefix violation against the fork's
    // tokenPrefix — effectively making any CSS-only override unable to
    // pass lint. With diff context available, the scan is scoped to
    // added lines only.
    mockLoadFurnaceConfig.mockResolvedValue({
      version: 1,
      componentPrefix: 'ff-',
      tokenPrefix: '--ff-',
      tokenAllowlist: [],
      stock: [],
      overrides: {},
      custom: {},
    });
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(
      '.moz-card {\n  padding: var(--moz-card-padding);\n  border-radius: var(--moz-card-border-radius);\n  color: var(--ff-text-color);\n}\n'
    );

    const diff =
      'diff --git a/moz-card.css b/moz-card.css\n' +
      '--- a/moz-card.css\n' +
      '+++ b/moz-card.css\n' +
      '@@ -1,3 +1,4 @@\n' +
      ' .moz-card {\n' +
      '   padding: var(--moz-card-padding);\n' +
      '   border-radius: var(--moz-card-border-radius);\n' +
      '+  color: var(--ff-text-color);\n' +
      ' }\n';

    const issues = await lintPatchedCss('/engine', ['moz-card.css'], diff);

    // Stock inherited vars on unchanged lines should NOT be flagged. The
    // only introduced var (--ff-text-color) matches the tokenPrefix so
    // no violations should fire.
    expect(issues.filter((i) => i.check === 'token-prefix-violation')).toHaveLength(0);
  });

  it('still flags newly-introduced prefix-violating vars on added lines', async () => {
    // Companion to the previous test — make sure the scoping doesn't
    // silently hide genuine introductions.
    mockLoadFurnaceConfig.mockResolvedValue({
      version: 1,
      componentPrefix: 'ff-',
      tokenPrefix: '--ff-',
      tokenAllowlist: [],
      stock: [],
      overrides: {},
      custom: {},
    });
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(
      '.moz-card {\n  padding: var(--moz-card-padding);\n  color: var(--stolen-accent);\n}\n'
    );

    const diff =
      'diff --git a/moz-card.css b/moz-card.css\n' +
      '--- a/moz-card.css\n' +
      '+++ b/moz-card.css\n' +
      '@@ -1,2 +1,3 @@\n' +
      ' .moz-card {\n' +
      '   padding: var(--moz-card-padding);\n' +
      '+  color: var(--stolen-accent);\n' +
      ' }\n';

    const issues = await lintPatchedCss('/engine', ['moz-card.css'], diff);

    const prefixIssues = issues.filter((i) => i.check === 'token-prefix-violation');
    expect(prefixIssues).toHaveLength(1);
    expect(prefixIssues[0]?.message).toContain('--stolen-accent');
  });

  it('handles multiple CSS files', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('body { color: #abc; }');

    const issues = await lintPatchedCss('/engine', ['a.css', 'b.css', 'c.js']);

    expect(issues).toHaveLength(2);
  });

  it('skips raw-color-value for files on rawColorAllowlist (exact path)', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(':root { --brand-primary: #ff0000; }');

    const configWithAllowlist = {
      ...mockConfig,
      patchLint: { rawColorAllowlist: ['themes/tokens.css'] },
    };
    const issues = await lintPatchedCss(
      '/engine',
      ['themes/tokens.css'],
      undefined,
      configWithAllowlist
    );

    expect(issues.filter((i) => i.check === 'raw-color-value')).toHaveLength(0);
  });

  it('skips raw-color-value for files on rawColorAllowlist (basename match)', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(':root { --brand-primary: #ff0000; }');

    const configWithAllowlist = {
      ...mockConfig,
      patchLint: { rawColorAllowlist: ['tokens.css'] },
    };
    const issues = await lintPatchedCss(
      '/engine',
      ['themes/tokens.css'],
      undefined,
      configWithAllowlist
    );

    expect(issues.filter((i) => i.check === 'raw-color-value')).toHaveLength(0);
  });

  it('auto-exempts browser/branding/ CSS from raw-color-value', async () => {
    // Eval regression: setup-generated branding copied from `unofficial/`
    // keeps hex literals (about dialog, installer pages, branded chrome).
    // Without this auto-exemption, every first-time fresh project's
    // `fireforge lint` failed with `raw-color-value` on files the operator
    // did not author and cannot migrate without rewriting the copied
    // upstream assets.
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(':root { --bg: #2a2a2a; color: #ffffff; }');

    const issues = await lintPatchedCss('/engine', [
      'browser/branding/mybrowser/content/aboutDialog.css',
    ]);

    expect(issues.filter((i) => i.check === 'raw-color-value')).toHaveLength(0);
  });

  it('rawColorAllowlist works when furnace config loads successfully', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(':root { --brand: #ff0000; }');
    mockLoadFurnaceConfig.mockResolvedValue({
      version: 1 as const,
      componentPrefix: 'moz-',
      tokenPrefix: 'ff',
      stock: [],
      overrides: {},
      custom: {},
    });

    const configWithAllowlist = {
      ...mockConfig,
      patchLint: { rawColorAllowlist: ['tokens.css'] },
    };
    const issues = await lintPatchedCss('/engine', ['tokens.css'], undefined, configWithAllowlist);

    expect(issues.filter((i) => i.check === 'raw-color-value')).toHaveLength(0);
  });

  it('still flags raw-color-value for files not on rawColorAllowlist', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('body { color: #ff0000; }');

    const configWithAllowlist = {
      ...mockConfig,
      patchLint: { rawColorAllowlist: ['tokens.css'] },
    };
    const issues = await lintPatchedCss('/engine', ['style.css'], undefined, configWithAllowlist);

    expect(issues.filter((i) => i.check === 'raw-color-value')).toHaveLength(1);
  });

  it('suppresses raw-color-value with inline fireforge-ignore comment', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(
      ':root {\n' +
        '  --brand-primary: #ff0000; /* fireforge-ignore: raw-color-value */\n' +
        '  --brand-bg: #333; /* fireforge-ignore: raw-color-value */\n' +
        '}'
    );

    const issues = await lintPatchedCss('/engine', ['tokens.css']);

    expect(issues.filter((i) => i.check === 'raw-color-value')).toHaveLength(0);
  });

  it('flags raw-color-value on lines without inline suppression', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(
      ':root {\n' +
        '  --brand-primary: #ff0000; /* fireforge-ignore: raw-color-value */\n' +
        '  color: #333;\n' +
        '}'
    );

    const issues = await lintPatchedCss('/engine', ['style.css']);

    expect(issues.filter((i) => i.check === 'raw-color-value')).toHaveLength(1);
  });
});

describe('detectNewFilesInDiff', () => {
  it('detects new files from diff', () => {
    const diff =
      'diff --git a/foo.js b/foo.js\nnew file mode 100644\n--- /dev/null\n+++ b/foo.js\n' +
      'diff --git a/bar.js b/bar.js\n--- a/bar.js\n+++ b/bar.js\n';
    const newFiles = detectNewFilesInDiff(diff);

    expect(newFiles.has('foo.js')).toBe(true);
    expect(newFiles.has('bar.js')).toBe(false);
  });

  it('returns empty set for diffs with no new files', () => {
    const diff =
      'diff --git a/bar.js b/bar.js\n--- a/bar.js\n+++ b/bar.js\n@@ -1 +1 @@\n-old\n+new\n';
    const newFiles = detectNewFilesInDiff(diff);

    expect(newFiles.size).toBe(0);
  });
});

describe('lintNewFileHeaders', () => {
  it('flags new files missing license headers', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('const x = 1;\n');

    const issues = await lintNewFileHeaders('/engine', ['new-module.js'], mockConfig);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe('missing-license-header');
    expect(issues[0]?.severity).toBe('error');
  });

  it('passes files with correct license header', async () => {
    mockPathExists.mockResolvedValue(true);
    const header =
      '// This Source Code Form is subject to the terms of the Mozilla Public\n' +
      '// License, v. 2.0. If a copy of the MPL was not distributed with this\n' +
      '// file, You can obtain one at http://mozilla.org/MPL/2.0/.\n' +
      'const x = 1;\n';
    mockReadText.mockResolvedValue(header);

    const issues = await lintNewFileHeaders('/engine', ['new-module.js'], mockConfig);

    expect(issues).toHaveLength(0);
  });

  it('skips files with unknown extensions', async () => {
    const issues = await lintNewFileHeaders('/engine', ['data.json'], mockConfig);

    expect(issues).toHaveLength(0);
    expect(mockPathExists).not.toHaveBeenCalled();
  });

  it('checks CSS files with CSS comment style', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('.foo { display: block; }');

    const issues = await lintNewFileHeaders('/engine', ['style.css'], mockConfig);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe('missing-license-header');
  });

  it('auto-exempts browser/branding/ when any recognised license header is present', async () => {
    // Eval regression: copied branding files under browser/branding/
    // carry Mozilla's MPL-2.0 header (legitimate — the assets are
    // Mozilla's). A fork with a different project license (0BSD / EUPL-1.2
    // / GPL-2.0-or-later) previously failed `missing-license-header` on
    // these files and had no actionable fix short of rewriting the copied
    // upstream headers (misrepresenting authorship).
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(
      `/* This Source Code Form is subject to the terms of the Mozilla Public\n` +
        ` * License, v. 2.0. If a copy of the MPL was not distributed with this\n` +
        ` * file, You can obtain one at http://mozilla.org/MPL/2.0/. */\n` +
        `.brand { color: #ffffff; }\n`
    );

    const euplConfig = { ...mockConfig, license: 'EUPL-1.2' as const };
    const issues = await lintNewFileHeaders(
      '/engine',
      ['browser/branding/mybrowser/content/aboutDialog.css'],
      euplConfig
    );
    expect(issues.filter((i) => i.check === 'missing-license-header')).toHaveLength(0);
  });

  it('still flags browser/branding/ files that have NO recognised license header', async () => {
    // Guard: the branding carve-out should not be a blanket suppression.
    // A truly unlicensed file under browser/branding/ (no MPL/SPDX marker
    // at all) still needs a header — operators who hand-add a new branding
    // file should be prompted to stamp it.
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('.brand { color: #ffffff; }\n');

    const issues = await lintNewFileHeaders(
      '/engine',
      ['browser/branding/mybrowser/content/aboutDialog.css'],
      mockConfig
    );
    expect(issues.some((i) => i.check === 'missing-license-header')).toBe(true);
  });

  it('accepts the verbatim upstream MPL block header on a new JS file regardless of project license', async () => {
    // Recorded 2026-07-04 in the consumer FORGE.md: the MPL block-header
    // carve-out was gated on `license === 'MPL-2.0'`, making it dead code
    // for an EUPL-1.2 project — a file legitimately copied from upstream
    // Firefox (verbatim Mozilla header, anywhere in the tree, not just
    // browser/branding/) had no sanctioned path.
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(
      `/* This Source Code Form is subject to the terms of the Mozilla Public\n` +
        ` * License, v. 2.0. If a copy of the MPL was not distributed with this\n` +
        ` * file, You can obtain one at http://mozilla.org/MPL/2.0/. */\n` +
        `export const UPSTREAM = true;\n`
    );

    const euplConfig = { ...mockConfig, license: 'EUPL-1.2' as const };
    const issues = await lintNewFileHeaders(
      '/engine',
      ['browser/base/content/upstream-derived.js'],
      euplConfig
    );
    expect(issues.filter((i) => i.check === 'missing-license-header')).toHaveLength(0);
  });

  it('accepts the older upstream MPL wrap (break after "file,") on a new JS file', async () => {
    // Field verification 2026-07: upstream files like ext-browser.js carry
    // the older Mozilla wrap that breaks after "file," instead of "with
    // this". Same wording, different line-break position — must not fire
    // "missing EUPL-1.2 license header".
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(
      `/* This Source Code Form is subject to the terms of the Mozilla Public\n` +
        ` * License, v. 2.0. If a copy of the MPL was not distributed with this file,\n` +
        ` * You can obtain one at http://mozilla.org/MPL/2.0/. */\n` +
        `export const UPSTREAM = true;\n`
    );

    const euplConfig = { ...mockConfig, license: 'EUPL-1.2' as const };
    const issues = await lintNewFileHeaders(
      '/engine',
      ['browser/components/extensions/parent/ext-browser.js'],
      euplConfig
    );
    expect(issues.filter((i) => i.check === 'missing-license-header')).toHaveLength(0);
  });

  it('accepts the upstream MPL block header behind a leading editor directive', async () => {
    // Mozilla's canonical layout puts `/* -*- Mode: … -*- */` on line 1
    // with the MPL header on lines 2+ — the copied-from-upstream shape
    // must pass with the directive in place.
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(
      `/* -*- Mode: javascript; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */\n` +
        `/* This Source Code Form is subject to the terms of the Mozilla Public\n` +
        ` * License, v. 2.0. If a copy of the MPL was not distributed with this\n` +
        ` * file, You can obtain one at http://mozilla.org/MPL/2.0/. */\n` +
        `export const UPSTREAM = true;\n`
    );

    const euplConfig = { ...mockConfig, license: 'EUPL-1.2' as const };
    const issues = await lintNewFileHeaders('/engine', ['toolkit/copied.mjs'], euplConfig);
    expect(issues.filter((i) => i.check === 'missing-license-header')).toHaveLength(0);
  });

  it('still flags the line-comment MPL form on a non-MPL project (block form only)', async () => {
    // The `// `-style MPL header is what FireForge generates for MPL
    // projects — it is not upstream provenance, so on an EUPL project it
    // stays an error and the operator is prompted for the EUPL header.
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(
      '// This Source Code Form is subject to the terms of the Mozilla Public\n' +
        '// License, v. 2.0. If a copy of the MPL was not distributed with this\n' +
        '// file, You can obtain one at http://mozilla.org/MPL/2.0/.\n' +
        'export const X = 1;\n'
    );

    const euplConfig = { ...mockConfig, license: 'EUPL-1.2' as const };
    const issues = await lintNewFileHeaders('/engine', ['module.js'], euplConfig);
    expect(issues.some((i) => i.check === 'missing-license-header')).toBe(true);
  });

  it('accepts the verbatim upstream MPL block header on a new CSS file regardless of project license', async () => {
    // 0.35.0 residual (field verification, 2026-07-05): the upstream-MPL
    // acceptance covered new JS files only, so a derived CSS file
    // carrying the exact same three-line `/* … */` block header still
    // errored on an EUPL project without a patch-level lintIgnore, while
    // the derived JS on the same patch passed natively. The block form
    // is valid CSS comment syntax, and the header text is identical.
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(
      `/* This Source Code Form is subject to the terms of the Mozilla Public\n` +
        ` * License, v. 2.0. If a copy of the MPL was not distributed with this\n` +
        ` * file, You can obtain one at http://mozilla.org/MPL/2.0/. */\n` +
        `.x { color: red; }\n`
    );

    const euplConfig = { ...mockConfig, license: 'EUPL-1.2' as const };
    const issues = await lintNewFileHeaders('/engine', ['browser/themes/new.css'], euplConfig);
    expect(issues.filter((i) => i.check === 'missing-license-header')).toHaveLength(0);
  });

  it('accepts the older upstream MPL wrap (break after "file,") on a new CSS file', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(
      `/* This Source Code Form is subject to the terms of the Mozilla Public\n` +
        ` * License, v. 2.0. If a copy of the MPL was not distributed with this file,\n` +
        ` * You can obtain one at http://mozilla.org/MPL/2.0/. */\n` +
        `.x { color: red; }\n`
    );

    const euplConfig = { ...mockConfig, license: 'EUPL-1.2' as const };
    const issues = await lintNewFileHeaders('/engine', ['browser/themes/copied.css'], euplConfig);
    expect(issues.filter((i) => i.check === 'missing-license-header')).toHaveLength(0);
  });

  it('still flags near-MPL garbage with altered wording on an EUPL project', async () => {
    // The wrap-agnostic fallback matches on normalized whitespace only —
    // any change to the wording (not just the line breaks) keeps the
    // missing-license-header error.
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(
      `/* This Source Code Form is subject to some of the terms of the Mozilla Public\n` +
        ` * License, v. 2.0. If a copy of the MPL was not distributed with this file,\n` +
        ` * You can obtain one at http://mozilla.org/MPL/2.0/. */\n` +
        `export const X = 1;\n`
    );

    const euplConfig = { ...mockConfig, license: 'EUPL-1.2' as const };
    const issues = await lintNewFileHeaders('/engine', ['browser/base/nearmpl.js'], euplConfig);
    expect(issues.some((i) => i.check === 'missing-license-header')).toBe(true);
  });

  it('accepts the upstream MPL block header on CSS behind a leading editor directive', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(
      `/* vim: set shiftwidth=2 tabstop=2 autoindent expandtab: */\n` +
        `/* This Source Code Form is subject to the terms of the Mozilla Public\n` +
        ` * License, v. 2.0. If a copy of the MPL was not distributed with this\n` +
        ` * file, You can obtain one at http://mozilla.org/MPL/2.0/. */\n` +
        `.x { color: red; }\n`
    );

    const euplConfig = { ...mockConfig, license: 'EUPL-1.2' as const };
    const issues = await lintNewFileHeaders('/engine', ['browser/themes/copied.css'], euplConfig);
    expect(issues.filter((i) => i.check === 'missing-license-header')).toHaveLength(0);
  });

  it('still flags a CSS file with no header on an EUPL project', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('.x { color: red; }\n');

    const euplConfig = { ...mockConfig, license: 'EUPL-1.2' as const };
    const issues = await lintNewFileHeaders('/engine', ['browser/themes/new.css'], euplConfig);
    expect(issues.some((i) => i.check === 'missing-license-header')).toBe(true);
  });

  it('still flags the line-comment MPL form on CSS (block form only)', async () => {
    // `// ` is not even a CSS comment; a file leading with the
    // FireForge-generated line-comment MPL shape gets no carve-out.
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(
      '// This Source Code Form is subject to the terms of the Mozilla Public\n' +
        '// License, v. 2.0. If a copy of the MPL was not distributed with this\n' +
        '// file, You can obtain one at http://mozilla.org/MPL/2.0/.\n' +
        '.x { color: red; }\n'
    );

    const euplConfig = { ...mockConfig, license: 'EUPL-1.2' as const };
    const issues = await lintNewFileHeaders('/engine', ['browser/themes/new.css'], euplConfig);
    expect(issues.some((i) => i.check === 'missing-license-header')).toBe(true);
  });

  it('does not extend the upstream-MPL carve-out to hash-style files (FTL)', async () => {
    // `/* … */` is not a comment in Fluent files — the block header
    // cannot legitimately lead an .ftl file, so hash style keeps
    // requiring the project's own header.
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(
      `/* This Source Code Form is subject to the terms of the Mozilla Public\n` +
        ` * License, v. 2.0. If a copy of the MPL was not distributed with this\n` +
        ` * file, You can obtain one at http://mozilla.org/MPL/2.0/. */\n` +
        `key = Value\n`
    );

    const euplConfig = { ...mockConfig, license: 'EUPL-1.2' as const };
    const issues = await lintNewFileHeaders(
      '/engine',
      ['browser/locales/en-US/browser/new.ftl'],
      euplConfig
    );
    expect(issues.some((i) => i.check === 'missing-license-header')).toBe(true);
  });
});

describe('isTestFile', () => {
  it('matches paths containing /test/', () => {
    expect(isTestFile('browser/base/content/test/general/helper.js')).toBe(true);
  });

  it('matches browser_*.js filenames', () => {
    expect(isTestFile('browser_sidebar.js')).toBe(true);
  });

  it('matches test_*.js filenames', () => {
    expect(isTestFile('test_utils.js')).toBe(true);
  });

  it('matches xpcshell_*.js filenames', () => {
    expect(isTestFile('xpcshell_worker.js')).toBe(true);
  });

  it('does not match regular module files', () => {
    expect(isTestFile('modules/MyModule.sys.mjs')).toBe(false);
  });

  it('does not match non-test content paths', () => {
    expect(isTestFile('browser/content/app.js')).toBe(false);
  });
});

describe('lintPatchedJs', () => {
  it('detects relative imports', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('import { foo } from "./bar.js";\nexport function test() {}\n');

    const issues = await lintPatchedJs('/engine', ['module.mjs'], new Set<string>(), mockConfig);

    expect(issues.some((i) => i.check === 'relative-import')).toBe(true);
    expect(issues.find((i) => i.check === 'relative-import')?.severity).toBe('error');
  });

  it('detects side-effect relative imports', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('import "./side-effect.js";\n');

    const issues = await lintPatchedJs('/engine', ['module.mjs'], new Set<string>(), mockConfig);

    expect(issues.some((i) => i.check === 'relative-import')).toBe(true);
  });

  it('detects dynamic relative imports', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('async function load() {\n  return import("../lazy.js");\n}\n');

    const issues = await lintPatchedJs('/engine', ['module.mjs'], new Set<string>(), mockConfig);

    expect(issues.some((i) => i.check === 'relative-import')).toBe(true);
  });

  it('detects relative re-exports', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('export { foo } from "./foo.js";\n');

    const issues = await lintPatchedJs('/engine', ['module.mjs'], new Set<string>(), mockConfig);

    expect(issues.some((i) => i.check === 'relative-import')).toBe(true);
  });

  it('detects multiline relative imports', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('import {\n  foo,\n  bar,\n} from "./multi.js";\n');

    const issues = await lintPatchedJs('/engine', ['module.mjs'], new Set<string>(), mockConfig);

    expect(issues.some((i) => i.check === 'relative-import')).toBe(true);
  });

  it('does not flag relative import text inside comments', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('// import "./commented.js";\nconst ok = true;\n');

    const issues = await lintPatchedJs('/engine', ['module.js'], new Set<string>(), mockConfig);

    expect(issues.some((i) => i.check === 'relative-import')).toBe(false);
  });

  it('falls back to stripped-text relative import detection when parsing fails', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('return import("./legacy-script.js");\n');

    const issues = await lintPatchedJs('/engine', ['legacy.js'], new Set<string>(), mockConfig);

    expect(issues.some((i) => i.check === 'relative-import')).toBe(true);
  });

  it('detects ChromeUtils.import with relative path', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('ChromeUtils.import("../Foo.sys.mjs");\n');

    const issues = await lintPatchedJs('/engine', ['module.js'], new Set<string>(), mockConfig);

    expect(issues.some((i) => i.check === 'relative-import')).toBe(true);
  });

  it('does not flag new files below the notice threshold', async () => {
    mockPathExists.mockResolvedValue(true);
    const smallFile = Array.from({ length: 400 }, (_, i) => `const x${i} = ${i};`).join('\n');
    mockReadText.mockResolvedValue(smallFile);

    const issues = await lintPatchedJs('/engine', ['small.js'], new Set(['small.js']), mockConfig);

    expect(issues.some((i) => i.check === 'file-too-large')).toBe(false);
  });

  it('emits notice for new files in the notice tier (501–750 lines)', async () => {
    mockPathExists.mockResolvedValue(true);
    const file = Array.from({ length: 550 }, (_, i) => `const x${i} = ${i};`).join('\n');
    mockReadText.mockResolvedValue(file);

    const issues = await lintPatchedJs('/engine', ['mid.js'], new Set(['mid.js']), mockConfig);

    const sizeIssue = issues.find((i) => i.check === 'file-too-large');
    expect(sizeIssue).toBeDefined();
    expect(sizeIssue?.severity).toBe('notice');
  });

  it('emits warning for new files in the warning tier (751–900 lines)', async () => {
    mockPathExists.mockResolvedValue(true);
    const file = Array.from({ length: 800 }, (_, i) => `const x${i} = ${i};`).join('\n');
    mockReadText.mockResolvedValue(file);

    const issues = await lintPatchedJs('/engine', ['big.js'], new Set(['big.js']), mockConfig);

    const sizeIssue = issues.find((i) => i.check === 'file-too-large');
    expect(sizeIssue).toBeDefined();
    expect(sizeIssue?.severity).toBe('warning');
  });

  it('emits error for new files above the error tier (901+ lines)', async () => {
    mockPathExists.mockResolvedValue(true);
    const file = Array.from({ length: 950 }, (_, i) => `const x${i} = ${i};`).join('\n');
    mockReadText.mockResolvedValue(file);

    const issues = await lintPatchedJs('/engine', ['huge.js'], new Set(['huge.js']), mockConfig);

    const sizeIssue = issues.find((i) => i.check === 'file-too-large');
    expect(sizeIssue).toBeDefined();
    expect(sizeIssue?.severity).toBe('error');
  });

  it('uses test-file thresholds for files in /test/ paths', async () => {
    mockPathExists.mockResolvedValue(true);
    const file = Array.from({ length: 1300 }, (_, i) => `const x${i} = ${i};`).join('\n');
    mockReadText.mockResolvedValue(file);

    const issues = await lintPatchedJs(
      '/engine',
      ['browser/base/content/test/general/browser_foo.js'],
      new Set(['browser/base/content/test/general/browser_foo.js']),
      mockConfig
    );

    const sizeIssue = issues.find((i) => i.check === 'file-too-large');
    expect(sizeIssue).toBeDefined();
    expect(sizeIssue?.severity).toBe('notice');
    expect(sizeIssue?.message).toContain('Test file');
  });

  it('emits warning for test files in the warning tier (1401–1600 lines)', async () => {
    mockPathExists.mockResolvedValue(true);
    const file = Array.from({ length: 1500 }, (_, i) => `const x${i} = ${i};`).join('\n');
    mockReadText.mockResolvedValue(file);

    const issues = await lintPatchedJs(
      '/engine',
      ['browser/base/content/test/general/browser_bar.js'],
      new Set(['browser/base/content/test/general/browser_bar.js']),
      mockConfig
    );

    const sizeIssue = issues.find((i) => i.check === 'file-too-large');
    expect(sizeIssue).toBeDefined();
    expect(sizeIssue?.severity).toBe('warning');
    expect(sizeIssue?.message).toContain('splitting');
  });

  it('emits error for test files above 1600 lines', async () => {
    mockPathExists.mockResolvedValue(true);
    const file = Array.from({ length: 1700 }, (_, i) => `const x${i} = ${i};`).join('\n');
    mockReadText.mockResolvedValue(file);

    const issues = await lintPatchedJs(
      '/engine',
      ['test_utils.js'],
      new Set(['test_utils.js']),
      mockConfig
    );

    const sizeIssue = issues.find((i) => i.check === 'file-too-large');
    expect(sizeIssue).toBeDefined();
    expect(sizeIssue?.severity).toBe('error');
  });

  it('does not flag test files below 1200 lines', async () => {
    mockPathExists.mockResolvedValue(true);
    const file = Array.from({ length: 1100 }, (_, i) => `const x${i} = ${i};`).join('\n');
    mockReadText.mockResolvedValue(file);

    const issues = await lintPatchedJs(
      '/engine',
      ['browser/base/content/test/general/browser_baz.js'],
      new Set(['browser/base/content/test/general/browser_baz.js']),
      mockConfig
    );

    expect(issues.some((i) => i.check === 'file-too-large')).toBe(false);
  });

  // ── file-too-large boundary triads (limits are inclusive: strict >) ────

  const makeJsFile = (lines: number): string =>
    Array.from({ length: lines }, (_, i) => `const x${i} = ${i};`).join('\n');

  const fileSizeSeverityAt = async (lines: number, file = 'boundary.js'): Promise<string> => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(makeJsFile(lines));
    const issues = await lintPatchedJs('/engine', [file], new Set([file]), mockConfig);
    return issues.find((i) => i.check === 'file-too-large')?.severity ?? 'none';
  };

  it('notice boundary: 499/500 pass, 501 is the first notice', async () => {
    expect(await fileSizeSeverityAt(499)).toBe('none');
    expect(await fileSizeSeverityAt(500)).toBe('none');
    expect(await fileSizeSeverityAt(501)).toBe('notice');
  });

  it('warning boundary: 749/750 stay notice, 751 is the first warning', async () => {
    expect(await fileSizeSeverityAt(749)).toBe('notice');
    expect(await fileSizeSeverityAt(750)).toBe('notice');
    expect(await fileSizeSeverityAt(751)).toBe('warning');
  });

  it('error boundary: 899/900 stay warning, 901 is the first error', async () => {
    expect(await fileSizeSeverityAt(899)).toBe('warning');
    expect(await fileSizeSeverityAt(900)).toBe('warning');
    expect(await fileSizeSeverityAt(901)).toBe('error');
  });

  it('test-tier notice boundary: 1199/1200 pass, 1201 is the first notice', async () => {
    const file = 'browser/base/content/test/general/browser_boundary.js';
    expect(await fileSizeSeverityAt(1199, file)).toBe('none');
    expect(await fileSizeSeverityAt(1200, file)).toBe('none');
    expect(await fileSizeSeverityAt(1201, file)).toBe('notice');
  });

  it('counts lines like wc -l — a trailing newline adds no phantom line', async () => {
    // Exactly 750 content lines WITH a trailing '\n'. The old
    // `split('\n').length` accounting saw 751 and (with the old `>=`)
    // reported "750 lines (soft limit: 750)" on a wc-749 file; the
    // fixed rule must stay silent above the notice band only.
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(makeJsFile(750) + '\n');

    const issues = await lintPatchedJs('/engine', ['exact.js'], new Set(['exact.js']), mockConfig);

    const sizeIssue = issues.find((i) => i.check === 'file-too-large');
    expect(sizeIssue?.severity).toBe('notice');
    expect(sizeIssue?.message).toContain('750 lines');
  });

  it('produces no finding for a 500-line new file with trailing newline', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(makeJsFile(500) + '\n');

    const issues = await lintPatchedJs('/engine', ['exact.js'], new Set(['exact.js']), mockConfig);

    expect(issues.some((i) => i.check === 'file-too-large')).toBe(false);
  });

  it('does not flag large existing files', async () => {
    mockPathExists.mockResolvedValue(true);
    const bigFile = Array.from({ length: 700 }, (_, i) => `const x${i} = ${i};`).join('\n');
    mockReadText.mockResolvedValue(bigFile);

    const issues = await lintPatchedJs('/engine', ['existing.js'], new Set<string>(), mockConfig);

    expect(issues.some((i) => i.check === 'file-too-large')).toBe(false);
  });

  it('flags missing JSDoc on exports in new .sys.mjs files as error', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('export function doSomething() {\n  return 1;\n}\n');

    const issues = await lintPatchedJs(
      '/engine',
      ['MyModule.sys.mjs'],
      new Set(['MyModule.sys.mjs']),
      mockConfig
    );

    expect(issues.some((i) => i.check === 'missing-jsdoc')).toBe(true);
    expect(issues.find((i) => i.check === 'missing-jsdoc')?.severity).toBe('error');
  });

  it('does not flag JSDoc check on non-owned files', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('export function doSomething() {\n  return 1;\n}\n');

    const issues = await lintPatchedJs(
      '/engine',
      ['MyModule.sys.mjs'],
      new Set<string>(),
      mockConfig
    );

    expect(issues.some((i) => i.check === 'missing-jsdoc')).toBe(false);
  });

  it('passes exports with complete JSDoc', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(
      '/**\n * Does something.\n * @returns {number} The result\n */\nexport function doSomething() {\n  return 1;\n}\n'
    );

    const issues = await lintPatchedJs(
      '/engine',
      ['MyModule.sys.mjs'],
      new Set(['MyModule.sys.mjs']),
      mockConfig
    );

    const jsdocChecks = ['missing-jsdoc', 'jsdoc-param-mismatch', 'jsdoc-missing-returns'];
    expect(issues.some((i) => jsdocChecks.includes(i.check))).toBe(false);
  });

  it('flags JSDoc issues for patch-owned files via patchOwnedFiles param', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('export function doWork() {\n  return 1;\n}\n');

    // File is not in newFiles but IS in patchOwnedFiles (owned by queue)
    const patchOwned = new Set(['MyModule.sys.mjs']);
    const issues = await lintPatchedJs(
      '/engine',
      ['MyModule.sys.mjs'],
      new Set<string>(),
      mockConfig,
      patchOwned
    );

    expect(issues.some((i) => i.check === 'missing-jsdoc')).toBe(true);
    expect(issues.find((i) => i.check === 'missing-jsdoc')?.severity).toBe('error');
  });

  it('warns about observer topics with binaryName that do not follow convention', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('Services.obs.addObserver(this, "testbrowser-badtopic");\n');

    const issues = await lintPatchedJs('/engine', ['observer.js'], new Set<string>(), mockConfig);

    expect(issues.some((i) => i.check === 'observer-topic-naming')).toBe(true);
    expect(issues.find((i) => i.check === 'observer-topic-naming')?.severity).toBe('warning');
  });

  it('does not match observer topics across newlines (no false positive)', async () => {
    mockPathExists.mockResolvedValue(true);
    // notifyObservers call with no string literal on the same line,
    // followed by an unrelated string on a later line — must NOT be captured.
    mockReadText.mockResolvedValue(
      'Services.obs.notifyObservers(STORAGE_EVENTS.TILES_APPLET_NULLED, {\n' +
        '  data: someValue,\n' +
        '});\n' +
        'lazy.assertAutomationOnly("testbrowser-automation-check");\n'
    );

    const issues = await lintPatchedJs('/engine', ['store.js'], new Set<string>(), mockConfig);

    expect(issues.some((i) => i.check === 'observer-topic-naming')).toBe(false);
  });

  it('passes observer topics following convention', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(
      'Services.obs.addObserver(this, "testbrowser-sidebar-opened");\n'
    );

    const issues = await lintPatchedJs('/engine', ['observer.js'], new Set<string>(), mockConfig);

    expect(issues.some((i) => i.check === 'observer-topic-naming')).toBe(false);
  });

  it('ignores non-JS files', async () => {
    const issues = await lintPatchedJs(
      '/engine',
      ['style.css', 'data.json'],
      new Set<string>(),
      mockConfig
    );

    expect(issues).toEqual([]);
  });

  // ── jsdocClassMethods knob — severity propagation ──────────────────────

  it("propagates 'warning' severity when jsdocClassMethods is 'warning'", async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(
      '/** Store. */\nexport class Store {\n  save(key) {\n    return key;\n  }\n}\n'
    );

    const config: FireForgeConfig = {
      ...mockConfig,
      patchLint: { jsdocClassMethods: 'warning' },
    };
    const issues = await lintPatchedJs(
      '/engine',
      ['Store.sys.mjs'],
      new Set(['Store.sys.mjs']),
      config
    );

    const methodIssue = issues.find((i) => i.check === 'missing-jsdoc-class-method');
    expect(methodIssue).toBeDefined();
    expect(methodIssue?.severity).toBe('warning');
  });

  it('does not emit class-method issues when jsdocClassMethods is absent', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(
      '/** Store. */\nexport class Store {\n  save(key) {\n    return key;\n  }\n}\n'
    );

    const issues = await lintPatchedJs(
      '/engine',
      ['Store.sys.mjs'],
      new Set(['Store.sys.mjs']),
      mockConfig
    );

    expect(issues.some((i) => i.check.includes('class-method'))).toBe(false);
  });

  // ── chromeScriptJsDoc — patch-owned chrome subscripts ─────────────────

  it("flags a patch-owned chrome .js with no class JSDoc when chromeScriptJsDoc='warning'", async () => {
    // Chrome subscripts (script form, no `export` keyword) are loaded via
    // Services.scriptloader.loadSubScript and used to be review-only —
    // the .sys.mjs gate excluded them. The chromeScriptJsDoc knob now
    // covers them via a parseScript-based validator.
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('class MyBrowserDock {\n  constructor() {}\n}\n');

    const config: FireForgeConfig = {
      ...mockConfig,
      patchLint: { chromeScriptJsDoc: 'warning' },
    };
    const file = 'browser/base/content/mybrowserDock.js';
    const issues = await lintPatchedJs(
      '/engine',
      [file],
      new Set([file]),
      config,
      undefined,
      new Set([file])
    );

    const issue = issues.find((i) => i.check === 'missing-jsdoc');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('warning');
    expect(issue?.message).toContain('MyBrowserDock');
  });

  it('does not flag chrome scripts that are not patch-owned (upstream files modified by the patch)', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('class UpstreamThing {}\n');

    const config: FireForgeConfig = {
      ...mockConfig,
      patchLint: { chromeScriptJsDoc: 'warning' },
    };
    const file = 'browser/base/content/upstream.js';
    const issues = await lintPatchedJs(
      '/engine',
      [file],
      new Set<string>(), // not new
      config,
      undefined,
      new Set<string>() // explicit empty patch-owned set
    );

    expect(issues.some((i) => i.check === 'missing-jsdoc')).toBe(false);
  });

  it("does not flag chrome scripts when chromeScriptJsDoc is 'off' or absent", async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('class MyBrowserDock {\n}\n');

    const file = 'browser/base/content/mybrowserDock.js';
    const issues = await lintPatchedJs(
      '/engine',
      [file],
      new Set([file]),
      mockConfig,
      undefined,
      new Set([file])
    );

    expect(issues.some((i) => i.check === 'missing-jsdoc')).toBe(false);
  });

  it('does not double-flag a .sys.mjs with both jsdocClassMethods and chromeScriptJsDoc set', async () => {
    // The .sys.mjs path goes through validateExportJsDoc; chromeScriptJsDoc
    // must not also emit issues for the same file (the dispatch gate
    // requires `.js && !.sys.mjs`).
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(
      '/** Store. */\nexport class Store {\n  /** Save.\n   * @param key - key id\n   * @returns key\n   */\n  save(key) { return key; }\n}\n'
    );

    const config: FireForgeConfig = {
      ...mockConfig,
      patchLint: { jsdocClassMethods: 'warning', chromeScriptJsDoc: 'warning' },
    };
    const file = 'browser/modules/Store.sys.mjs';
    const issues = await lintPatchedJs(
      '/engine',
      [file],
      new Set([file]),
      config,
      new Set([file]),
      new Set<string>() // .sys.mjs is NOT in patchOwnedChromeScripts
    );

    expect(issues).toEqual([]);
  });

  // ── testAssertionFloor — Change B ──────────────────────────────────────

  it('does not flag a browser_*.js test that contains Assert.equal', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('add_task(async function() {\n  Assert.equal(1, 1);\n});\n');

    const config: FireForgeConfig = {
      ...mockConfig,
      patchLint: { testAssertionFloor: 'warning' },
    };
    const file = 'browser/base/content/test/general/browser_focus.js';
    const issues = await lintPatchedJs('/engine', [file], new Set([file]), config);

    expect(issues.some((i) => i.check === 'test-needs-assertion')).toBe(false);
  });

  it('does not flag a browser_*.js test that contains ok(...)', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('add_task(async function() {\n  ok(true);\n});\n');

    const config: FireForgeConfig = {
      ...mockConfig,
      patchLint: { testAssertionFloor: 'warning' },
    };
    const file = 'browser/base/content/test/general/browser_focus.js';
    const issues = await lintPatchedJs('/engine', [file], new Set([file]), config);

    expect(issues.some((i) => i.check === 'test-needs-assertion')).toBe(false);
  });

  it("flags a zero-assertion browser_*.js test at 'warning' when knob is 'warning'", async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(
      'add_task(async function() {\n  console.log("nothing pinned");\n});\n'
    );

    const config: FireForgeConfig = {
      ...mockConfig,
      patchLint: { testAssertionFloor: 'warning' },
    };
    const file = 'browser/base/content/test/general/browser_focus.js';
    const issues = await lintPatchedJs('/engine', [file], new Set([file]), config);

    const issue = issues.find((i) => i.check === 'test-needs-assertion');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('warning');
    expect(issue?.message).toContain(file);
  });

  it('flags a test whose only Assert.equal is inside a /* */ block comment', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(
      'add_task(async function() {\n  /* Assert.equal(1, 1); */\n  console.log("hi");\n});\n'
    );

    const config: FireForgeConfig = {
      ...mockConfig,
      patchLint: { testAssertionFloor: 'warning' },
    };
    const file = 'browser/base/content/test/general/browser_focus.js';
    const issues = await lintPatchedJs('/engine', [file], new Set([file]), config);

    expect(issues.some((i) => i.check === 'test-needs-assertion')).toBe(true);
  });

  it('skips head.js even with no assertions', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('// shared test helpers\nfunction helper() {}\n');

    const config: FireForgeConfig = {
      ...mockConfig,
      patchLint: { testAssertionFloor: 'warning' },
    };
    const file = 'browser/base/content/test/general/head.js';
    const issues = await lintPatchedJs('/engine', [file], new Set([file]), config);

    expect(issues.some((i) => i.check === 'test-needs-assertion')).toBe(false);
  });

  it('skips head_*.js helpers even with no assertions', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('function setup() {}\n');

    const config: FireForgeConfig = {
      ...mockConfig,
      patchLint: { testAssertionFloor: 'warning' },
    };
    const file = 'browser/base/content/test/general/head_helpers.js';
    const issues = await lintPatchedJs('/engine', [file], new Set([file]), config);

    expect(issues.some((i) => i.check === 'test-needs-assertion')).toBe(false);
  });

  it('flags modified (non-new) test files that lost their last assertion', async () => {
    // The pre-0.18.x rule only fired for new test files (`isNew` gate),
    // which let a patch strip the final `Assert.equal` from an existing
    // browser_*.js without surfacing the regression. The rule now fires
    // for any patch-touched browser_*.js, new or modified.
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('add_task(async function() {});\n');

    const config: FireForgeConfig = {
      ...mockConfig,
      patchLint: { testAssertionFloor: 'warning' },
    };
    const file = 'browser/base/content/test/general/browser_focus.js';
    // file is in affectedFiles but NOT in newFiles → modified upstream test
    const issues = await lintPatchedJs('/engine', [file], new Set<string>(), config);

    const issue = issues.find((i) => i.check === 'test-needs-assertion');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('warning');
  });

  it('does not flag a modified test that retains an Assert.* call', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('add_task(async function() {\n  Assert.equal(1, 1);\n});\n');

    const config: FireForgeConfig = {
      ...mockConfig,
      patchLint: { testAssertionFloor: 'warning' },
    };
    const file = 'browser/base/content/test/general/browser_focus.js';
    const issues = await lintPatchedJs('/engine', [file], new Set<string>(), config);

    expect(issues.some((i) => i.check === 'test-needs-assertion')).toBe(false);
  });

  it("does not flag any test when testAssertionFloor is 'off' or absent", async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('add_task(async function() {});\n');

    const file = 'browser/base/content/test/general/browser_focus.js';

    // Absent
    let issues = await lintPatchedJs('/engine', [file], new Set([file]), mockConfig);
    expect(issues.some((i) => i.check === 'test-needs-assertion')).toBe(false);

    // Explicit 'off'
    const configOff: FireForgeConfig = {
      ...mockConfig,
      patchLint: { testAssertionFloor: 'off' },
    };
    issues = await lintPatchedJs('/engine', [file], new Set([file]), configOff);
    expect(issues.some((i) => i.check === 'test-needs-assertion')).toBe(false);
  });

  it("flags zero-assertion file at 'error' severity when knob is 'error'", async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('add_task(async function() {});\n');

    const config: FireForgeConfig = {
      ...mockConfig,
      patchLint: { testAssertionFloor: 'error' },
    };
    const file = 'browser/base/content/test/general/browser_focus.js';
    const issues = await lintPatchedJs('/engine', [file], new Set([file]), config);

    const issue = issues.find((i) => i.check === 'test-needs-assertion');
    expect(issue?.severity).toBe('error');
  });

  it('detects /tests/ (plural) as a valid browser-chrome test directory', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('add_task(async function() {});\n');

    const config: FireForgeConfig = {
      ...mockConfig,
      patchLint: { testAssertionFloor: 'warning' },
    };
    const file = 'browser/components/foo/tests/browser_qa.js';
    const issues = await lintPatchedJs('/engine', [file], new Set([file]), config);

    expect(issues.some((i) => i.check === 'test-needs-assertion')).toBe(true);
  });

  it('does not apply the assertion floor to non-browser-chrome JS files', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('export function helper() {}\n');

    const config: FireForgeConfig = {
      ...mockConfig,
      patchLint: { testAssertionFloor: 'error' },
    };
    const file = 'browser/modules/testbrowser/Helper.sys.mjs';
    const issues = await lintPatchedJs('/engine', [file], new Set([file]), config);

    expect(issues.some((i) => i.check === 'test-needs-assertion')).toBe(false);
  });
});

describe('lintModificationComments', () => {
  it('warns when modified upstream JS lacks BINARYNAME comment', () => {
    const diff =
      'diff --git a/browser/base/content/browser.js b/browser/base/content/browser.js\n' +
      '--- a/browser/base/content/browser.js\n' +
      '+++ b/browser/base/content/browser.js\n' +
      '@@ -10,3 +10,4 @@\n' +
      ' existing line\n' +
      '+const newCode = true;\n';

    const issues = lintModificationComments(diff, mockConfig);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe('missing-modification-comment');
    expect(issues[0]?.severity).toBe('warning');
  });

  it('passes when modification includes BINARYNAME comment', () => {
    const diff =
      'diff --git a/browser/base/content/browser.js b/browser/base/content/browser.js\n' +
      '--- a/browser/base/content/browser.js\n' +
      '+++ b/browser/base/content/browser.js\n' +
      '@@ -10,3 +10,5 @@\n' +
      ' existing line\n' +
      '+// TESTBROWSER: Add new feature\n' +
      '+const newCode = true;\n';

    const issues = lintModificationComments(diff, mockConfig);

    expect(issues).toHaveLength(0);
  });

  it('skips new files', () => {
    const diff =
      'diff --git a/browser/new-file.js b/browser/new-file.js\n' +
      'new file mode 100644\n' +
      '--- /dev/null\n' +
      '+++ b/browser/new-file.js\n' +
      '@@ -0,0 +1,2 @@\n' +
      '+const x = 1;\n' +
      '+const y = 2;\n';

    const issues = lintModificationComments(diff, mockConfig);

    expect(issues).toHaveLength(0);
  });

  it('skips non-JS files', () => {
    const diff =
      'diff --git a/browser/style.css b/browser/style.css\n' +
      '--- a/browser/style.css\n' +
      '+++ b/browser/style.css\n' +
      '@@ -1,1 +1,2 @@\n' +
      ' .foo { }\n' +
      '+.bar { color: red; }\n';

    const issues = lintModificationComments(diff, mockConfig);

    expect(issues).toHaveLength(0);
  });
});

describe('countNonBinaryDiffLines', () => {
  it('counts all lines as text for a pure text diff', () => {
    const diff =
      'diff --git a/file.js b/file.js\n' +
      '--- a/file.js\n' +
      '+++ b/file.js\n' +
      '@@ -1,3 +1,3 @@\n' +
      '-old line\n' +
      '+new line\n' +
      ' context\n';
    const result = countNonBinaryDiffLines(diff);
    expect(result.textLines).toBe(result.total);
  });

  it('excludes binary hunk lines from textLines', () => {
    const diff =
      'diff --git a/icon.png b/icon.png\n' +
      'new file mode 100644\n' +
      'index 0000000..abcdef1\n' +
      'GIT binary patch\n' +
      'literal 1234\n' +
      'zcmV;z1=abcdefghijk\n' +
      '\n' +
      'diff --git a/file.js b/file.js\n' +
      '--- a/file.js\n' +
      '+++ b/file.js\n' +
      '@@ -1 +1 @@\n' +
      '-old\n' +
      '+new\n';
    const result = countNonBinaryDiffLines(diff);
    // Binary hunk: "GIT binary patch", "literal 1234", base85 data, empty line = 4 binary lines
    // (inBinaryHunk stays true until next "diff --git")
    expect(result.textLines).toBe(result.total - 4);
  });

  it('handles multiple binary files', () => {
    const diff =
      'diff --git a/a.png b/a.png\n' +
      'GIT binary patch\n' +
      'literal 100\n' +
      'zdata1\n' +
      '\n' +
      'diff --git a/b.ico b/b.ico\n' +
      'GIT binary patch\n' +
      'literal 200\n' +
      'zdata2\n' +
      '\n';
    const result = countNonBinaryDiffLines(diff);
    // Only the two "diff --git" header lines are non-binary; everything after
    // each "GIT binary patch" stays binary until the next header.
    expect(result.textLines).toBe(2);
  });

  it('handles mixed binary and text files', () => {
    const diff =
      'diff --git a/icon.png b/icon.png\n' +
      'GIT binary patch\n' +
      'literal 500\n' +
      '\n' +
      'diff --git a/app.js b/app.js\n' +
      '@@ -1 +1 @@\n' +
      '-old\n' +
      '+new\n';
    const result = countNonBinaryDiffLines(diff);
    // 3 binary lines: "GIT binary patch", "literal 500", empty line
    expect(result.textLines).toBe(result.total - 3);
  });

  it('agrees with wc -l: a trailing newline does not add a phantom line', () => {
    expect(countNonBinaryDiffLines('a\nb\n').total).toBe(2);
    expect(countNonBinaryDiffLines('a\nb').total).toBe(2);
  });
});

describe('lintPatchSize', () => {
  it('warns when patch affects more than 5 files', () => {
    const files = ['a.js', 'b.js', 'c.js', 'd.js', 'e.js', 'f.js'];
    const issues = lintPatchSize(files, 10);

    expect(issues.some((i) => i.check === 'large-patch-files')).toBe(true);
    expect(issues.find((i) => i.check === 'large-patch-files')?.severity).toBe('warning');
  });

  it('does not warn on file count when a branding-shaped patch has 6 files', () => {
    // 2026-04-25 finding: the file-count check ignored the branding tier
    // entirely. A real-world fresh-fork branding bundle is 56 files (icon
    // assets in 7+ sizes, MSIX manifests, locale .ftl files); the >5
    // threshold fired on every minimum branding diff.
    const brandingFiles = [
      'browser/branding/mybrowser/content/aboutDialog.css',
      'browser/branding/mybrowser/locales/en-US/brand.ftl',
      'browser/branding/mybrowser/pref/firefox-branding.js',
      'browser/branding/mybrowser/default16.png',
      'browser/branding/mybrowser/default32.png',
      'browser/branding/mybrowser/default48.png',
    ];
    const issues = lintPatchSize(brandingFiles, 50);
    expect(issues.some((i) => i.check === 'large-patch-files')).toBe(false);
  });

  it('does not warn on file count when a branding patch has 56 files (operator data point)', () => {
    // The 2026-04-25 operator data point: a freshly-setup mybrowser branding
    // patch landed at exactly 56 files. Pin this against regression so the
    // documented threshold actually accommodates the canonical floor.
    const brandingFiles = Array.from(
      { length: 56 },
      (_, i) => `browser/branding/mybrowser/asset${i}.png`
    );
    brandingFiles[0] = 'browser/branding/mybrowser/content/aboutDialog.css'; // ≥1 branding-prefixed file required by isBrandingOnlyPatch
    const issues = lintPatchSize(brandingFiles, 100);
    expect(issues.some((i) => i.check === 'large-patch-files')).toBe(false);
  });

  it('warns on file count when a branding patch crosses the elevated threshold (61 files)', () => {
    const brandingFiles = Array.from(
      { length: 61 },
      (_, i) => `browser/branding/mybrowser/asset${i}.png`
    );
    brandingFiles[0] = 'browser/branding/mybrowser/content/aboutDialog.css';
    const issues = lintPatchSize(brandingFiles, 100);
    const fileIssue = issues.find((i) => i.check === 'large-patch-files');
    expect(fileIssue?.severity).toBe('warning');
    // Message must reference the branding tier's threshold (60), not the
    // general default of 5 — operators reading the warning need to see the
    // limit the rule actually applied.
    expect(fileIssue?.message).toContain('≤60');
  });

  it('applies the branding file-count tier on explicit patchTier opt-in', () => {
    // A branding patch that also touches a non-allowlisted sibling
    // (e.g. a vendor-specific icon resource the auto-detector cannot
    // reach) declares `tier: "branding"` in patches.json. The file-count
    // check honors that opt-in just like the line-count check does.
    const filesWithUnrelated = Array.from(
      { length: 10 },
      (_, i) => `browser/themes/mybrowser-shared/asset${i}.css`
    );
    expect(
      lintPatchSize(filesWithUnrelated, 100, 'branding').some(
        (i) => i.check === 'large-patch-files'
      )
    ).toBe(false);
  });

  it('warning message names the tier-specific threshold for general patches', () => {
    const files = ['a.js', 'b.js', 'c.js', 'd.js', 'e.js', 'f.js'];
    const issues = lintPatchSize(files, 10);
    const fileIssue = issues.find((i) => i.check === 'large-patch-files');
    expect(fileIssue?.message).toContain('≤5');
  });

  it('keeps the general 5-file threshold for test patches', () => {
    // Test tier elevates the line-count thresholds (a table-driven
    // regression test legitimately runs into the thousands of lines) but
    // file fan-out remains general — a single test rarely spans many
    // files. Six test files is still suspicious, even if six general .js
    // files would be flagged the same way.
    const testFiles = [
      'test/test_a.js',
      'test/test_b.js',
      'test/test_c.js',
      'test/test_d.js',
      'test/test_e.js',
      'test/test_f.js',
    ];
    expect(lintPatchSize(testFiles, 100).some((i) => i.check === 'large-patch-files')).toBe(true);
  });

  it('returns notice when patch exceeds 800 lines', () => {
    const issues = lintPatchSize(['a.js'], 801);

    expect(issues.find((i) => i.check === 'large-patch-lines')?.severity).toBe('notice');
  });

  it('returns warning when patch exceeds 1500 lines', () => {
    const issues = lintPatchSize(['a.js'], 1501);

    expect(issues.find((i) => i.check === 'large-patch-lines')?.severity).toBe('warning');
  });

  it('returns error when patch exceeds 3000 lines', () => {
    const issues = lintPatchSize(['a.js'], 3001);

    expect(issues.find((i) => i.check === 'large-patch-lines')?.severity).toBe('error');
  });

  it('returns no line-count issue at or below 800 lines', () => {
    expect(lintPatchSize(['a.js'], 799).some((i) => i.check === 'large-patch-lines')).toBe(false);
    expect(lintPatchSize(['a.js'], 800).some((i) => i.check === 'large-patch-lines')).toBe(false);
  });

  it('notice boundary triad: 799/800 pass, 801 is the first notice', () => {
    const severityAt = (n: number): string =>
      lintPatchSize(['a.js'], n).find((i) => i.check === 'large-patch-lines')?.severity ?? 'none';
    expect(severityAt(799)).toBe('none');
    expect(severityAt(800)).toBe('none');
    expect(severityAt(801)).toBe('notice');
  });

  it('warning boundary triad: 1499/1500 stay notice, 1501 is the first warning', () => {
    const severityAt = (n: number): string =>
      lintPatchSize(['a.js'], n).find((i) => i.check === 'large-patch-lines')?.severity ?? 'none';
    expect(severityAt(1499)).toBe('notice');
    expect(severityAt(1500)).toBe('notice');
    expect(severityAt(1501)).toBe('warning');
  });

  it('error boundary triad: 2999/3000 stay warning, 3001 is the first error', () => {
    const severityAt = (n: number): string =>
      lintPatchSize(['a.js'], n).find((i) => i.check === 'large-patch-lines')?.severity ?? 'none';
    expect(severityAt(2999)).toBe('warning');
    expect(severityAt(3000)).toBe('warning');
    expect(severityAt(3001)).toBe('error');
  });

  it('test-tier notice boundary triad: 1499/1500 pass, 1501 is the first notice', () => {
    const testFiles = ['test/test_foo.js', 'test/test_bar.js'];
    const severityAt = (n: number): string =>
      lintPatchSize(testFiles, n).find((i) => i.check === 'large-patch-lines')?.severity ?? 'none';
    expect(severityAt(1499)).toBe('none');
    expect(severityAt(1500)).toBe('none');
    expect(severityAt(1501)).toBe('notice');
  });

  it('branding-tier notice boundary triad: 7999/8000 pass, 8001 is the first notice', () => {
    const brandingFiles = ['browser/branding/mybrowser/content/aboutDialog.css'];
    const severityAt = (n: number): string =>
      lintPatchSize(brandingFiles, n).find((i) => i.check === 'large-patch-lines')?.severity ??
      'none';
    expect(severityAt(7999)).toBe('none');
    expect(severityAt(8000)).toBe('none');
    expect(severityAt(8001)).toBe('notice');
  });

  it('returns empty for small patches', () => {
    const issues = lintPatchSize(['a.js'], 50);

    expect(issues).toEqual([]);
  });

  it('uses higher thresholds for test-only patches', () => {
    const testFiles = ['test/test_foo.js', 'test/test_bar.js'];

    expect(lintPatchSize(testFiles, 800).some((i) => i.check === 'large-patch-lines')).toBe(false);
    expect(
      lintPatchSize(testFiles, 1501).find((i) => i.check === 'large-patch-lines')?.severity
    ).toBe('notice');
    expect(
      lintPatchSize(testFiles, 3001).find((i) => i.check === 'large-patch-lines')?.severity
    ).toBe('warning');
    expect(
      lintPatchSize(testFiles, 6001).find((i) => i.check === 'large-patch-lines')?.severity
    ).toBe('error');
  });

  it('uses general thresholds for mixed test and non-test patches', () => {
    const mixedFiles = ['a.js', 'test/test_foo.js'];

    expect(
      lintPatchSize(mixedFiles, 801).find((i) => i.check === 'large-patch-lines')?.severity
    ).toBe('notice');
  });

  it('uses the branding tier when every file is under browser/branding/', () => {
    // Eval regression: a first-export of setup-generated branding landed at
    // 15904 lines (localized brand.ftl across many locales + SVG path data +
    // copied upstream CSS). The general hard limit of 3000 fired an error,
    // but the patch already represented the minimum branding diff. The
    // 2026-04-25 calibration moves the bands to {8000/18000/30000} so the
    // typical 15904-line baseline lands as a soft `notice` rather than a
    // `warning`, matching the docstring's "loud but not actionable" intent.
    const brandingFiles = [
      'browser/branding/mybrowser/content/aboutDialog.css',
      'browser/branding/mybrowser/locales/en-US/brand.ftl',
      'browser/branding/mybrowser/pref/firefox-branding.js',
    ];
    expect(lintPatchSize(brandingFiles, 8000).some((i) => i.check === 'large-patch-lines')).toBe(
      false
    );
    expect(
      lintPatchSize(brandingFiles, 8001).find((i) => i.check === 'large-patch-lines')?.severity
    ).toBe('notice');
    // 15904 was the exact eval data point — must surface as `notice`, not
    // `warning`, after the 2026-04-25 recalibration.
    expect(
      lintPatchSize(brandingFiles, 15904).find((i) => i.check === 'large-patch-lines')?.severity
    ).toBe('notice');
    expect(
      lintPatchSize(brandingFiles, 18001).find((i) => i.check === 'large-patch-lines')?.severity
    ).toBe('warning');
    expect(
      lintPatchSize(brandingFiles, 30001).find((i) => i.check === 'large-patch-lines')?.severity
    ).toBe('error');
  });

  it('uses the branding tier when branding files + browser/moz.configure registration', () => {
    // 2026-04-21 external audit against FireForge 0.17.0: a real-world
    // branding patch legitimately also touches `browser/moz.configure`
    // to register the new branding flavor with the top-level configure.
    // The strict "every file under browser/branding/" predicate returned
    // false and fell through to the general tier, firing ERROR at 15665
    // lines. The narrow registration-file allowlist keeps the invariant
    // ("nothing outside branding + the one-line registration sibling")
    // while tolerating the edit every real branding patch must make.
    const brandingWithRegistration = [
      'browser/branding/mybrowser/content/aboutDialog.css',
      'browser/branding/mybrowser/locales/en-US/brand.ftl',
      'browser/moz.configure',
    ];
    expect(
      lintPatchSize(brandingWithRegistration, 15904).find((i) => i.check === 'large-patch-lines')
        ?.severity
    ).toBe('notice');
  });

  it('uses the branding tier when branding files + browser/confvars.sh registration', () => {
    const brandingWithLegacyRegistration = [
      'browser/branding/mybrowser/content/aboutDialog.css',
      'browser/confvars.sh',
    ];
    expect(
      lintPatchSize(brandingWithLegacyRegistration, 15904).find(
        (i) => i.check === 'large-patch-lines'
      )?.severity
    ).toBe('notice');
  });

  it('does not apply the branding tier when a non-allowlisted sibling is mixed in', () => {
    // The allowlist is tight on purpose — a random non-branding,
    // non-registration sibling (e.g. a vendor-specific component
    // under browser/components/) still disqualifies auto-detection
    // so an operator bundling unrelated changes into a branding edit
    // continues to see the hard limit.
    const mixedFiles = [
      'browser/branding/mybrowser/content/aboutDialog.css',
      'browser/components/tests/unit/test_browserGlue_mybrowser_startup.js',
    ];
    expect(
      lintPatchSize(mixedFiles, 15904).find((i) => i.check === 'large-patch-lines')?.severity
    ).toBe('error');
  });

  it('does NOT qualify as branding when moz.configure is the only file', () => {
    // Guard against a config-only patch accidentally landing in the
    // branding tier — the allowlist is a registration escape hatch
    // for a branding patch, not a blanket exemption for any config
    // edit. Requires ≥1 file under browser/branding/ to qualify.
    const configOnly = ['browser/moz.configure'];
    expect(
      lintPatchSize(configOnly, 15904).find((i) => i.check === 'large-patch-lines')?.severity
    ).toBe('error');
  });

  it('applies the branding tier when patchTier=branding is set, even with unrelated files', () => {
    // Explicit opt-in via PatchMetadata.tier. Covers the branding
    // patch that also touches a non-allowlisted sibling the narrow
    // allowlist cannot reach (e.g. a fork-specific theme override
    // under browser/themes/<name>/). The operator declares intent in
    // patches.json and the lint tier follows.
    const filesWithUnrelated = [
      'browser/branding/mybrowser/content/aboutDialog.css',
      'browser/themes/mybrowser-shared/tokens.css',
    ];
    expect(
      lintPatchSize(filesWithUnrelated, 15904, 'branding').find(
        (i) => i.check === 'large-patch-lines'
      )?.severity
    ).toBe('notice');
  });

  it('tests still beat branding when both apply', () => {
    // Precedence documented on PatchMetadata.tier: test > branding >
    // general. A patch of all tests that also declared tier=branding
    // keeps the test-tier thresholds because they are already more
    // permissive and an all-tests-and-branding-shaped patch is
    // vanishingly rare.
    const testFiles = ['test/test_foo.js', 'test/test_bar.js'];
    // 6001 crosses the test-tier error boundary (limits are inclusive).
    // If branding had won we'd have only reached the branding notice
    // (3000 < 6001 < 8000).
    expect(
      lintPatchSize(testFiles, 6001, 'branding').find((i) => i.check === 'large-patch-lines')
        ?.severity
    ).toBe('error');
  });
});

describe('resolvePatchSizeTier', () => {
  it('returns test tier when every file is a test', () => {
    expect(resolvePatchSizeTier(['test/test_foo.js', 'test/test_bar.js'])).toEqual({
      tier: 'test',
    });
  });

  it('returns branding-explicit when patchTier opts in', () => {
    expect(resolvePatchSizeTier(['browser/branding/custom/logo.png'], 'branding')).toEqual({
      tier: 'branding',
      source: 'explicit',
    });
  });

  it('returns branding-auto when isBrandingOnlyPatch would fire', () => {
    expect(
      resolvePatchSizeTier(['browser/branding/custom/logo.png', 'browser/moz.configure'])
    ).toEqual({ tier: 'branding', source: 'auto' });
  });

  it('returns general when neither tier heuristic applies', () => {
    expect(resolvePatchSizeTier(['browser/base/content/browser.js'])).toEqual({ tier: 'general' });
  });

  it('test tier wins over explicit branding opt-in', () => {
    expect(resolvePatchSizeTier(['test/test_foo.js', 'test/test_bar.js'], 'branding')).toEqual({
      tier: 'test',
    });
  });
});

describe('lintModifiedFileHeaders', () => {
  it('warns when modified file lacks any recognized header', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('const x = 1;\n');

    const issues = await lintModifiedFileHeaders('/engine', ['browser.js'], new Set());

    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe('modified-file-missing-header');
    expect(issues[0]?.severity).toBe('warning');
  });

  it('passes when modified file has MPL header', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(
      '// This Source Code Form is subject to the terms of the Mozilla Public\n' +
        '// License, v. 2.0. If a copy of the MPL was not distributed with this\n' +
        '// file, You can obtain one at http://mozilla.org/MPL/2.0/.\n' +
        'const x = 1;\n'
    );

    const issues = await lintModifiedFileHeaders('/engine', ['browser.js'], new Set());

    expect(issues).toHaveLength(0);
  });

  it('passes when modified file has EUPL header', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('/* SPDX-License-Identifier: EUPL-1.2 */\nconst x = 1;\n');

    const issues = await lintModifiedFileHeaders('/engine', ['module.js'], new Set());

    expect(issues).toHaveLength(0);
  });

  it('skips new files', async () => {
    const issues = await lintModifiedFileHeaders('/engine', ['new.js'], new Set(['new.js']));

    expect(issues).toHaveLength(0);
    expect(mockPathExists).not.toHaveBeenCalled();
  });

  it('skips files with unsupported extensions', async () => {
    const issues = await lintModifiedFileHeaders('/engine', ['data.json'], new Set());

    expect(issues).toHaveLength(0);
    expect(mockPathExists).not.toHaveBeenCalled();
  });

  it('skips files that do not exist', async () => {
    mockPathExists.mockResolvedValue(false);

    const issues = await lintModifiedFileHeaders('/engine', ['missing.js'], new Set());

    expect(issues).toHaveLength(0);
  });

  it('passes when upstream .sys.mjs file has block-comment MPL header', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(
      '/* This Source Code Form is subject to the terms of the Mozilla Public\n' +
        ' * License, v. 2.0. If a copy of the MPL was not distributed with this\n' +
        ' * file, You can obtain one at http://mozilla.org/MPL/2.0/. */\n' +
        'export class Foo {}\n'
    );

    const issues = await lintModifiedFileHeaders(
      '/engine',
      ['browser/components/BrowserGlue.sys.mjs'],
      new Set()
    );

    expect(issues).toHaveLength(0);
  });

  it('passes when modified file has Firefox-wrapped block MPL after editor directives', async () => {
    mockPathExists.mockResolvedValue(true);
    const mpl =
      '/* This Source Code Form is subject to the terms of the Mozilla Public\n' +
      ' * License, v. 2.0. If a copy of the MPL was not distributed with this file,\n' +
      ' * You can obtain one at http://mozilla.org/MPL/2.0/. */\n';
    mockReadText.mockResolvedValue(
      '/* -*- Mode: javascript; tab-width: 8; indent-tabs-mode: nil; js-indent-level: 2 -*- */\n' +
        '/* vim: set ts=8 sts=2 et sw=2 tw=80: */\n' +
        mpl +
        '"use strict";\n'
    );

    const issues = await lintModifiedFileHeaders(
      '/engine',
      ['browser/components/extensions/parent/ext-browser.js'],
      new Set()
    );

    expect(issues).toHaveLength(0);
  });

  it('passes when upstream file contains SPDX identifier in non-standard format', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(
      '// Copyright 2024 Mozilla Foundation\n' +
        '// SPDX-License-Identifier: MPL-2.0\n' +
        'const x = 1;\n'
    );

    const issues = await lintModifiedFileHeaders('/engine', ['utils.js'], new Set());

    expect(issues).toHaveLength(0);
  });
});

describe('lintExportedPatch', () => {
  it('combines issues from all lint checks', async () => {
    mockPathExists.mockResolvedValue(true);
    // A new JS file missing license header with a raw CSS color in a CSS file
    mockReadText.mockImplementation((path: string) => {
      if (path.endsWith('.css')) return Promise.resolve('body { color: #ff0000; }');
      return Promise.resolve('const x = 1;\n');
    });

    const diff =
      'diff --git a/new.js b/new.js\nnew file mode 100644\n--- /dev/null\n+++ b/new.js\n@@ -0,0 +1 @@\n+const x = 1;\n' +
      'diff --git a/style.css b/style.css\n--- a/style.css\n+++ b/style.css\n@@ -1 +1 @@\n-old\n+body { color: #ff0000; }\n';

    const issues = await lintExportedPatch('/engine', ['new.js', 'style.css'], diff, mockConfig);

    // Should have at least: missing-license-header + raw-color-value
    expect(issues.some((i) => i.check === 'missing-license-header')).toBe(true);
    expect(issues.some((i) => i.check === 'raw-color-value')).toBe(true);
  });

  it('surfaces mozbuild-unsorted-list and honours its lintIgnore (FORGE F2)', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockImplementation((path: string) => {
      if (path.endsWith('moz.build')) {
        return Promise.resolve(
          'EXTRA_JS_MODULES += [\n    "Beta.sys.mjs",\n    "Alpha.sys.mjs",\n]\n'
        );
      }
      return Promise.resolve('const x = 1;\n');
    });

    const diff =
      'diff --git a/browser/modules/moz.build b/browser/modules/moz.build\n--- a/browser/modules/moz.build\n+++ b/browser/modules/moz.build\n@@ -1 +1 @@\n-old\n+new\n';

    const issues = await lintExportedPatch(
      '/engine',
      ['browser/modules/moz.build'],
      diff,
      mockConfig
    );
    const unsorted = issues.filter((i) => i.check === 'mozbuild-unsorted-list');
    expect(unsorted).toHaveLength(1);
    expect(unsorted[0]?.message).toContain('expected "Alpha.sys.mjs" but got "Beta.sys.mjs"');

    const suppressed = await lintExportedPatch(
      '/engine',
      ['browser/modules/moz.build'],
      diff,
      mockConfig,
      undefined,
      new Set(['mozbuild-unsorted-list'])
    );
    expect(suppressed.some((i) => i.check === 'mozbuild-unsorted-list')).toBe(false);
  });

  it('filters out issues whose check is in ignoreChecks', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockImplementation((path: string) => {
      if (path.endsWith('.css')) return Promise.resolve('body { color: #ff0000; }');
      return Promise.resolve('const x = 1;\n');
    });

    const diff =
      'diff --git a/new.js b/new.js\nnew file mode 100644\n--- /dev/null\n+++ b/new.js\n@@ -0,0 +1 @@\n+const x = 1;\n' +
      'diff --git a/style.css b/style.css\n--- a/style.css\n+++ b/style.css\n@@ -1 +1 @@\n-old\n+body { color: #ff0000; }\n';

    const ignore = new Set<string>(['raw-color-value']);
    const issues = await lintExportedPatch(
      '/engine',
      ['new.js', 'style.css'],
      diff,
      mockConfig,
      undefined,
      ignore
    );

    // missing-license-header still surfaces because it is not ignored.
    expect(issues.some((i) => i.check === 'missing-license-header')).toBe(true);
    // raw-color-value is suppressed by the ignore list.
    expect(issues.some((i) => i.check === 'raw-color-value')).toBe(false);
  });

  it('suppresses patch-size findings when large-patch-lines is ignored', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('const x = 1;\n');

    // Build a diff that crosses the general-track hard limit (3000 lines)
    // so lintPatchSize produces a large-patch-lines error.
    const huge = Array.from({ length: 3100 }, (_, i) => `+line ${i}`).join('\n');
    const diff =
      'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1,1 +1,3100 @@\n-old\n' + huge + '\n';

    const withoutIgnore = await lintExportedPatch('/engine', ['a.js'], diff, mockConfig);
    expect(withoutIgnore.some((i) => i.check === 'large-patch-lines')).toBe(true);

    const withIgnore = await lintExportedPatch(
      '/engine',
      ['a.js'],
      diff,
      mockConfig,
      undefined,
      new Set(['large-patch-lines'])
    );
    expect(withIgnore.some((i) => i.check === 'large-patch-lines')).toBe(false);
  });

  it('is a no-op when ignoreChecks is empty', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('body { color: #ff0000; }');

    const diff =
      'diff --git a/style.css b/style.css\n--- a/style.css\n+++ b/style.css\n@@ -1 +1 @@\n-old\n+body { color: #ff0000; }\n';

    const issuesWithEmpty = await lintExportedPatch(
      '/engine',
      ['style.css'],
      diff,
      mockConfig,
      undefined,
      new Set<string>()
    );
    const issuesWithUndefined = await lintExportedPatch('/engine', ['style.css'], diff, mockConfig);

    expect(issuesWithEmpty.map((i) => i.check).sort()).toEqual(
      issuesWithUndefined.map((i) => i.check).sort()
    );
  });
});
