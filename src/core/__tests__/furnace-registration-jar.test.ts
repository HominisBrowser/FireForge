// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { addJarMnEntries, removeJarMnEntries } from '../furnace-registration.js';

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
  readText: vi.fn(),
  writeText: vi.fn(),
}));

import { pathExists, readText, writeText } from '../../utils/fs.js';

const mockPathExists = vi.mocked(pathExists);
const mockReadText = vi.mocked(readText);
const mockWriteText = vi.mocked(writeText);

beforeEach(() => {
  vi.clearAllMocks();
  mockPathExists.mockResolvedValue(true);
});

describe('addJarMnEntries', () => {
  const MOCK_JAR_MN = `
toolkit.jar:
% content global %content/global/
   content/global/elements/findbar.js  (widgets/findbar/findbar.js)
   content/global/elements/wizard.js  (widgets/wizard/wizard.js)
`.trimStart();

  it('inserts new widget files before the next alphabetical widget block', async () => {
    mockReadText.mockResolvedValue(MOCK_JAR_MN);

    await addJarMnEntries('/engine', 'search-textbox', [
      'search-textbox.mjs',
      'search-textbox.css',
    ]);

    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    const lines = written.split('\n');
    const findbarIdx = lines.findIndex((line: string) => line.includes('findbar.js'));
    const scriptIdx = lines.findIndex((line: string) => line.includes('search-textbox.mjs'));
    const styleIdx = lines.findIndex((line: string) => line.includes('search-textbox.css'));
    const wizardIdx = lines.findIndex((line: string) => line.includes('wizard.js'));

    expect(scriptIdx).toBeGreaterThan(findbarIdx);
    expect(styleIdx).toBe(scriptIdx + 1);
    expect(wizardIdx).toBeGreaterThan(styleIdx);
  });

  it('falls back to the last content/global line when no existing element entries are present', async () => {
    mockReadText.mockResolvedValue(
      [
        'toolkit.jar:',
        '% content global %content/global/',
        '   content/global/foo.ftl (foo.ftl)',
      ].join('\n')
    );

    await addJarMnEntries('/engine', 'search-textbox', ['search-textbox.mjs']);

    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    const lines = written.split('\n');
    const fallbackIdx = lines.findIndex((line: string) => line.includes('content/global/foo.ftl'));
    const widgetIdx = lines.findIndex((line: string) => line.includes('search-textbox.mjs'));

    expect(widgetIdx).toBe(fallbackIdx + 1);
  });

  it('is idempotent when every requested file is already registered', async () => {
    mockReadText.mockResolvedValue(
      [
        'toolkit.jar:',
        '% content global %content/global/',
        '   content/global/elements/search-textbox.mjs  (widgets/search-textbox/search-textbox.mjs)',
        '   content/global/elements/search-textbox.css  (widgets/search-textbox/search-textbox.css)',
      ].join('\n')
    );

    await addJarMnEntries('/engine', 'search-textbox', [
      'search-textbox.mjs',
      'search-textbox.css',
    ]);

    expect(mockWriteText).not.toHaveBeenCalled();
  });
});

describe('removeJarMnEntries', () => {
  it('removes all widget entries for the tag and writes the filtered manifest', async () => {
    mockReadText.mockResolvedValue(
      [
        'toolkit.jar:',
        '% content global %content/global/',
        '   content/global/elements/search-textbox.mjs  (widgets/search-textbox/search-textbox.mjs)',
        '   content/global/elements/search-textbox.css  (widgets/search-textbox/search-textbox.css)',
        '   content/global/elements/wizard.js  (widgets/wizard/wizard.js)',
      ].join('\n')
    );

    await removeJarMnEntries('/engine', 'search-textbox');

    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    expect(written).not.toContain('search-textbox.mjs');
    expect(written).not.toContain('search-textbox.css');
    expect(written).toContain('wizard.js');
  });

  it('returns early when the manifest does not exist', async () => {
    mockPathExists.mockResolvedValue(false);

    await removeJarMnEntries('/engine', 'search-textbox');

    expect(mockReadText).not.toHaveBeenCalled();
    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it('does not write when there is nothing to remove', async () => {
    mockReadText.mockResolvedValue(
      [
        'toolkit.jar:',
        '% content global %content/global/',
        '   content/global/elements/wizard.js  (widgets/wizard/wizard.js)',
      ].join('\n')
    );

    await removeJarMnEntries('/engine', 'search-textbox');

    expect(mockWriteText).not.toHaveBeenCalled();
  });
});
