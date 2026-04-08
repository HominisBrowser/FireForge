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
import { addInitAST, addInitToBrowserInit, legacyAddInit } from '../wire-init.js';

const BASE_BROWSER_INIT = `
const gBrowserInit = {
  onLoad() {
    try {
      if (typeof ExistingInit !== "undefined") {
        ExistingInit.init();
      }
    } catch (e) {
      console.error("ExistingInit init failed:", e);
    }

    FirefoxInit.init();
  },
};
`.trim();

describe('wire-init', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    parserFallbackMock.mockImplementation((primary: () => string) => ({ value: primary() }));
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readText).mockResolvedValue(BASE_BROWSER_INIT);
    vi.mocked(writeText).mockResolvedValue(undefined);
  });

  it('inserts a new init after an existing fireforge block when requested', () => {
    const updated = addInitAST(BASE_BROWSER_INIT, 'DockController.init()', 'ExistingInit');

    expect(updated.indexOf('ExistingInit.init();')).toBeLessThan(
      updated.indexOf('DockController.init();')
    );
    expect(updated.indexOf('DockController.init();')).toBeLessThan(
      updated.indexOf('FirefoxInit.init();')
    );
    expect(updated).toContain('// DockController init');
  });

  it('falls back to the last fireforge block when the requested --after target is missing', () => {
    const updated = addInitAST(BASE_BROWSER_INIT, 'DockController.init()', 'MissingInit');

    expect(updated.indexOf('ExistingInit.init();')).toBeLessThan(
      updated.indexOf('DockController.init();')
    );
    expect(updated.indexOf('DockController.init();')).toBeLessThan(
      updated.indexOf('FirefoxInit.init();')
    );
  });

  it('defaults to inserting after the last fireforge block when no --after target is supplied', () => {
    const updated = addInitAST(BASE_BROWSER_INIT, 'DockController.init()');

    expect(updated.indexOf('ExistingInit.init();')).toBeLessThan(
      updated.indexOf('DockController.init();')
    );
    expect(updated.indexOf('DockController.init();')).toBeLessThan(
      updated.indexOf('FirefoxInit.init();')
    );
  });

  it('throws when onLoad cannot be found via AST', () => {
    expect(() => addInitAST('const bootstrap = {};', 'DockController.init()')).toThrow(
      'Could not find onLoad method body via AST'
    );
  });

  it('handles a missing --after target when there are no fireforge blocks and no statements', () => {
    const content = `
const gBrowserInit = {
  onLoad() {}
};
`.trim();

    const updated = addInitAST(content, 'DockController.init()', 'MissingInit');
    expect(updated).toContain('DockController.init();');
  });

  it('handles a missing --after target when there are no fireforge blocks but there is a first statement', () => {
    const content = `
const gBrowserInit = {
  onLoad() {
    FirefoxInit.init();
  },
};
`.trim();

    const updated = addInitAST(content, 'DockController.init()', 'MissingInit');
    expect(updated.indexOf('DockController.init();')).toBeLessThan(
      updated.indexOf('FirefoxInit.init();')
    );
  });

  it('inserts at the top of onLoad when there are no existing fireforge blocks', () => {
    const content = `
const gBrowserInit = {
  onLoad() {
    FirefoxInit.init();
  },
};
`.trim();

    const updated = addInitAST(content, 'DockController.init()');
    expect(updated.indexOf('DockController.init();')).toBeLessThan(
      updated.indexOf('FirefoxInit.init();')
    );
  });

  it('ignores non-fireforge try blocks when choosing the AST insertion point', () => {
    const content = `
const gBrowserInit = {
  onLoad() {
    try {
      FirefoxInit.init();
    } catch (e) {
      console.error(e);
    }
  },
};
`.trim();

    const updated = addInitAST(content, 'DockController.init()');
    expect(updated.indexOf('DockController.init();')).toBeLessThan(
      updated.indexOf('FirefoxInit.init();')
    );
  });

  it('handles an empty onLoad body when no --after target is supplied', () => {
    const content = `
const gBrowserInit = {
  onLoad() {}
};
`.trim();

    const updated = addInitAST(content, 'DockController.init()');
    expect(updated).toContain('DockController.init();');
  });

  it('legacy insertion falls back to the default placement when the --after target is missing', () => {
    const updated = legacyAddInit(BASE_BROWSER_INIT, 'DockController.init()', 'MissingInit');

    expect(updated.indexOf('DockController.init();')).toBeLessThan(
      updated.indexOf('FirefoxInit.init();')
    );
    expect(updated).toContain('DockController init');
  });

  it('legacy insertion recognizes a commented try block when inserting after a target', () => {
    const content = `
const gBrowserInit = {
  onLoad() {
    // ExistingInit init guard
    try {
      if (typeof ExistingInit !== "undefined") {
        ExistingInit.init();
      }
    } catch (e) {
      console.error("ExistingInit init failed:", e);
    }

    FirefoxInit.init();
  },
};
`.trim();

    const updated = legacyAddInit(content, 'DockController.init()', 'ExistingInit');
    expect(updated.indexOf('ExistingInit.init();')).toBeLessThan(
      updated.indexOf('DockController.init();')
    );
    expect(updated.indexOf('DockController.init();')).toBeLessThan(
      updated.indexOf('FirefoxInit.init();')
    );
  });

  it('legacy insertion recognizes a plain try block when inserting after a target init call', () => {
    const content = `
const gBrowserInit = {
  onLoad() {
    try {
      ExistingInit.init();
    } catch (e) {
      console.error("ExistingInit init failed:", e);
    }

    FirefoxInit.init();
  },
};
`.trim();

    const updated = legacyAddInit(content, 'DockController.init()', 'ExistingInit');
    expect(updated.indexOf('ExistingInit.init();')).toBeLessThan(
      updated.indexOf('DockController.init();')
    );
    expect(updated.indexOf('DockController.init();')).toBeLessThan(
      updated.indexOf('FirefoxInit.init();')
    );
  });

  it('legacy insertion scans upward through non-try lines before finding the target block', () => {
    const content = `
const gBrowserInit = {
  onLoad() {
    try {
      const ready = true;
      ExistingInit.init();
    } catch (e) {
      console.error("ExistingInit init failed:", e);
    }

    FirefoxInit.init();
  },
};
`.trim();

    const updated = legacyAddInit(content, 'DockController.init()', 'ExistingInit');
    expect(updated.indexOf('ExistingInit.init();')).toBeLessThan(
      updated.indexOf('DockController.init();')
    );
    expect(updated.indexOf('DockController.init();')).toBeLessThan(
      updated.indexOf('FirefoxInit.init();')
    );
  });

  it('legacy insertion throws when onLoad is absent', () => {
    expect(() => legacyAddInit('const nope = {};', 'DockController.init()')).toThrow(
      'Could not find "onLoad" method'
    );
  });

  it('throws when browser-init.js is missing', async () => {
    vi.mocked(pathExists).mockResolvedValue(false);

    await expect(addInitToBrowserInit('/engine', 'DockController.init()')).rejects.toThrow(
      'browser/base/content/browser-init.js not found in engine'
    );
  });

  it('returns false when the init expression is already present', async () => {
    vi.mocked(readText).mockResolvedValue(`${BASE_BROWSER_INIT}\nDockController.init();\n`);

    await expect(addInitToBrowserInit('/engine', 'DockController.init()')).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('writes the legacy fallback result when parser fallback selects it', async () => {
    parserFallbackMock.mockImplementation((primary: () => string, ...rest: unknown[]) => {
      void primary;
      const fallback = rest[0] as (() => string) | undefined;
      return { value: fallback ? fallback() : primary() };
    });

    await expect(addInitToBrowserInit('/engine', 'DockController.init()')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith(
      '/engine/browser/base/content/browser-init.js',
      expect.stringContaining('DockController.init();')
    );
  });
});
