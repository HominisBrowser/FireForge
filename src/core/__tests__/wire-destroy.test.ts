// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFsMock } from '../../test-utils/module-mocks.js';

const parserFallbackMock = vi.hoisted(() =>
  vi.fn((primary: () => string, ...rest: unknown[]) => {
    void rest;
    return { value: primary() };
  })
);

vi.mock('../../utils/fs.js', () => createFsMock());

vi.mock('../parser-fallback.js', async (importOriginal) => ({
  // Pure logic with no side effects. Only `withParserFallback` needs
  // controlling here.
  ...(await importOriginal<typeof import('../parser-fallback.js')>()),
  withParserFallback: parserFallbackMock,
}));

import { nativePath } from '../../test-utils/index.js';
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
    expect(updated).toContain('// FIREFORGE: wire-destroy DockController');
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
    expect(updated).toContain('// FIREFORGE: wire-destroy DockController');
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
      nativePath('/engine/browser/base/content/browser-init.js'),
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
      nativePath('/engine/browser/base/content/browser-init.js'),
      expect.stringContaining('DockController.destroy();')
    );
  });

  it('does not match a substring for idempotency (word-boundary check)', async () => {
    // "Thing.destroy()" is present, but "OtherThing.destroy()" should not match
    await expect(addDestroyToBrowserInit('/engine', 'OtherThing.destroy()')).resolves.toBe(true);
  });

  it('coerces a bare property chain into a function call (AST path)', () => {
    // `X.destroy` must invoke, not just reference: `addDestroyAST` appends
    // `()` when the caller passed a bare property chain.
    const updated = addDestroyAST(BASE_BROWSER_INIT, 'EvalStartup.destroy');
    expect(updated).toContain('EvalStartup.destroy();');
    expect(updated).not.toMatch(/EvalStartup\.destroy;[^(]/);
  });

  it('preserves an explicit function-call expression without double-parens (AST path)', () => {
    const updated = addDestroyAST(BASE_BROWSER_INIT, 'EvalStartup.destroy()');
    expect(updated).toContain('EvalStartup.destroy();');
    expect(updated).not.toContain('EvalStartup.destroy()();');
  });

  it('coerces a bare property chain into a function call (legacy path)', () => {
    const updated = legacyAddDestroy(BASE_BROWSER_INIT, 'EvalStartup.destroy');
    expect(updated).toContain('EvalStartup.destroy();');
    expect(updated).not.toMatch(/EvalStartup\.destroy;[^(]/);
  });

  it('idempotency check recognises a previously coerced call when re-running with the bare form', async () => {
    vi.mocked(readText).mockResolvedValue(`${BASE_BROWSER_INIT}\n    EvalStartup.destroy();\n`);

    await expect(addDestroyToBrowserInit('/engine', 'EvalStartup.destroy')).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });
});
