// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { PROJECT_LICENSES } from '../config/index.js';
import {
  hasLicenseHeader,
  hasUpstreamMplHeader,
  licenseHeader,
  mentionsLicense,
} from './license.js';

const UPSTREAM_HTTPS = `/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export const value = 1;
`;

const UPSTREAM_HTTP = UPSTREAM_HTTPS.replace('https://', 'http://');

describe('licenseHeader', () => {
  it.each(PROJECT_LICENSES)('writes a %s header that is recognised in every style', (license) => {
    for (const style of ['js', 'css', 'hash'] as const) {
      const header = licenseHeader(license, style);
      expect(hasLicenseHeader(`${header}\n\nbody\n`, style)).toBe(true);
    }
    expect(mentionsLicense(licenseHeader(license, 'css'))).toBe(true);
  });

  it('writes line comments for JavaScript and one block for CSS', () => {
    expect(licenseHeader('MPL-2.0', 'js').split('\n')).toHaveLength(3);
    expect(licenseHeader('MPL-2.0', 'js')).toMatch(/^\/\/ This Source Code Form/);
    expect(licenseHeader('MPL-2.0', 'css')).toMatch(/^\/\* This Source Code Form[\s\S]*\*\/$/);
    expect(licenseHeader('EUPL-1.2', 'hash')).toBe('# SPDX-License-Identifier: EUPL-1.2');
  });
});

describe('mentionsLicense', () => {
  const MPL = [
    'This Source Code Form is subject to the terms of the Mozilla Public',
    'License, v. 2.0. If a copy of the MPL was not distributed with this',
    'file, You can obtain one at http://mozilla.org/MPL/2.0/.',
  ];
  const [first = '', second = '', third = ''] = MPL;
  const prefixed = (prefix: string): string => MPL.map((line) => `${prefix}${line}`).join('\n');

  it.each([
    ['a block comment', `/* ${first}\n * ${second}\n * ${third} */\ncode();\n`, true],
    ['line comments', `${prefixed('// ')}\n\ncode();\n`, true],
    ['line comments without a space', `${prefixed('//')}\ncode();\n`, true],
    ['indented line comments with CRLF', `${prefixed('  // ').replace(/\n/g, '\r\n')}\r\n`, true],
    ['hash comments', `${prefixed('# ')}\n\nkey = value\n`, true],
    ['a markup comment', `<!-- ${first}\n   - ${second}\n   - ${third} -->\n<html/>\n`, true],
    ['an unprefixed markup comment', `<!--\n${MPL.join('\n')}\n-->\n<svg/>\n`, true],
    ['line comments behind a directive', `// -*- Mode: js -*-\n${prefixed('// ')}\n`, true],
    ['an SPDX line comment', '// SPDX-License-Identifier: 0BSD\n', true],
    ['line comments that name no license', '// The public\n// interface of the panel.\n', false],
    ['code alone', 'export const license = 1;\n', false],
    ['a notice below the top of the file', `${'code();\n'.repeat(10)}${prefixed('// ')}\n`, false],
  ])('reads %s', (_name, content, expected) => {
    expect(mentionsLicense(content)).toBe(expected);
  });
});

describe('hasLicenseHeader', () => {
  it.each([
    ['the upstream header with the https address', UPSTREAM_HTTPS],
    ['the upstream header with the http address', UPSTREAM_HTTP],
  ])('accepts %s', (_name, content) => {
    expect(hasLicenseHeader(content, 'js')).toBe(true);
    expect(hasLicenseHeader(content, 'css')).toBe(true);
    expect(hasUpstreamMplHeader(content)).toBe(true);
  });

  it('accepts the https address in line comments and hash comments', () => {
    const lines = [
      'This Source Code Form is subject to the terms of the Mozilla Public',
      'License, v. 2.0. If a copy of the MPL was not distributed with this',
      'file, You can obtain one at https://mozilla.org/MPL/2.0/.',
    ];
    expect(hasLicenseHeader(lines.map((line) => `// ${line}`).join('\n'), 'js')).toBe(true);
    expect(hasLicenseHeader(lines.map((line) => `# ${line}`).join('\n'), 'hash')).toBe(true);
  });

  it('reads past editor directives and re-wrapped text', () => {
    const directive = '/* -*- Mode: JavaScript; tab-width: 2 -*- */\n';
    expect(hasLicenseHeader(directive + UPSTREAM_HTTPS, 'js')).toBe(true);
    const rewrapped =
      '/* This Source Code Form is subject to the terms of the Mozilla Public License,\n' +
      ' * v. 2.0. If a copy of the MPL was not distributed with this file,\n' +
      ' * You can obtain one at https://mozilla.org/MPL/2.0/. */\n';
    expect(hasUpstreamMplHeader(rewrapped)).toBe(true);
  });

  it('refuses a file without a header, and a header that is not at the top', () => {
    expect(hasLicenseHeader('export const value = 1;\n', 'js')).toBe(false);
    expect(hasLicenseHeader(`const a = 1;\n${UPSTREAM_HTTPS}`, 'js')).toBe(false);
    expect(hasUpstreamMplHeader('// SPDX-License-Identifier: EUPL-1.2\n')).toBe(false);
    expect(mentionsLicense('export const value = 1;\n')).toBe(false);
  });
});
