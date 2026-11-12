// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { measureCoverage } from './coverage.js';
import { type OwnedFiles, tokenSettings } from './settings.js';

const TOKEN_FILE = 'browser/themes/shared/acme-tokens.css';
const SETTINGS = tokenSettings({ tokenAllowlist: ['--allowed'] }, 'acme');

function owned(files: Record<string, string>): OwnedFiles {
  return { paths: Object.keys(files), read: (path) => Promise.resolve(files[path]) };
}

describe('measureCoverage', () => {
  it('counts tokens, allowlisted and platform variables, unknown variables and raw colours', async () => {
    const report = await measureCoverage(
      TOKEN_FILE,
      owned({
        [TOKEN_FILE]: ':root { --acme-ink: #111; --legacy-gap: 2px; }\n',
        'browser/b.css':
          '.a { color: var(--acme-ink); background: var(--allowed); border-color: var(--moz-x); }\n',
        'browser/a.css': '.b { color: var(--other); outline-color: rgb(1 2 3); fill: #abc; }\n',
        'browser/a.js': 'not a stylesheet',
      }),
      SETTINGS
    );
    expect(report.files.map((file) => file.file)).toEqual(['browser/a.css', 'browser/b.css']);
    expect(report).toMatchObject({
      tokenUsages: 1,
      allowlisted: 2,
      unknownVars: 1,
      rawColors: 2,
      percent: 25,
      foreignDeclarations: ['--legacy-gap'],
    });
  });

  it('counts colours in values only, not id selectors, strings, comments or url fragments', async () => {
    const report = await measureCoverage(
      TOKEN_FILE,
      owned({
        'browser/x.css':
          '/* #fff */\n#add-button, #fade-in { gap: 0 }\n.a { content: "#fff"; filter: url(#bee); }\n',
      }),
      SETTINGS
    );
    expect(report).toMatchObject({ rawColors: 0, percent: 100, foreignDeclarations: [] });
  });
});
