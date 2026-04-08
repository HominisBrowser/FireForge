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
import { addDestroyAST, addDestroyToBrowserInit, legacyAddDestroy } from '../wire-destroy.js';

const BASE_BROWSER_INIT = `
const gBrowserInit = {
  onUnload() {
    // ExistingThing destroy
    try {
      if (typeof ExistingThing !== "undefined") {
        ExistingThing.destroy();
      }
    } catch (e) {
      console.error("ExistingThing destroy failed:", e);
    }

    FirefoxCleanup.shutdown();
  },
};
`.trim();

describe('wire-destroy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    parserFallbackMock.mockImplementation((primary: () => string) => ({ value: primary() }));
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readText).mockResolvedValue(BASE_BROWSER_INIT);
    vi.mocked(writeText).mockResolvedValue(undefined);
  });

  // --- addDestroyAST ---

  it('inserts a destroy block at the top of onUnload (LIFO)', () => {
    const updated = addDestroyAST(BASE_BROWSER_INIT, 'DockController.destroy()');

    expect(updated.indexOf('DockController.destroy();')).toBeLessThan(
      updated.indexOf('ExistingThing.destroy();')
    );
    expect(updated).toContain('// DockController destroy');
    expect(updated).toContain('if (typeof DockController !== "undefined")');
  });

  it('wraps the expression in a try-catch guard', () => {
    const updated = addDestroyAST(BASE_BROWSER_INIT, 'DockController.destroy()');

    expect(updated).toContain('} catch (e) {');
    expect(updated).toContain('console.error("DockController destroy failed:", e);');
  });

  it('inserts at the top of an empty onUnload body', () => {
    const content = `
const gBrowserInit = {
  onUnload() {}
};
`.trim();

    const updated = addDestroyAST(content, 'DockController.destroy()');
    expect(updated).toContain('DockController.destroy();');
  });

  it('works with uninit() method name', () => {
    const content = `
const gBrowserInit = {
  uninit() {
    FirefoxCleanup.shutdown();
  },
};
`.trim();

    const updated = addDestroyAST(content, 'SidebarPanel.destroy()');
    expect(updated.indexOf('SidebarPanel.destroy();')).toBeLessThan(
      updated.indexOf('FirefoxCleanup.shutdown();')
    );
  });

  it('throws when onUnload/uninit cannot be found via AST', () => {
    expect(() => addDestroyAST('const bootstrap = {};', 'DockController.destroy()')).toThrow(
      'Could not find onUnload/uninit method body via AST'
    );
  });

  // --- legacyAddDestroy ---

  it('legacy insertion places destroy block at top of onUnload', () => {
    const updated = legacyAddDestroy(BASE_BROWSER_INIT, 'DockController.destroy()');

    expect(updated.indexOf('DockController.destroy();')).toBeLessThan(
      updated.indexOf('ExistingThing.destroy();')
    );
    expect(updated).toContain('// DockController destroy');
  });

  it('legacy insertion throws when onUnload is absent', () => {
    expect(() => legacyAddDestroy('const nope = {};', 'DockController.destroy()')).toThrow(
      'Could not find "onUnload" or "uninit" method'
    );
  });

  it('legacy insertion works with uninit() method', () => {
    const content = `
const gBrowserInit = {
  uninit() {
    FirefoxCleanup.shutdown();
  },
};
`.trim();

    const updated = legacyAddDestroy(content, 'SidebarPanel.destroy()');
    expect(updated.indexOf('SidebarPanel.destroy();')).toBeLessThan(
      updated.indexOf('FirefoxCleanup.shutdown();')
    );
  });

  // --- addDestroyToBrowserInit (async) ---

  it('throws when browser-init.js is missing', async () => {
    vi.mocked(pathExists).mockResolvedValue(false);

    await expect(addDestroyToBrowserInit('/engine', 'DockController.destroy()')).rejects.toThrow(
      'browser/base/content/browser-init.js not found in engine'
    );
  });

  it('returns false when the destroy expression is already present', async () => {
    vi.mocked(readText).mockResolvedValue(`${BASE_BROWSER_INIT}\nDockController.destroy();\n`);

    await expect(addDestroyToBrowserInit('/engine', 'DockController.destroy()')).resolves.toBe(
      false
    );
    expect(writeText).not.toHaveBeenCalled();
  });

  it('returns true and writes the file when the expression is new', async () => {
    await expect(addDestroyToBrowserInit('/engine', 'DockController.destroy()')).resolves.toBe(
      true
    );
    expect(writeText).toHaveBeenCalledWith(
      '/engine/browser/base/content/browser-init.js',
      expect.stringContaining('DockController.destroy();')
    );
  });

  it('writes the legacy fallback result when parser fallback selects it', async () => {
    parserFallbackMock.mockImplementation((primary: () => string, ...rest: unknown[]) => {
      void primary;
      const fallback = rest[0] as (() => string) | undefined;
      return { value: fallback ? fallback() : primary() };
    });

    await expect(addDestroyToBrowserInit('/engine', 'DockController.destroy()')).resolves.toBe(
      true
    );
    expect(writeText).toHaveBeenCalledWith(
      '/engine/browser/base/content/browser-init.js',
      expect.stringContaining('DockController.destroy();')
    );
  });

  it('does not match a substring for idempotency (word-boundary check)', async () => {
    // "Thing.destroy()" is present, but "OtherThing.destroy()" should NOT match
    await expect(addDestroyToBrowserInit('/engine', 'OtherThing.destroy()')).resolves.toBe(true);
  });
});
