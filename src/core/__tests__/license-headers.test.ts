// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addLicenseHeaderToFile,
  containsUpstreamLicenseText,
  getLicenseHeader,
  hasAnyLicenseHeader,
  hasAnyLicenseHeaderAnyStyle,
} from '../license-headers.js';

vi.mock('../../utils/fs.js', () => ({
  readText: vi.fn(),
  writeText: vi.fn(),
}));

import { readText, writeText } from '../../utils/fs.js';

const mockReadText = vi.mocked(readText);
const mockWriteText = vi.mocked(writeText);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('hasAnyLicenseHeader', () => {
  it('returns true for MPL-2.0 JS header', () => {
    const content =
      '// This Source Code Form is subject to the terms of the Mozilla Public\n' +
      '// License, v. 2.0. If a copy of the MPL was not distributed with this\n' +
      '// file, You can obtain one at http://mozilla.org/MPL/2.0/.\n' +
      'const x = 1;\n';
    expect(hasAnyLicenseHeader(content, 'js')).toBe(true);
  });

  it('returns true for EUPL-1.2 JS header', () => {
    const content = '/* SPDX-License-Identifier: EUPL-1.2 */\nconst x = 1;\n';
    expect(hasAnyLicenseHeader(content, 'js')).toBe(true);
  });

  it('returns true for 0BSD hash header', () => {
    const content = '# SPDX-License-Identifier: 0BSD\nsome-key = value\n';
    expect(hasAnyLicenseHeader(content, 'hash')).toBe(true);
  });

  it('returns true for MPL-2.0 CSS header', () => {
    const header = getLicenseHeader('MPL-2.0', 'css');
    const content = header + '\n.foo { display: block; }\n';
    expect(hasAnyLicenseHeader(content, 'css')).toBe(true);
  });

  it('returns false for content without any header', () => {
    expect(hasAnyLicenseHeader('const x = 1;\n', 'js')).toBe(false);
  });

  it('returns false for wrong comment style', () => {
    const jsHeader = getLicenseHeader('MPL-2.0', 'js');
    expect(hasAnyLicenseHeader(jsHeader + '\n', 'css')).toBe(false);
  });
});

describe('hasAnyLicenseHeaderAnyStyle', () => {
  it('recognizes MPL in CSS block-comment style', () => {
    const content = getLicenseHeader('MPL-2.0', 'css') + '\nbody {}\n';
    expect(hasAnyLicenseHeaderAnyStyle(content)).toBe(true);
  });

  it('recognizes EUPL in hash-comment style', () => {
    const content = getLicenseHeader('EUPL-1.2', 'hash') + '\nkey = value\n';
    expect(hasAnyLicenseHeaderAnyStyle(content)).toBe(true);
  });

  it('returns false when no recognized header is present', () => {
    expect(hasAnyLicenseHeaderAnyStyle('const x = 1;\n')).toBe(false);
  });
});

describe('containsUpstreamLicenseText', () => {
  it('finds Mozilla Public License text in leading lines', () => {
    const content =
      '/* This Source Code Form is subject to the terms of the Mozilla Public License,\n' +
      ' * v. 2.0. */\n' +
      'export class Foo {}\n';
    expect(containsUpstreamLicenseText(content)).toBe(true);
  });

  it('finds SPDX-License-Identifier in leading lines', () => {
    const content =
      '// Copyright 2024 Someone\n' + '// SPDX-License-Identifier: MIT\n' + 'const x = 1;\n';
    expect(containsUpstreamLicenseText(content)).toBe(true);
  });

  it('returns false when no license text in the first 10 lines', () => {
    const lines = Array.from({ length: 15 }, (_, i) => `// line ${i}`);
    lines[12] = '// Mozilla Public License';
    expect(containsUpstreamLicenseText(lines.join('\n'))).toBe(false);
  });

  it('returns false for content with no license text at all', () => {
    expect(containsUpstreamLicenseText('const x = 1;\nconst y = 2;\n')).toBe(false);
  });
});

describe('addLicenseHeaderToFile', () => {
  it('prepends header to file without one', async () => {
    mockReadText.mockResolvedValue('const x = 1;\n');
    mockWriteText.mockResolvedValue(undefined);

    const result = await addLicenseHeaderToFile('/engine/new.js', 'MPL-2.0', 'js');

    expect(result).toBe(true);
    expect(mockWriteText).toHaveBeenCalledWith(
      '/engine/new.js',
      getLicenseHeader('MPL-2.0', 'js') + '\nconst x = 1;\n'
    );
  });

  it('returns false and does not write if header already present', async () => {
    const header = getLicenseHeader('MPL-2.0', 'js');
    mockReadText.mockResolvedValue(header + '\nconst x = 1;\n');

    const result = await addLicenseHeaderToFile('/engine/existing.js', 'MPL-2.0', 'js');

    expect(result).toBe(false);
    expect(mockWriteText).not.toHaveBeenCalled();
  });
});
