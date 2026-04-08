// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FurnaceError } from '../../errors/furnace.js';
import { computeComponentChecksums, hasComponentChanged } from '../furnace-apply.js';
import {
  addCustomElementRegistration,
  removeCustomElementRegistration,
} from '../furnace-registration.js';

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
  readText: vi.fn(),
  writeText: vi.fn(),
  copyFile: vi.fn(),
  ensureDir: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn() };
});

import { readdir } from 'node:fs/promises';
const mockReaddir = vi.mocked(readdir);

import { pathExists, readText, writeText } from '../../utils/fs.js';

const mockPathExists = vi.mocked(pathExists);
const mockReadText = vi.mocked(readText);
const mockWriteText = vi.mocked(writeText);

/**
 * Minimal mock of customElements.js with both registration arrays:
 * - Array 1: loadSubScript (.js) entries
 * - Array 2: DOMContentLoaded / importESModule (.mjs) entries
 */
const MOCK_CUSTOM_ELEMENTS_JS = `
// ... preamble ...

for (let [tag, script] of [
    ["findbar", "chrome://global/content/elements/findbar.js"],
    ["search-textbox", "chrome://global/content/elements/search-textbox.js"],
    ["wizard", "chrome://global/content/elements/wizard.js"],
]) {
  customElements.setElementCreationCallback(tag, () => {
    Services.scriptloader.loadSubScript(script, window);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  for (let [tag, script] of [
      ["moz-button", "chrome://global/content/elements/moz-button.mjs"],
      ["moz-toggle", "chrome://global/content/elements/moz-toggle.mjs"],
  ]) {
    customElements.setElementCreationCallback(tag, () => {
      ChromeUtils.importESModule(script);
    });
  }
});
`.trimStart();

/**
 * Mock of customElements.js matching the real multi-line DOMContentLoaded format
 * where addEventListener and "DOMContentLoaded" are on separate lines.
 */
const MOCK_MULTILINE_DCL = `
// ... preamble ...

for (let [tag, script] of [
    ["findbar", "chrome://global/content/elements/findbar.js"],
    ["search-textbox", "chrome://global/content/elements/search-textbox.js"],
    ["wizard", "chrome://global/content/elements/wizard.js"],
]) {
  customElements.setElementCreationCallback(tag, () => {
    Services.scriptloader.loadSubScript(script, window);
  });
}

document.addEventListener(
  "DOMContentLoaded",
  () => {
    for (let [tag, script] of [
        ["moz-button", "chrome://global/content/elements/moz-button.mjs"],
        ["moz-toggle", "chrome://global/content/elements/moz-toggle.mjs"],
    ]) {
      customElements.setElementCreationCallback(tag, () => {
        ChromeUtils.importESModule(script);
      });
    }
  }
);
`.trimStart();

/**
 * Mock with multi-line array entries ([ on its own line, "tag", on next line).
 * Used by both format-matching and idempotency tests.
 */
const MOCK_MULTILINE_ENTRIES = `
// ... preamble ...

for (let [tag, script] of [
    ["findbar", "chrome://global/content/elements/findbar.js"],
    ["wizard", "chrome://global/content/elements/wizard.js"],
]) {
  customElements.setElementCreationCallback(tag, () => {
    Services.scriptloader.loadSubScript(script, window);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  for (let [tag, script] of [
          [
            "moz-button",
            "chrome://global/content/elements/moz-button.mjs",
          ],
          [
            "moz-toggle",
            "chrome://global/content/elements/moz-toggle.mjs",
          ],
  ]) {
    customElements.setElementCreationCallback(tag, () => {
      ChromeUtils.importESModule(script);
    });
  }
});
`.trimStart();

/**
 * Mock with only a DOMContentLoaded array (no Pattern A array).
 * Used to verify .js placement validation throws.
 */
const MOCK_DCL_ONLY = `
// ... preamble ...

document.addEventListener("DOMContentLoaded", () => {
  for (let [tag, script] of [
      ["moz-button", "chrome://global/content/elements/moz-button.mjs"],
      ["moz-toggle", "chrome://global/content/elements/moz-toggle.mjs"],
  ]) {
    customElements.setElementCreationCallback(tag, () => {
      ChromeUtils.importESModule(script);
    });
  }
});
`.trimStart();

beforeEach(() => {
  vi.clearAllMocks();
  mockPathExists.mockResolvedValue(true);
});

describe('addCustomElementRegistration', () => {
  it('inserts .mjs entry into the second (ESM) array, not the first', async () => {
    mockReadText.mockResolvedValue(MOCK_CUSTOM_ELEMENTS_JS);

    await addCustomElementRegistration(
      '/engine',
      'moz-dock',
      'chrome://global/content/elements/moz-dock.mjs'
    );

    const call = mockWriteText.mock.calls[0];
    if (!call) throw new Error('expected writeText to be called');
    const written = call[1];

    // Should appear between moz-button and moz-toggle in the second array
    const lines = written.split('\n');
    const dockLine = lines.findIndex((l: string) => l.includes('["moz-dock"'));
    const buttonLine = lines.findIndex((l: string) => l.includes('["moz-button"'));
    const toggleLine = lines.findIndex((l: string) => l.includes('["moz-toggle"'));

    expect(dockLine).toBeGreaterThan(buttonLine);
    expect(dockLine).toBeLessThan(toggleLine);

    // Should NOT appear near the .js array entries
    const findbarLine = lines.findIndex((l: string) => l.includes('["findbar"'));
    const wizardLine = lines.findIndex((l: string) => l.includes('["wizard"'));
    expect(dockLine).toBeGreaterThan(wizardLine);

    // Sanity: the first array is untouched
    expect(findbarLine).toBeGreaterThan(-1);
  });

  it('inserts .js entry into the first (loadSubScript) array', async () => {
    mockReadText.mockResolvedValue(MOCK_CUSTOM_ELEMENTS_JS);

    await addCustomElementRegistration(
      '/engine',
      'my-widget',
      'chrome://global/content/elements/my-widget.js'
    );

    const call = mockWriteText.mock.calls[0];
    if (!call) throw new Error('expected writeText to be called');
    const written = call[1];
    const lines = written.split('\n');

    const widgetLine = lines.findIndex((l: string) => l.includes('["my-widget"'));
    const domContentLine = lines.findIndex((l: string) => l.includes('DOMContentLoaded'));

    // Should be in the first array, before the DOMContentLoaded block
    expect(widgetLine).toBeLessThan(domContentLine);
    // Alphabetically: my-widget < search-textbox, so it goes after findbar
    const findbarLine = lines.findIndex((l: string) => l.includes('["findbar"'));
    const searchLine = lines.findIndex((l: string) => l.includes('["search-textbox"'));
    expect(widgetLine).toBeGreaterThan(findbarLine);
    expect(widgetLine).toBeLessThan(searchLine);
  });

  it('is idempotent — does not duplicate an existing entry', async () => {
    mockReadText.mockResolvedValue(MOCK_CUSTOM_ELEMENTS_JS);

    await addCustomElementRegistration(
      '/engine',
      'moz-button',
      'chrome://global/content/elements/moz-button.mjs'
    );

    // writeText should NOT be called since the tag already exists
    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it('maintains alphabetical order when inserting at the start of the ESM array', async () => {
    mockReadText.mockResolvedValue(MOCK_CUSTOM_ELEMENTS_JS);

    await addCustomElementRegistration(
      '/engine',
      'moz-aaa',
      'chrome://global/content/elements/moz-aaa.mjs'
    );

    const call = mockWriteText.mock.calls[0];
    if (!call) throw new Error('expected writeText to be called');
    const written = call[1];
    const lines = written.split('\n');

    const aaaLine = lines.findIndex((l: string) => l.includes('["moz-aaa"'));
    const buttonLine = lines.findIndex((l: string) => l.includes('["moz-button"'));

    expect(aaaLine).toBeLessThan(buttonLine);
    expect(aaaLine).toBeGreaterThan(-1);
  });

  it('maintains alphabetical order when inserting at the end of the ESM array', async () => {
    mockReadText.mockResolvedValue(MOCK_CUSTOM_ELEMENTS_JS);

    await addCustomElementRegistration(
      '/engine',
      'moz-zzz',
      'chrome://global/content/elements/moz-zzz.mjs'
    );

    const call = mockWriteText.mock.calls[0];
    if (!call) throw new Error('expected writeText to be called');
    const written = call[1];
    const lines = written.split('\n');

    const zzzLine = lines.findIndex((l: string) => l.includes('["moz-zzz"'));
    const toggleLine = lines.findIndex((l: string) => l.includes('["moz-toggle"'));

    expect(zzzLine).toBeGreaterThan(toggleLine);
  });

  it('matches multi-line indentation format of surrounding entries', async () => {
    mockReadText.mockResolvedValue(MOCK_MULTILINE_ENTRIES);

    await addCustomElementRegistration(
      '/engine',
      'moz-custom-widget',
      'chrome://global/content/elements/moz-custom-widget.mjs'
    );

    const call = mockWriteText.mock.calls[0];
    if (!call) throw new Error('expected writeText to be called');
    const written = call[1];
    const lines = written.split('\n');

    // Find the inserted entry — look for the opening bracket line before the tag
    const titlebarTagIdx = lines.findIndex((l: string) => l.includes('"moz-custom-widget"'));
    expect(titlebarTagIdx).toBeGreaterThan(-1);

    // Should be in multi-line format: opening bracket is on the line before
    const entryStart = lines[titlebarTagIdx - 1];
    expect(entryStart?.trimEnd()).toBe('          [');

    // The tag name and module path should be on separate lines with deeper indent
    const tagLine = lines[titlebarTagIdx];
    const uriLine = lines[titlebarTagIdx + 1];
    const closeLine = lines[titlebarTagIdx + 2];

    expect(tagLine).toMatch(/^\s+"moz-custom-widget",$/);
    expect(uriLine).toMatch(/^\s+"chrome:\/\/global\/content\/elements\/moz-custom-widget\.mjs",$/);
    expect(closeLine?.trimEnd()).toBe('          ],');

    // Verify indentation matches the moz-button entry bracket
    const buttonBracketIdx = lines.findIndex((l: string) => {
      const idx = lines.indexOf(l);
      const nextL = lines[idx + 1];
      return l.trimEnd() === '          [' && nextL?.includes('"moz-button"');
    });
    expect(buttonBracketIdx).toBeGreaterThan(-1);
    const buttonIndent = lines[buttonBracketIdx]?.match(/^(\s*)/)?.[1] ?? '';
    const titlebarIndent = entryStart?.match(/^(\s*)/)?.[1] ?? '';
    expect(titlebarIndent).toBe(buttonIndent);
  });

  it('preserves single-line format when entries use single-line style', async () => {
    mockReadText.mockResolvedValue(MOCK_CUSTOM_ELEMENTS_JS);

    await addCustomElementRegistration(
      '/engine',
      'moz-dock',
      'chrome://global/content/elements/moz-dock.mjs'
    );

    const call = mockWriteText.mock.calls[0];
    if (!call) throw new Error('expected writeText to be called');
    const written = call[1];
    const lines = written.split('\n');

    const dockLine = lines.find((l: string) => l.includes('moz-dock'));
    // Should be single-line format matching the existing entries
    expect(dockLine).toMatch(/^\s+\["moz-dock", "chrome:\/\/.*"\],$/);

    // Indentation should match adjacent entries
    const buttonLine = lines.find((l: string) => l.includes('moz-button'));
    const dockIndent = dockLine?.match(/^(\s*)/)?.[1] ?? '';
    const buttonIndent = buttonLine?.match(/^(\s*)/)?.[1] ?? '';
    expect(dockIndent).toBe(buttonIndent);
  });

  it('inserts .mjs entry when DOMContentLoaded is on multiple lines', async () => {
    mockReadText.mockResolvedValue(MOCK_MULTILINE_DCL);

    await addCustomElementRegistration(
      '/engine',
      'moz-dock',
      'chrome://global/content/elements/moz-dock.mjs'
    );

    const call = mockWriteText.mock.calls[0];
    if (!call) throw new Error('expected writeText to be called');
    const written = call[1];

    const lines = written.split('\n');
    const dockLine = lines.findIndex((l: string) => l.includes('["moz-dock"'));
    const buttonLine = lines.findIndex((l: string) => l.includes('["moz-button"'));
    const toggleLine = lines.findIndex((l: string) => l.includes('["moz-toggle"'));

    // Should appear between moz-button and moz-toggle in the ESM array
    expect(dockLine).toBeGreaterThan(buttonLine);
    expect(dockLine).toBeLessThan(toggleLine);

    // Should NOT be in the .js array
    const wizardLine = lines.findIndex((l: string) => l.includes('["wizard"'));
    expect(dockLine).toBeGreaterThan(wizardLine);
  });

  it('is idempotent with multi-line DOMContentLoaded format', async () => {
    mockReadText.mockResolvedValue(MOCK_MULTILINE_DCL);

    await addCustomElementRegistration(
      '/engine',
      'moz-button',
      'chrome://global/content/elements/moz-button.mjs'
    );

    // writeText should NOT be called since the tag already exists
    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it('throws FurnaceError if .mjs entry cannot find DOMContentLoaded block', async () => {
    // Mock a file where no DOMContentLoaded block exists,
    // so the Pattern B lookup fails. This simulates structural changes
    // that could cause mis-placement.
    const brokenContent = `
for (let [tag, script] of [
    ["findbar", "chrome://global/content/elements/findbar.js"],
]) {
  customElements.setElementCreationCallback(tag, () => {
    Services.scriptloader.loadSubScript(script, window);
  });
}

for (let [tag, script] of [
    ["moz-button", "chrome://global/content/elements/moz-button.mjs"],
]) {
  customElements.setElementCreationCallback(tag, () => {
    ChromeUtils.importESModule(script);
  });
}
`.trimStart();

    mockReadText.mockResolvedValue(brokenContent);

    await expect(
      addCustomElementRegistration(
        '/engine',
        'moz-test',
        'chrome://global/content/elements/moz-test.mjs'
      )
    ).rejects.toThrow(FurnaceError);

    await expect(
      addCustomElementRegistration(
        '/engine',
        'moz-test',
        'chrome://global/content/elements/moz-test.mjs'
      )
    ).rejects.toThrow(/DOMContentLoaded/);
  });

  it('is idempotent with multi-line array entries', async () => {
    mockReadText.mockResolvedValue(MOCK_MULTILINE_ENTRIES);

    await addCustomElementRegistration(
      '/engine',
      'moz-button',
      'chrome://global/content/elements/moz-button.mjs'
    );

    // writeText should NOT be called — "moz-button", on its own line should be detected
    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it('throws FurnaceError if .js entry lands in DOMContentLoaded block', async () => {
    mockReadText.mockResolvedValue(MOCK_DCL_ONLY);

    await expect(
      addCustomElementRegistration(
        '/engine',
        'my-widget',
        'chrome://global/content/elements/my-widget.js'
      )
    ).rejects.toThrow(FurnaceError);

    await expect(
      addCustomElementRegistration(
        '/engine',
        'my-widget',
        'chrome://global/content/elements/my-widget.js'
      )
    ).rejects.toThrow(/DOMContentLoaded/);
  });
});

describe('removeCustomElementRegistration', () => {
  it('removes a single-line array entry', async () => {
    mockReadText.mockResolvedValue(MOCK_CUSTOM_ELEMENTS_JS);

    await removeCustomElementRegistration('/engine', 'search-textbox');

    const call = mockWriteText.mock.calls[0];
    if (!call) throw new Error('expected writeText to be called');
    const written = call[1];

    expect(written).not.toContain('search-textbox');
    // Other entries should remain
    expect(written).toContain('findbar');
    expect(written).toContain('wizard');
  });

  it('removes a multi-line array entry', async () => {
    mockReadText.mockResolvedValue(MOCK_MULTILINE_ENTRIES);

    await removeCustomElementRegistration('/engine', 'moz-button');

    const call = mockWriteText.mock.calls[0];
    if (!call) throw new Error('expected writeText to be called');
    const written = call[1];

    expect(written).not.toContain('moz-button');
    // Other entries should remain
    expect(written).toContain('moz-toggle');
    expect(written).toContain('findbar');
  });

  it('removes a standalone callback block', async () => {
    const standaloneContent = `
// preamble
customElements.setElementCreationCallback("my-widget", () => {
  Services.scriptloader.loadSubScript("chrome://global/content/elements/my-widget.js", window);
});

customElements.setElementCreationCallback("other-widget", () => {
  Services.scriptloader.loadSubScript("chrome://global/content/elements/other-widget.js", window);
});
`.trimStart();

    mockReadText.mockResolvedValue(standaloneContent);

    await removeCustomElementRegistration('/engine', 'my-widget');

    const call = mockWriteText.mock.calls[0];
    if (!call) throw new Error('expected writeText to be called');
    const written = call[1];

    expect(written).not.toContain('my-widget');
    expect(written).toContain('other-widget');
  });

  it('is a no-op when tag is not registered', async () => {
    mockReadText.mockResolvedValue(MOCK_CUSTOM_ELEMENTS_JS);

    await removeCustomElementRegistration('/engine', 'nonexistent-tag');

    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it('is a no-op when file does not exist', async () => {
    mockPathExists.mockResolvedValue(false);

    await removeCustomElementRegistration('/engine', 'moz-button');

    expect(mockReadText).not.toHaveBeenCalled();
    expect(mockWriteText).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// computeComponentChecksums
// ---------------------------------------------------------------------------

describe('computeComponentChecksums', () => {
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  function makeDirent(name: string, isFile = true) {
    return {
      name,
      isFile: () => isFile,
      isDirectory: () => !isFile,
      isSymbolicLink: () => false,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      parentPath: '/comp',
      path: '/comp',
    };
  }

  it('checksums deployed component files including localized .ftl assets', async () => {
    mockReaddir.mockResolvedValue([
      makeDirent('widget.mjs'),
      makeDirent('widget.css'),
      makeDirent('widget.ftl'),
      makeDirent('override.json'),
      makeDirent('readme.md'),
      makeDirent('data', false), // directory
    ] as never);
    mockReadText.mockResolvedValue('content');

    const checksums = await computeComponentChecksums('/comp');

    expect(Object.keys(checksums).sort()).toEqual(['widget.css', 'widget.ftl', 'widget.mjs']);
  });

  it('produces consistent checksums regardless of BOM and CRLF', async () => {
    mockReaddir.mockResolvedValue([makeDirent('widget.mjs')] as never);

    // LF content
    mockReadText.mockResolvedValue('line1\nline2\n');
    const lf = await computeComponentChecksums('/comp');

    // CRLF content
    mockReadText.mockResolvedValue('line1\r\nline2\r\n');
    const crlf = await computeComponentChecksums('/comp');

    // BOM + LF content
    mockReadText.mockResolvedValue('\uFEFFline1\nline2\n');
    const bom = await computeComponentChecksums('/comp');

    expect(lf['widget.mjs']).toBe(crlf['widget.mjs']);
    expect(lf['widget.mjs']).toBe(bom['widget.mjs']);
  });
});

// ---------------------------------------------------------------------------
// hasComponentChanged
// ---------------------------------------------------------------------------

describe('hasComponentChanged', () => {
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  function makeDirent(name: string) {
    return {
      name,
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      parentPath: '/comp',
      path: '/comp',
    };
  }

  it('returns false when checksums match', async () => {
    mockReaddir.mockResolvedValue([makeDirent('widget.mjs')] as never);
    mockReadText.mockResolvedValue('content');

    const checksums = await computeComponentChecksums('/comp');
    const changed = await hasComponentChanged('/comp', checksums);

    expect(changed).toBe(false);
  });

  it('returns true when content changes', async () => {
    mockReaddir.mockResolvedValue([makeDirent('widget.mjs')] as never);
    mockReadText.mockResolvedValueOnce('content-v1');
    const checksums = await computeComponentChecksums('/comp');

    mockReadText.mockResolvedValueOnce('content-v2');
    const changed = await hasComponentChanged('/comp', checksums);

    expect(changed).toBe(true);
  });

  it('returns true when a file is added', async () => {
    mockReaddir.mockResolvedValueOnce([makeDirent('widget.mjs')] as never);
    mockReadText.mockResolvedValue('content');
    const checksums = await computeComponentChecksums('/comp');

    mockReaddir.mockResolvedValueOnce([makeDirent('widget.mjs'), makeDirent('extra.css')] as never);
    const changed = await hasComponentChanged('/comp', checksums);

    expect(changed).toBe(true);
  });

  it('returns true when only a localized .ftl file changes', async () => {
    mockReaddir.mockResolvedValue([makeDirent('widget.mjs'), makeDirent('widget.ftl')] as never);
    mockReadText.mockResolvedValueOnce('component');
    mockReadText.mockResolvedValueOnce('label = Old');
    const checksums = await computeComponentChecksums('/comp');

    mockReadText.mockResolvedValueOnce('component');
    mockReadText.mockResolvedValueOnce('label = New');
    const changed = await hasComponentChanged('/comp', checksums);

    expect(changed).toBe(true);
  });
});
