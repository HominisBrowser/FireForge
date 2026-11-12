// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import type { TextStep } from '../../testing/changes.js';
import { lintSteps } from '../../testing/lint.js';
import { codeLines, groupTier } from './size.js';

const linesOf = (count: number): string => 'x();\n'.repeat(count);

describe('file-too-large', () => {
  it.each([
    [500, undefined],
    [501, 'notice'],
    [750, 'notice'],
    [751, 'warning'],
    [900, 'warning'],
    [901, 'error'],
  ])('a created module of %i lines is %s', async (count, band) => {
    const findings = await lintSteps(
      ['file-too-large'],
      [{ path: 'browser/A.sys.mjs', after: linesOf(count) }]
    );
    expect(findings[0]?.severity).toBe(band);
    if (band !== undefined) expect(findings[0]?.measurement).toBe(count);
  });

  it('uses the test bands for test files and leaves modified and non-JS files alone', async () => {
    const findings = await lintSteps(
      ['file-too-large'],
      [
        { path: 'browser/tests/browser_a.js', after: linesOf(1201) },
        { path: 'browser/B.sys.mjs', before: '', after: linesOf(2000) },
        { path: 'browser/c.css', after: linesOf(2000) },
      ]
    );
    expect(findings.map((f) => [f.path, f.severity])).toEqual([
      ['browser/tests/browser_a.js', 'notice'],
    ]);
  });

  it('counts code lines under the code metric, and says when it cannot', async () => {
    const commented = `${'// note\n\n'.repeat(400)}${linesOf(400)}`;
    const config = { patchLint: { fileSizeMetric: 'code' } };
    expect(
      await lintSteps(['file-too-large'], [{ path: 'a/A.mjs', after: commented }], { config })
    ).toEqual([]);
    const broken = await lintSteps(['file-too-large'], [{ path: 'a/B.mjs', after: '"\n' }], {
      config,
    });
    expect(broken.map((f) => f.severity)).toEqual(['notice']);
  });

  it('merges configured bands over the defaults', async () => {
    const config = { patchLint: { fileSizeThresholds: { general: { warning: 600 } } } };
    const findings = await lintSteps(
      ['file-too-large'],
      [{ path: 'a/A.mjs', after: linesOf(601) }],
      { config }
    );
    expect(findings[0]?.severity).toBe('warning');
  });
});

describe('codeLines', () => {
  it.each([
    ['a.mjs', 'const s = "//";\n// c\n/* x\n */\nf();', [true, false, false, false, true]],
    [
      'a.css',
      '/* c */\n.a{}\n/* @fireforge-include x.css */\n.b{}\n/* @fireforge-end-include x.css */',
      [false, true, false, false, false],
    ],
    ['a.xhtml', '<!-- c -->\n<a/>', [false, true]],
    ['a.ftl', '# c\nk = v', [false, true]],
    ['a.ini', '; c\n[x]', [false, true]],
    ['a.properties', '! c\nk=v', [false, true]],
    ['a.txt', '# not a comment\n', [true, false]],
  ])('%s', (path, text, code) => {
    expect(codeLines(path, text).code).toEqual(code);
  });
});

describe('groupTier', () => {
  it.each([
    [['a/test/x.js', 'b/browser_y.js'], undefined, 'test'],
    [['a/test/x.js'], 'branding', 'test'],
    [['browser/branding/mine/a.png', 'browser/moz.configure'], undefined, 'branding'],
    [['browser/moz.configure'], undefined, 'general'],
    [['browser/branding/mine/a.png', 'browser/app/x.js'], undefined, 'general'],
    [['browser/app/x.js'], 'branding', 'branding'],
  ] as const)('%j (%s) -> %s', (paths, declared, tier) => {
    expect(groupTier(paths, declared)).toBe(tier);
  });
});

describe('group size', () => {
  const files = (count: number, group: string, prefix = 'browser/app'): TextStep[] =>
    Array.from({ length: count }, (_, i) => ({
      path: `${prefix}/${group}${i}.js`,
      group,
      after: 'x();\n',
    }));

  it('warns past the file band of the tier, not counting registration files', async () => {
    const config = { patchLint: { patchSizeRegistrationFiles: ['jar.mn'] } };
    const findings = await lintSteps(
      ['large-patch-files'],
      [
        ...files(6, 'big'),
        ...files(5, 'ok'),
        { path: 'browser/jar.mn', group: 'ok', after: 'x\n' },
        ...files(56, 'brand', 'browser/branding/mine'),
      ],
      { groups: ['big', 'ok', 'brand'], config }
    );
    expect(findings.map((f) => [f.group, f.severity, f.measurement])).toEqual([
      ['big', 'warning', 6],
    ]);
  });

  it('leaves a group that is not sized to the per-file rules', async () => {
    const steps = files(40, 'created-browser-app');
    const sized = await lintSteps(['large-patch-files'], steps, {
      groups: ['created-browser-app'],
    });
    expect(sized.map((f) => f.measurement)).toEqual([40]);
    const unsized = await lintSteps(['large-patch-files', 'large-patch-lines'], steps, {
      groups: [{ id: 'created-browser-app', sized: false, meta: {} }],
    });
    expect(unsized).toEqual([]);
  });

  it('counts diff lines by default and code lines per share under addedCode', async () => {
    const steps = [
      { path: 'browser/A.sys.mjs', group: 'g', after: linesOf(900) },
      { path: 'browser/tests/browser_a.js', group: 'g', after: linesOf(1600) },
    ];
    const byDiff = await lintSteps(['large-patch-lines'], steps, { groups: ['g'] });
    expect(byDiff.map((f) => [f.severity, f.measurement])).toEqual([['warning', 2510]]);
    const config = { patchLint: { patchSizeMetric: 'addedCode' } };
    const byCode = await lintSteps(['large-patch-lines'], steps, { groups: ['g'], config });
    expect(byCode.map((f) => [f.share, f.severity, f.measurement])).toEqual([
      ['product', 'notice', 900],
      ['test', 'notice', 1600],
    ]);
  });
});
