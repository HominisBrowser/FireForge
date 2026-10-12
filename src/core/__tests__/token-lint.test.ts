// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import {
  collectDeclaredTokenNames,
  lintTokenLockstep,
  lintUndeclaredTokenReferences,
} from '../token-lint.js';

describe('lintTokenLockstep', () => {
  it('returns nothing without a base :root block', () => {
    expect(lintTokenLockstep(['.a { --x-a: 1; }'], 't.css', '--x-')).toEqual([]);
  });

  it('treats a one-line base block as the base and labels nested trails', () => {
    const lines = [
      ':root { --x-a: 1; }',
      '/* :root[data-x] { --x-commented: 1; } */',
      '@media (prefers-color-scheme: dark) {',
      '  :root[data-theme="dark"],',
      '  :root:not([data-theme]) {',
      '    --x-a: 2;',
      '    --x-b: 3;',
      '  }',
      '}',
    ];
    const findings = lintTokenLockstep(lines, 't.css', '--x-');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: 'token-lockstep', line: 7, token: '--x-b' });
    expect(findings[0]?.message).toContain(
      'declared in @media (prefers-color-scheme: dark) > :root[data-theme="dark"], :root:not([data-theme])'
    );
  });

  it('treats an unclosed base block as running to end of file', () => {
    expect(lintTokenLockstep([':root {', '  --x-a: 1;'], 't.css', '--x-')).toEqual([]);
  });
});

describe('lintUndeclaredTokenReferences', () => {
  it('reports each undeclared prefixed reference once, at its first line', () => {
    const declared = collectDeclaredTokenNames([':root {', '  --x-a: 1;', '}']);
    const css = ['.a {', '  gap: var(--x-b);', '  top: var( --x-b );', '  left: var(--y-c);', '}'];
    const findings = lintUndeclaredTokenReferences(
      'p.css',
      css.join('\n'),
      '--x-',
      declared,
      new Set()
    );
    expect(findings.map((finding) => [finding.line, finding.token])).toEqual([[2, '--x-b']]);
  });
});
