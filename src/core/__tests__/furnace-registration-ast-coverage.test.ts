// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFsMock } from '../../test-utils/module-mocks.js';

vi.mock('../../utils/fs.js', () => createFsMock());

import { FurnaceError } from '../../errors/furnace.js';
import { pathExists, readText, writeText } from '../../utils/fs.js';
import {
  addCustomElementRegistration,
  validateCustomElementRegistration,
} from '../furnace-registration-ast.js';

const CUSTOM_ELEMENTS_JS = `
for (let [tag, script] of [
    ["findbar", "chrome://global/content/elements/findbar.js"],
]) {
  customElements.setElementCreationCallback(tag, () => {
    Services.scriptloader.loadSubScript(script, window);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  for (let [tag, script] of [
      ["moz-button", "chrome://global/content/elements/moz-button.mjs"],
  ]) {
    customElements.setElementCreationCallback(tag, () => {
      ChromeUtils.importESModule(script);
    });
  }
});
`.trim();

const MULTILINE_CUSTOM_ELEMENTS_JS = `
for (let [tag, script] of [
  [
    "findbar",
    "chrome://global/content/elements/findbar.js",
  ],
]) {
}

document.addEventListener("DOMContentLoaded", () => {
  for (let [tag, script] of [
    [
      "moz-button",
      "chrome://global/content/elements/moz-button.mjs",
    ],
  ]) {
  }
});
`.trim();

const EMPTY_ARRAYS_CUSTOM_ELEMENTS_JS = `
for (let [tag, script] of []) {
  customElements.setElementCreationCallback(tag, () => {
    Services.scriptloader.loadSubScript(script, window);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  for (let [tag, script] of []) {
    customElements.setElementCreationCallback(tag, () => {
      ChromeUtils.importESModule(script);
    });
  }
});
`.trim();

describe('furnace registration AST coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readText).mockResolvedValue(CUSTOM_ELEMENTS_JS);
    vi.mocked(writeText).mockResolvedValue(undefined);
  });

  it('throws when customElements.js is missing', async () => {
    vi.mocked(pathExists).mockResolvedValue(false);

    await expect(
      addCustomElementRegistration(
        '/engine',
        'moz-dock',
        'chrome://global/content/elements/moz-dock.mjs'
      )
    ).rejects.toThrow('customElements.js not found in engine');
  });

  it('treats standalone callback registrations as already registered', async () => {
    vi.mocked(readText).mockResolvedValue(
      'lazy.customElements.setElementCreationCallback("moz-dock", () => {});'
    );

    await expect(
      addCustomElementRegistration(
        '/engine',
        'moz-dock',
        'chrome://global/content/elements/moz-dock.mjs'
      )
    ).resolves.toBeUndefined();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('adds .js registrations through the AST path', async () => {
    await addCustomElementRegistration(
      '/engine',
      'dock-controller',
      'chrome://global/content/elements/dock-controller.js'
    );

    expect(writeText).toHaveBeenCalledWith(
      '/engine/toolkit/content/customElements.js',
      expect.stringContaining('dock-controller.js')
    );
  });

  it('preserves multi-line entry formatting for AST insertions', async () => {
    vi.mocked(readText).mockResolvedValue(MULTILINE_CUSTOM_ELEMENTS_JS);

    await addCustomElementRegistration(
      '/engine',
      'moz-dock',
      'chrome://global/content/elements/moz-dock.mjs'
    );

    expect(writeText).toHaveBeenCalledWith(
      '/engine/toolkit/content/customElements.js',
      expect.stringContaining('      "moz-dock",')
    );
  });

  it('fails fast when no recognizable registration loop is present', async () => {
    vi.mocked(readText).mockResolvedValue(
      `document.addEventListener("DOMContentLoaded", () => {\n  for (let [a] of !@#$) {\n});\n`
    );

    const error = await addCustomElementRegistration(
      '/engine',
      'moz-dock',
      'chrome://global/content/elements/moz-dock.mjs'
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FurnaceError);
    expect((error as FurnaceError).message).toContain('recognizable registration loop');
  });

  it('inserts into an empty registration array when no reference entry exists', async () => {
    vi.mocked(readText).mockResolvedValue(EMPTY_ARRAYS_CUSTOM_ELEMENTS_JS);

    await addCustomElementRegistration(
      '/engine',
      'moz-dock',
      'chrome://global/content/elements/moz-dock.mjs'
    );

    expect(writeText).toHaveBeenCalledWith(
      '/engine/toolkit/content/customElements.js',
      expect.stringContaining('["moz-dock", "chrome://global/content/elements/moz-dock.mjs"]')
    );
  });
});

describe('validateCustomElementRegistration coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readText).mockResolvedValue(CUSTOM_ELEMENTS_JS);
  });

  it('throws when customElements.js is missing', async () => {
    vi.mocked(pathExists).mockResolvedValue(false);

    await expect(
      validateCustomElementRegistration(
        '/engine',
        'moz-dock',
        'chrome://global/content/elements/moz-dock.mjs'
      )
    ).rejects.toThrow('customElements.js not found in engine');
  });

  it('treats existing registrations as valid without mutating', async () => {
    vi.mocked(readText).mockResolvedValue(
      '["moz-dock", "chrome://global/content/elements/moz-dock.mjs"]'
    );

    await expect(
      validateCustomElementRegistration(
        '/engine',
        'moz-dock',
        'chrome://global/content/elements/moz-dock.mjs'
      )
    ).resolves.toBeUndefined();
  });

  it('rejects recognizable files with no registration loop', async () => {
    vi.mocked(readText).mockResolvedValue(
      'document.addEventListener("DOMContentLoaded", () => {});'
    );

    await expect(
      validateCustomElementRegistration(
        '/engine',
        'moz-dock',
        'chrome://global/content/elements/moz-dock.mjs'
      )
    ).rejects.toThrow(/recognizable registration loop/);
  });

  it('allows legacy .js registration without a DOMContentLoaded block', async () => {
    vi.mocked(readText).mockResolvedValue(
      'for (let [tag, script] of [["findbar", "chrome://global/content/elements/findbar.js"]]) {}'
    );

    await expect(
      validateCustomElementRegistration(
        '/engine',
        'dock-controller',
        'chrome://global/content/elements/dock-controller.js'
      )
    ).resolves.toBeUndefined();
  });
});
