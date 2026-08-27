// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFsMock } from '../../test-utils/module-mocks.js';

// Mirrors the real `withParserFallback` contract (primary → rethrowIf →
// fallback) so tests exercise the `rethrowIf` predicate rather than a stub
// that can never reach it.
const parserFallbackMock = vi.hoisted(() =>
  vi.fn(
    (
      primary: () => string,
      fallback: () => string,
      _context: string,
      rethrowIf?: (error: unknown) => boolean
    ) => {
      try {
        return { value: primary(), usedFallback: false };
      } catch (error: unknown) {
        if (rethrowIf?.(error)) throw error;
        return { value: fallback(), usedFallback: true };
      }
    }
  )
);

vi.mock('../../utils/fs.js', () => createFsMock());

vi.mock('../parser-fallback.js', async (importOriginal) => ({
  // Pure logic with no side effects; only `withParserFallback` needs
  // controlling here.
  ...(await importOriginal<typeof import('../parser-fallback.js')>()),
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
    parserFallbackMock.mockImplementation((primary, fallback, _context, rethrowIf) => {
      try {
        return { value: primary(), usedFallback: false };
      } catch (error: unknown) {
        if (rethrowIf?.(error)) throw error;
        return { value: fallback(), usedFallback: true };
      }
    });
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
    parserFallbackMock.mockImplementation((primary, fallback) => {
      void primary;
      return { value: fallback(), usedFallback: true };
    });

    await expect(addSubscriptToBrowserMain('/engine', 'dock-controller')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith(
      '/engine/browser/base/content/browser-main.js',
      expect.stringContaining('dock-controller.js')
    );
  });

  it('falls back to the legacy scanner when acorn cannot parse the source', async () => {
    // Firefox chrome sources carry preprocessor directives acorn rejects.
    // That raw SyntaxError is exactly what the legacy path exists for, so the
    // `rethrowIf` predicate must let it through to the fallback.
    vi.mocked(readText).mockResolvedValue(
      ['#ifdef XP_WIN', 'function bootstrapBrowser() {', '  try {', '  } catch (e) {}', '}'].join(
        '\n'
      )
    );

    await expect(addSubscriptToBrowserMain('/engine', 'my-widget')).resolves.toBe(true);
    expect(parserFallbackMock).toHaveBeenCalled();
    expect(writeText).toHaveBeenCalled();
  });
});
