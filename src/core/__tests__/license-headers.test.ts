// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addLicenseHeaderToFile,
  getLicenseHeader,
  hasAnyLicenseHeader,
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
