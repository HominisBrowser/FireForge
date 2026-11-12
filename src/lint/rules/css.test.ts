// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import type { TextStep } from '../../testing/changes.js';
import { lintSteps } from '../../testing/lint.js';
import type { Finding } from '../index.js';
import { cssDeclarations, offScaleAtom } from './css.js';

describe('raw-color-value', () => {
  const lint = (steps: readonly TextStep[], config = {}): Promise<Finding[]> =>
    lintSteps(['raw-color-value'], steps, { config });

  it('scans a created stylesheet whole and a modified one on its added lines', async () => {
    const upstream = '.a { color: #fff; }\n';
    const findings = await lint([
      { path: 'browser/new.css', after: '.n { color: rgb(1, 2, 3); }\n' },
      { path: 'browser/old.css', before: upstream, after: `${upstream}.b { color: var(--x); }\n` },
      {
        path: 'browser/hot.css',
        before: upstream,
        after: `${upstream}.b { color: hsl(1 2% 3%); }\n`,
      },
    ]);
    expect(findings.map((f) => [f.path, f.line])).toEqual([
      ['browser/hot.css', 2],
      ['browser/new.css', 1],
    ]);
  });

  it('reads colours in values only, not id selectors, strings or url fragments', async () => {
    const css =
      '#add-button, #fade-in { margin: 0 }\n.a { background: url("x.svg#fab"); filter: url(#bee) }\n' +
      '.b::after { content: "#fff"; }\n.c {\n  border: 1px solid\n    #abc;\n}\n';
    const findings = await lint([{ path: 'browser/themes/x.css', after: css }]);
    expect(findings.map((f) => f.line)).toEqual([6]);
  });

  it('hides colours inside comments that span unchanged and added lines', async () => {
    const before = '/* palette\n';
    const after = '/* palette\n#abcdef */\n.a { color: var(--x); }\n';
    expect(await lint([{ path: 'a/x.css', before, after }])).toEqual([]);
  });

  it('exempts branding and allowlisted files by path or basename', async () => {
    const color = '.a { color: #123456; }\n';
    const findings = await lint(
      [
        { path: 'browser/branding/mine/about.css', after: color },
        { path: 'browser/themes/tokens.css', after: color },
        { path: 'browser/themes/exact.css', after: color },
        { path: 'browser/themes/other.css', after: color },
      ],
      { patchLint: { rawColorAllowlist: ['tokens.css', 'browser/themes/exact.css'] } }
    );
    expect(findings.map((f) => f.path)).toEqual(['browser/themes/other.css']);
  });
});

describe('token-prefix-violation', () => {
  const tokens = { prefix: '--mine-', allowlist: ['--allowed'], runtimeVariables: ['--state'] };

  it('accepts tokens, allowlisted, runtime and same-file variables, once per name', async () => {
    const css = [
      '.a { --local: 1px; padding: var(--local); }',
      '.b { color: var(--mine-fg); background: var(--allowed); width: var(--state); }',
      '.c { color: var(--moz-fg); border-color: var(--moz-fg); }',
    ].join('\n');
    const findings = await lintSteps(
      ['token-prefix-violation'],
      [{ path: 'a/x.css', after: css }],
      { tokens }
    );
    expect(findings.map((f) => [f.line, f.message.slice(0, 15)])).toEqual([[3, 'var(--moz-fg) d']]);
  });

  it('judges a modified stylesheet on its added lines only, and does not run without tokens', async () => {
    const before = '.a { color: var(--moz-old); }\n';
    const steps = [{ path: 'a/x.css', before, after: `${before}.b { color: var(--moz-new); }\n` }];
    const findings = await lintSteps(['token-prefix-violation'], steps, { tokens });
    expect(findings.map((f) => f.message.slice(0, 15))).toEqual(['var(--moz-new) ']);
    expect(await lintSteps(['token-prefix-violation'], steps)).toEqual([]);
  });
});

describe('token scales', () => {
  const space = {
    properties: ['gap', 'padding*', 'margin*'],
    prefix: ['--mine-space-', '--mine-gap-'],
    allow: ['--mine-page-*'],
    allowLiterals: ['0', 'auto', '*%'],
    allowInCalc: ['2'],
    offsetCap: 2,
  };

  it.each([
    ['var(--mine-space-4)', undefined],
    ['var(--mine-gap-1) var(--mine-page-x)', undefined],
    ['0 auto 50%', undefined],
    ['inherit', undefined],
    ['7px', '7px'],
    ['var(--other)', 'var(--other)'],
    ['var(--mine-space-2, 7px)', '7px'],
    ['calc(var(--mine-space-2) * 2)', undefined],
    ['2', '2'],
    ['calc(var(--mine-space-2) - 1px - 1px)', undefined],
    ['calc(var(--mine-space-2) - 3px)', '3px'],
    ['calc(var(--mine-space-2) + 1px)', '1px'],
    ['var(--mine-space-2) !important', undefined],
  ])('%s -> %s', (value, offending) => {
    expect(offScaleAtom(value, { ...space, properties: [...space.properties] })).toBe(offending);
  });

  it('reads declarations outside comments and descriptor at-rules', () => {
    const css = '@font-face { font-weight: 700; }\n/* gap: 3px; */\n.a {\n  gap: 3px;\n}\n';
    expect(cssDeclarations(css)).toEqual([{ property: 'gap', value: '3px', line: 4 }]);
  });

  it('does not read a selector with a pseudo-class as a declaration', () => {
    const css = 'a:hover,\nbutton:focus-visible { margin: 2px }\n.b { &:hover { gap: 1px } }\n';
    expect(cssDeclarations(css)).toEqual([
      { property: 'margin', value: '2px', line: 2 },
      { property: 'gap', value: '1px', line: 3 },
    ]);
  });

  it('holds created stylesheets to the scales, with excludes and reviewed values', async () => {
    const css = '.a { gap: 3px; margin-top: 126px; padding: var(--mine-space-1); }\n';
    const scale = {
      ...space,
      exclude: ['browser/legacy/**'],
      allowValues: [{ property: 'margin-top', value: '126px', reason: 'structural' }],
    };
    const findings = await lintSteps(
      ['token-scale'],
      [
        { path: 'browser/a.css', after: css },
        { path: 'browser/legacy/b.css', after: css },
        { path: 'browser/c.css', before: '', after: css },
      ],
      { config: { patchLint: { tokenScales: [scale] } } }
    );
    expect(findings.map((f) => [f.path, f.message.slice(0, 32)])).toEqual([
      ['browser/a.css', 'gap: 3px is off the --mine-space'],
    ]);
  });

  it('fails a floored scale that governs too few files, and names stale excludes', async () => {
    const config = {
      patchLint: {
        tokenScales: [{ ...space, minFiles: 2, exclude: ['gone/**', 'browser/a.css'] }],
      },
    };
    const findings = await lintSteps(
      ['token-scale-vacuous', 'stale-token-scale-exclude'],
      [
        { path: 'browser/b.css', after: '.a { gap: 0; }\n' },
        { path: 'browser/a.css', after: '' },
      ],
      { config }
    );
    expect(findings.map((f) => [f.rule, f.severity])).toEqual([
      ['stale-token-scale-exclude', 'warning'],
      ['token-scale-vacuous', 'error'],
    ]);
  });
});
