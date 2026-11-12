// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { memoryFiles } from '../testing/files.js';
import { measureCoverage } from './coverage.js';
import { lintTokens } from './lint.js';
import type { OwnedFiles, TokenSettings } from './settings.js';

const TOKEN_FILE = 'browser/themes/shared/acme-tokens.css';

const SETTINGS: TokenSettings = {
  file: TOKEN_FILE,
  prefix: '--acme-',
  exempt: new Set(['--acme-runtime']),
  platformPrefixes: ['--moz-'],
  siblingSheets: {},
};

const TOKENS = `:root {
  --acme-ink: #111;
  --acme-gap: 8px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --acme-ink: #eee;
    --acme-only-dark: #000;
  }
}
:root[data-skin="x"] {
  --acme-gap: 4px;
  --moz-platform: 1;
  --acme-only-skin: 1px;
}
`;

function owned(files: Record<string, string>): OwnedFiles {
  const memory = memoryFiles(files);
  return { paths: Object.keys(files).sort(), read: (path) => memory.read(path) };
}

describe('lintTokens lockstep', () => {
  it('reports prefixed tokens that only a themed block declares', async () => {
    const report = await lintTokens(TOKEN_FILE, owned({ [TOKEN_FILE]: TOKENS }), SETTINGS);
    expect(report.findings.map((f) => [f.check, f.token, f.line])).toEqual([
      ['token-lockstep', '--acme-only-dark', 8],
      ['token-lockstep', '--acme-only-skin', 14],
    ]);
    expect(report.findings[0]?.message).toContain('@media (prefers-color-scheme: dark) > :root');
  });

  it('refuses a missing token file', async () => {
    await expect(lintTokens(TOKEN_FILE, owned({}), SETTINGS)).rejects.toThrow(
      /Token file not found/
    );
  });
});

describe('lintTokens references', () => {
  const base = { [TOKEN_FILE]: ':root {\n  --acme-ink: #111;\n}\n' };

  it('reports a prefixed reference no block declares, once per sheet', async () => {
    const report = await lintTokens(
      TOKEN_FILE,
      owned({
        ...base,
        'toolkit/a.css':
          'a { color: var(--acme-ink); gap: var(--acme-gone); margin: var(--acme-gone); }\n',
      }),
      SETTINGS
    );
    expect(report.filesScanned).toBe(2);
    expect(report.findings).toEqual([
      expect.objectContaining({
        check: 'token-undeclared',
        file: 'toolkit/a.css',
        token: '--acme-gone',
        line: 1,
      }),
    ]);
  });

  it('does not report fallbacks, other prefixes, exempt names, local declarations or comments', async () => {
    const report = await lintTokens(
      TOKEN_FILE,
      owned({
        ...base,
        'toolkit/a.css': [
          'a {',
          '  --acme-local: 1px;',
          '  b: var(--acme-local);',
          '  c: var(--acme-gone, 0);',
          '  d: var(--other-gone);',
          '  e: var(--acme-runtime);',
          '  /* f: var(--acme-commented); */',
          '}',
        ].join('\n'),
      }),
      SETTINGS
    );
    expect(report.findings).toEqual([]);
  });

  it('judges the token file itself', async () => {
    const report = await lintTokens(
      TOKEN_FILE,
      owned({ [TOKEN_FILE]: ':root {\n  --acme-a: var(--acme-b);\n}\n' }),
      SETTINGS
    );
    expect(report.findings.map((f) => f.token)).toEqual(['--acme-b']);
  });
});

describe('lintTokens sibling sheets', () => {
  const files = {
    [TOKEN_FILE]: ':root {\n  --acme-ink: #111;\n}\n',
    'widgets/host.css': ':root {\n  --acme-host: 1px;\n}\n',
    'widgets/user.css': 'a { gap: var(--acme-host); }\n',
  };

  it('reports the reference when nothing links the sheets', async () => {
    const report = await lintTokens(TOKEN_FILE, owned(files), SETTINGS);
    expect(report.findings.map((f) => f.token)).toEqual(['--acme-host']);
  });

  it('resolves a token through a document that links both sheets, by chrome URL and by relative URL', async () => {
    const linked = {
      ...files,
      'widgets/jar.mn':
        'toolkit.jar:\n   content/global/elements/host.css  (host.css)\n   content/global/elements/user.css  (user.css)\n',
      'widgets/doc.xhtml':
        '<html>\n<link rel="stylesheet" href="chrome://global/content/elements/host.css"/>\n<html:link rel="stylesheet" href="user.css"/>\n</html>\n',
    };
    expect((await lintTokens(TOKEN_FILE, owned(linked), SETTINGS)).findings).toEqual([]);
  });

  it('resolves a token through @import and through configured pairings', async () => {
    const imported = {
      ...files,
      'widgets/user.css': '@import url("host.css");\na { gap: var(--acme-host); }\n',
    };
    expect((await lintTokens(TOKEN_FILE, owned(imported), SETTINGS)).findings).toEqual([]);
    const paired = await lintTokens(TOKEN_FILE, owned(files), {
      ...SETTINGS,
      siblingSheets: { 'widgets/user.css': ['widgets/host*.css'] },
    });
    expect(paired.findings).toEqual([]);
  });
});

describe('measureCoverage', () => {
  it('counts tokens, allowlisted and unknown variables and raw colors per sheet', async () => {
    const report = await measureCoverage(
      TOKEN_FILE,
      owned({
        [TOKEN_FILE]: ':root {\n  --acme-a: 1;\n  --stray: 2;\n}\n',
        'a.css': [
          'a {',
          '  color: var(--acme-a);',
          '  gap: var(--acme-a);',
          '  x: var(--moz-thing);',
          '  y: var(--acme-runtime);',
          '  z: var(--stray);',
          '  background: #fff;',
          '  border-color: rgba(0, 0, 0, 0.5);',
          '  /* #000 var(--acme-a) */',
          '}',
        ].join('\n'),
        'b.txt': 'var(--acme-a) #fff',
      }),
      SETTINGS
    );
    expect(report.files).toEqual([
      { file: 'a.css', tokenUsages: 3, allowlisted: 1, unknownVars: 1, rawColors: 2 },
    ]);
    expect(report).toMatchObject({ percent: 50, tokenUsages: 3, unknownVars: 1, rawColors: 2 });
    expect(report.foreignDeclarations).toEqual(['--stray']);
  });

  it('is fully covered when there is nothing to cover', async () => {
    const report = await measureCoverage(
      TOKEN_FILE,
      owned({ 'a.css': 'a { color: red; }' }),
      SETTINGS
    );
    expect(report.percent).toBe(100);
  });
});
