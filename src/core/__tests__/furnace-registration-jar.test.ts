// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addJarMnEntries,
  addLocaleFtlJarMnEntry,
  findStaleJarMnEntries,
  pruneStaleJarMnEntries,
  removeJarMnEntries,
  removeLocaleFtlJarMnEntry,
} from '../furnace-registration.js';

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
  it('throws a descriptive error when jar.mn is empty', async () => {
    mockReadText.mockResolvedValue('');

    await expect(addJarMnEntries('/engine', 'moz-widget', ['moz-widget.mjs'])).rejects.toThrow(
      /empty or contains only whitespace/
    );
  });

  it('throws a descriptive error when jar.mn is whitespace-only', async () => {
    mockReadText.mockResolvedValue('   \n\n  \n');

    await expect(addJarMnEntries('/engine', 'moz-widget', ['moz-widget.mjs'])).rejects.toThrow(
      /empty or contains only whitespace/
    );
  });

  it('detects indent from existing lines instead of hardcoding 3 spaces', async () => {
    // Use 4-space indent in the mock jar.mn
    mockReadText.mockResolvedValue(
      [
        'toolkit.jar:',
        '% content global %content/global/',
        '    content/global/elements/findbar.js  (widgets/findbar/findbar.js)',
      ].join('\n')
    );

    await addJarMnEntries('/engine', 'moz-widget', ['moz-widget.mjs']);

    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    // The new entry should use 4-space indent, matching the existing line
    expect(written).toContain('    content/global/elements/moz-widget.mjs');
  });

  it('does not match moz-card entries when registering moz-card-group', async () => {
    mockReadText.mockResolvedValue(
      [
        'toolkit.jar:',
        '% content global %content/global/',
        '   content/global/elements/moz-card.mjs  (widgets/moz-card/moz-card.mjs)',
        '   content/global/elements/moz-card.css  (widgets/moz-card/moz-card.css)',
      ].join('\n')
    );

    await addJarMnEntries('/engine', 'moz-card-group', ['moz-card-group.mjs']);

    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    expect(written).toContain('moz-card-group.mjs');
    // Original entries preserved
    expect(written).toContain('moz-card.mjs');
    expect(written).toContain('moz-card.css');
  });

  it('throws a descriptive error when jar.mn has no content/global section', async () => {
    mockReadText.mockResolvedValue(
      [
        'toolkit.jar:',
        '% skin global classic/1.0 %skin/classic/global/',
        '   skin/classic/global/buttons.css (themes/shared/buttons.css)',
      ].join('\n')
    );

    await expect(addJarMnEntries('/engine', 'moz-widget', ['moz-widget.mjs'])).rejects.toThrow(
      /content\/global\/ section/
    );
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

  it('does not remove moz-card-group entries when removing moz-card', async () => {
    mockReadText.mockResolvedValue(
      [
        'toolkit.jar:',
        '% content global %content/global/',
        '   content/global/elements/moz-card.mjs  (widgets/moz-card/moz-card.mjs)',
        '   content/global/elements/moz-card-group.mjs  (widgets/moz-card-group/moz-card-group.mjs)',
      ].join('\n')
    );

    await removeJarMnEntries('/engine', 'moz-card');

    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    expect(written).not.toContain('moz-card.mjs');
    expect(written).toContain('moz-card-group.mjs');
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

describe('removeJarMnEntries — renamed helpers (0.34.0)', () => {
  it('removes helper lines whose basename does not start with the tag name', async () => {
    // The field bug: `foo-utils.mjs` under (widgets/moz-panel/...) survived
    // the tag-prefixed remove pass and left a stale line that broke
    // packaging. Removal now keys on the source-mapping segment.
    const jar = [
      'toolkit.jar:',
      '% content global %content/global/',
      '   content/global/elements/foo-utils.mjs  (widgets/moz-panel/foo-utils.mjs)',
      '   content/global/elements/moz-panel.mjs  (widgets/moz-panel/moz-panel.mjs)',
      '   content/global/elements/wizard.js  (widgets/wizard/wizard.js)',
    ].join('\n');
    mockReadText.mockResolvedValue(jar);

    await removeJarMnEntries('/engine', 'moz-panel');

    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    expect(written).not.toContain('foo-utils.mjs');
    expect(written).not.toContain('moz-panel.mjs');
    expect(written).toContain('wizard.js');
  });

  it('still removes legacy lines without a widgets source mapping', async () => {
    const jar = [
      'toolkit.jar:',
      '   content/global/elements/moz-panel.css',
      '   content/global/elements/wizard.js  (widgets/wizard/wizard.js)',
    ].join('\n');
    mockReadText.mockResolvedValue(jar);

    await removeJarMnEntries('/engine', 'moz-panel');

    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    expect(written).not.toContain('moz-panel.css');
    expect(written).toContain('wizard.js');
  });
});

describe('stale jar.mn registrations (0.34.0)', () => {
  const JAR_WITH_STALE = [
    'toolkit.jar:',
    '% content global %content/global/',
    '   content/global/elements/moz-panel.mjs  (widgets/moz-panel/moz-panel.mjs)',
    '   content/global/elements/old-helper.mjs  (widgets/moz-panel/old-helper.mjs)',
    '   content/global/elements/wizard.js  (widgets/wizard/wizard.js)',
  ].join('\n');

  it('finds lines whose workspace source file no longer exists', async () => {
    mockReadText.mockResolvedValue(JAR_WITH_STALE);
    mockPathExists.mockImplementation((p: string) =>
      // jar.mn exists; moz-panel.mjs exists in the workspace; old-helper.mjs does not.
      Promise.resolve(!p.endsWith('old-helper.mjs'))
    );

    const stale = await findStaleJarMnEntries('/engine', '/ws/custom', ['moz-panel']);

    expect(stale).toEqual([
      {
        tagName: 'moz-panel',
        fileName: 'old-helper.mjs',
        line: 'content/global/elements/old-helper.mjs  (widgets/moz-panel/old-helper.mjs)',
      },
    ]);
  });

  it('ignores tags that are not furnace-managed', async () => {
    mockReadText.mockResolvedValue(JAR_WITH_STALE);
    mockPathExists.mockImplementation((p: string) => Promise.resolve(p.endsWith('jar.mn')));

    const stale = await findStaleJarMnEntries('/engine', '/ws/custom', []);
    expect(stale).toEqual([]);
  });

  it('prunes exactly the stale lines and keeps live ones', async () => {
    mockReadText.mockResolvedValue(JAR_WITH_STALE);
    mockPathExists.mockImplementation((p: string) =>
      Promise.resolve(!p.endsWith('old-helper.mjs'))
    );

    const pruned = await pruneStaleJarMnEntries('/engine', '/ws/custom', ['moz-panel']);

    expect(pruned.map((entry) => entry.fileName)).toEqual(['old-helper.mjs']);
    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    expect(written).not.toContain('old-helper.mjs');
    expect(written).toContain('moz-panel.mjs');
    expect(written).toContain('wizard.js');
  });

  it('prune is a no-op write when nothing is stale', async () => {
    mockReadText.mockResolvedValue(JAR_WITH_STALE);
    mockPathExists.mockResolvedValue(true);

    const pruned = await pruneStaleJarMnEntries('/engine', '/ws/custom', ['moz-panel']);
    expect(pruned).toEqual([]);
    expect(mockWriteText).not.toHaveBeenCalled();
  });
});

describe('addLocaleFtlJarMnEntry', () => {
  const MOCK_LOCALE_JAR = [
    '@AB_CD@.jar:',
    '% locale global @AB_CD@ %locale/@AB_CD@/global/',
    '  locale/@AB_CD@/toolkit/global/moz-card.ftl (%toolkit/global/moz-card.ftl)',
    '  locale/@AB_CD@/toolkit/global/moz-zzz.ftl (%toolkit/global/moz-zzz.ftl)',
  ].join('\n');

  it('inserts an entry alphabetically under the matching chrome sub-path', async () => {
    mockReadText.mockResolvedValue(MOCK_LOCALE_JAR);
    const inserted = await addLocaleFtlJarMnEntry(
      '/engine',
      'toolkit/locales/jar.mn',
      'moz-dock',
      'toolkit/global'
    );
    expect(inserted).toBe(1);

    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    const lines = written.split('\n');
    const cardIdx = lines.findIndex((line: string) => line.includes('moz-card.ftl'));
    const dockIdx = lines.findIndex((line: string) => line.includes('moz-dock.ftl'));
    const zzzIdx = lines.findIndex((line: string) => line.includes('moz-zzz.ftl'));

    expect(cardIdx).toBeGreaterThan(-1);
    expect(dockIdx).toBeGreaterThan(cardIdx);
    expect(zzzIdx).toBeGreaterThan(dockIdx);
  });

  it('is idempotent when the entry is already present', async () => {
    mockReadText.mockResolvedValue(MOCK_LOCALE_JAR);
    const inserted = await addLocaleFtlJarMnEntry(
      '/engine',
      'toolkit/locales/jar.mn',
      'moz-card',
      'toolkit/global'
    );
    expect(inserted).toBe(0);
    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it('returns 0 when the locale jar.mn is missing (graceful degradation)', async () => {
    mockPathExists.mockResolvedValueOnce(false);
    const inserted = await addLocaleFtlJarMnEntry(
      '/engine',
      'toolkit/locales/jar.mn',
      'moz-dock',
      'toolkit/global'
    );
    expect(inserted).toBe(0);
    expect(mockWriteText).not.toHaveBeenCalled();
  });
});

describe('removeLocaleFtlJarMnEntry', () => {
  it('drops the matching entry and leaves siblings in place', async () => {
    mockReadText.mockResolvedValue(
      [
        '  locale/@AB_CD@/toolkit/global/moz-card.ftl (%toolkit/global/moz-card.ftl)',
        '  locale/@AB_CD@/toolkit/global/moz-dock.ftl (%toolkit/global/moz-dock.ftl)',
      ].join('\n')
    );

    await removeLocaleFtlJarMnEntry(
      '/engine',
      'toolkit/locales/jar.mn',
      'moz-dock',
      'toolkit/global'
    );

    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    expect(written).toContain('moz-card.ftl');
    expect(written).not.toContain('moz-dock.ftl');
  });

  it('is a no-op when the jar.mn file is missing', async () => {
    mockPathExists.mockResolvedValueOnce(false);
    await removeLocaleFtlJarMnEntry(
      '/engine',
      'toolkit/locales/jar.mn',
      'moz-dock',
      'toolkit/global'
    );
    expect(mockWriteText).not.toHaveBeenCalled();
  });
});
