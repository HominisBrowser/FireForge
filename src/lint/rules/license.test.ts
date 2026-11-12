// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { licenseHeader } from '../../project/index.js';
import { lintSteps } from '../../testing/lint.js';
import { acceptsCreatedHeader } from './license.js';

const MPL_BLOCK = licenseHeader('MPL-2.0', 'css');
const MPL_OLD_WRAP =
  '/* This Source Code Form is subject to the terms of the Mozilla Public\n * License, v. 2.0. If a copy of the MPL was not distributed with this file,\n * You can obtain one at http://mozilla.org/MPL/2.0/. */';

describe('licenseHeader', () => {
  it.each([
    ['EUPL-1.2', 'js', '/* SPDX-License-Identifier: EUPL-1.2 */'],
    ['EUPL-1.2', 'hash', '# SPDX-License-Identifier: EUPL-1.2'],
    ['MPL-2.0', 'js', licenseHeader('MPL-2.0', 'js')],
  ] as const)('%s in %s style', (license, style, expected) => {
    expect(licenseHeader(license, style)).toBe(expected);
  });

  it('writes the MPL as line comments in JS and as one block in CSS', () => {
    expect(
      licenseHeader('MPL-2.0', 'js')
        .split('\n')
        .every((line) => line.startsWith('// '))
    ).toBe(true);
    expect(MPL_BLOCK.startsWith('/* This Source')).toBe(true);
    expect(MPL_BLOCK.endsWith('MPL/2.0/. */')).toBe(true);
  });
});

describe('acceptsCreatedHeader', () => {
  const eupl = '/* SPDX-License-Identifier: EUPL-1.2 */\ncode();\n';
  it.each([
    ['browser/a.mjs', eupl, 'EUPL-1.2', true],
    ['browser/a.mjs', 'code();\n', 'EUPL-1.2', false],
    ['browser/a.txt', 'anything', 'EUPL-1.2', true],
    ['browser/a.mjs', `${MPL_BLOCK}\ncode();`, 'EUPL-1.2', true],
    ['browser/a.mjs', `${MPL_OLD_WRAP}\ncode();`, 'EUPL-1.2', true],
    ['browser/a.mjs', `/* -*- Mode: js -*- */\n${MPL_BLOCK}\n`, 'EUPL-1.2', true],
    ['browser/a.mjs', `${licenseHeader('MPL-2.0', 'js')}\ncode();`, 'EUPL-1.2', false],
    ['browser/a.css', `${MPL_BLOCK}\n.a{}`, '0BSD', true],
    ['browser/a.css', '/* This Source Code Form is subject to other terms. */', 'EUPL-1.2', false],
    ['browser/a.ftl', `${licenseHeader('MPL-2.0', 'hash')}\nk = v`, 'EUPL-1.2', false],
    [
      'browser/branding/x/brand.ftl',
      `${licenseHeader('MPL-2.0', 'hash')}\nk = v`,
      'EUPL-1.2',
      true,
    ],
    ['browser/a.mjs', `${licenseHeader('MPL-2.0', 'js')}\n`, 'MPL-2.0', true],
  ] as const)('%s', (path, content, license, accepted) => {
    expect(acceptsCreatedHeader(path, content, license)).toBe(accepted);
  });
});

describe('license rules over owned changes', () => {
  it('checks created files against the project license and modified files for any header', async () => {
    const findings = await lintSteps(
      ['missing-license-header', 'modified-file-missing-header'],
      [
        { path: 'browser/new.mjs', after: 'code();\n' },
        { path: 'browser/ok.mjs', after: '/* SPDX-License-Identifier: EUPL-1.2 */\n' },
        { path: 'browser/up.mjs', before: `${MPL_BLOCK}\na();\n`, after: 'a();\n' },
        { path: 'browser/kept.js', before: `${MPL_BLOCK}\na();\n`, after: `${MPL_BLOCK}\nb();\n` },
        {
          path: 'browser/spdx.js',
          before: 'x',
          after: '/*\n * SPDX-License-Identifier: MIT\n */\n',
        },
      ],
      { config: { license: 'EUPL-1.2' } }
    );
    expect(findings.map((f) => [f.rule, f.path])).toEqual([
      ['missing-license-header', 'browser/new.mjs'],
      ['modified-file-missing-header', 'browser/up.mjs'],
    ]);
  });
});
