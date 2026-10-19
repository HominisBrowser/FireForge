// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFsMock } from '../../test-utils/module-mocks.js';
import {
  removeJarMnFileEntries,
  renameJarMnEntriesInPlace,
} from '../furnace-registration-jar-inplace.js';

vi.mock('../../utils/fs.js', () => createFsMock());

import { pathExists, readText, writeText } from '../../utils/fs.js';

const mockPathExists = vi.mocked(pathExists);
const mockReadText = vi.mocked(readText);
const mockWriteText = vi.mocked(writeText);

// Deliberately not sorted: an in-place edit must keep the block's order.
const JAR_MN = [
  'toolkit.jar:',
  '   content/global/elements/moz-card.mjs  (widgets/moz-card/moz-card.mjs)',
  '   content/global/elements/moz-card-parts.mjs  (widgets/moz-card/moz-card-parts.mjs)',
  '   content/global/elements/moz-card.css  (widgets/moz-card/moz-card.css) # kept comment',
  '   content/global/elements/moz-card-group.mjs  (widgets/moz-card-group/moz-card-group.mjs)',
  '   content/global/elements/moz-card.js',
  '',
].join('\n');

beforeEach(() => {
  vi.clearAllMocks();
  mockPathExists.mockResolvedValue(true);
  mockReadText.mockResolvedValue(JAR_MN);
});

function written(): string {
  return mockWriteText.mock.calls[0]?.[1] ?? '';
}

describe('removeJarMnFileEntries', () => {
  it('removes only the named file and leaves the rest of the block in place', async () => {
    expect(await removeJarMnFileEntries('/engine', 'moz-card', ['moz-card-parts.mjs'])).toBe(1);
    expect(written()).toBe(JAR_MN.replace(/^.*moz-card-parts.*\n/m, ''));
  });

  it('removes a legacy target-only line and never touches another tag', async () => {
    expect(await removeJarMnFileEntries('/engine', 'moz-card', ['moz-card.js'])).toBe(1);
    expect(written()).toContain('moz-card-group.mjs');
    expect(written()).not.toContain('elements/moz-card.js\n');
  });

  it('writes nothing when no line matches, no file is named or jar.mn is missing', async () => {
    expect(await removeJarMnFileEntries('/engine', 'moz-card', ['absent.mjs'])).toBe(0);
    expect(await removeJarMnFileEntries('/engine', 'moz-card', [])).toBe(0);
    mockPathExists.mockResolvedValue(false);
    expect(await removeJarMnFileEntries('/engine', 'moz-card', ['moz-card.mjs'])).toBe(0);
    expect(mockWriteText).not.toHaveBeenCalled();
  });
});

describe('renameJarMnEntriesInPlace', () => {
  const rename = (file: string): string =>
    file.startsWith('moz-card.') ? `moz-tile${file.slice('moz-card'.length)}` : file;

  it('rewrites each live line where it stands and drops a line whose file is gone', async () => {
    const covered = await renameJarMnEntriesInPlace(
      '/engine',
      'moz-card',
      'moz-tile',
      ['moz-tile.mjs', 'moz-tile.css', 'moz-card-parts.mjs'],
      rename
    );
    expect(covered).toEqual(['moz-tile.mjs', 'moz-card-parts.mjs', 'moz-tile.css']);
    expect(written().split('\n')).toEqual([
      'toolkit.jar:',
      '   content/global/elements/moz-tile.mjs  (widgets/moz-tile/moz-tile.mjs)',
      '   content/global/elements/moz-card-parts.mjs  (widgets/moz-tile/moz-card-parts.mjs)',
      '   content/global/elements/moz-tile.css  (widgets/moz-tile/moz-tile.css) # kept comment',
      '   content/global/elements/moz-card-group.mjs  (widgets/moz-card-group/moz-card-group.mjs)',
      '',
    ]);
  });

  it('returns nothing when jar.mn is missing', async () => {
    mockPathExists.mockResolvedValue(false);
    expect(await renameJarMnEntriesInPlace('/engine', 'a', 'b', ['b.mjs'], rename)).toEqual([]);
  });
});
