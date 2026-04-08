// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

const parserFallbackMock = vi.hoisted(() =>
  vi.fn((primary: () => string, ...rest: unknown[]) => {
    void rest;
    return { value: primary() };
  })
);

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
  readText: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock('../parser-fallback.js', () => ({
  withParserFallback: parserFallbackMock,
}));

import { pathExists, readText, writeText } from '../../utils/fs.js';
import {
  addSubscriptAST,
  addSubscriptToBrowserMain,
  legacyAddSubscript,
} from '../wire-subscript.js';

const BASE_BROWSER_MAIN = `
function bootstrapBrowser() {
  try {
    Services.scriptloader.loadSubScript("chrome://browser/content/existing.js", this);
  } catch (e) {
    console.error("Failed to load existing.js:", e);
  }

  finishInit();
}
`.trim();

describe('wire-subscript', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    parserFallbackMock.mockImplementation((primary: () => string) => ({ value: primary() }));
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readText).mockResolvedValue(BASE_BROWSER_MAIN);
    vi.mocked(writeText).mockResolvedValue(undefined);
  });

  it('inserts a subscript after the last loadSubScript try block', () => {
    const updated = addSubscriptAST(BASE_BROWSER_MAIN, 'dock-controller');

    expect(updated.indexOf('existing.js')).toBeLessThan(updated.indexOf('dock-controller.js'));
    expect(updated.indexOf('dock-controller.js')).toBeLessThan(updated.indexOf('finishInit();'));
  });

  it('inserts before the final closing brace when there is no existing loadSubScript block', () => {
    const content = `
function bootstrapBrowser() {
  finishInit();
}
`.trim();

    const updated = addSubscriptAST(content, 'dock-controller');
    expect(updated.indexOf('dock-controller.js')).toBeLessThan(updated.lastIndexOf('}'));
  });

  it('throws when there is no closing brace to anchor insertion', () => {
    expect(() => addSubscriptAST('const broken = "{";', 'dock-controller')).toThrow(
      'Could not find closing brace in browser-main.js'
    );
  });

  it('legacy insertion handles files without an existing try block', () => {
    const content = `
function bootstrapBrowser() {
  finishInit();
}
`.trim();

    const updated = legacyAddSubscript(content, 'dock-controller');
    expect(updated).toContain('dock-controller.js');
  });

  it('legacy insertion appends after a standalone loadSubScript line when no try block exists', () => {
    const content = `
function bootstrapBrowser() {
  Services.scriptloader.loadSubScript("chrome://browser/content/existing.js", this);
  finishInit();
}
`.trim();

    const updated = legacyAddSubscript(content, 'dock-controller');
    expect(updated.indexOf('existing.js')).toBeLessThan(updated.indexOf('dock-controller.js'));
  });

  it('throws when browser-main.js is missing', async () => {
    vi.mocked(pathExists).mockResolvedValue(false);

    await expect(addSubscriptToBrowserMain('/engine', 'dock-controller')).rejects.toThrow(
      'browser/base/content/browser-main.js not found in engine'
    );
  });

  it('returns false when the subscript is already present', async () => {
    vi.mocked(readText).mockResolvedValue(`${BASE_BROWSER_MAIN}\ncontent/dock-controller.js"\n`);

    await expect(addSubscriptToBrowserMain('/engine', 'dock-controller')).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('writes the legacy fallback result when parser fallback selects it', async () => {
    parserFallbackMock.mockImplementation((primary: () => string, ...rest: unknown[]) => {
      void primary;
      const fallback = rest[0] as (() => string) | undefined;
      return { value: fallback ? fallback() : primary() };
    });

    await expect(addSubscriptToBrowserMain('/engine', 'dock-controller')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith(
      '/engine/browser/base/content/browser-main.js',
      expect.stringContaining('dock-controller.js')
    );
  });
});
