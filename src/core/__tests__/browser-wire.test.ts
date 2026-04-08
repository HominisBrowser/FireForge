// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { wireSubscript } from '../browser-wire.js';
import { addDomFragmentTokenized, legacyAddDomFragment } from '../wire-dom-fragment.js';
import {
  addDestroyToBrowserInit,
  addDomFragment,
  addInitToBrowserInit,
  addSubscriptToBrowserMain,
} from '../wire-targets.js';

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
  readText: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock('../config.js', () => ({
  getProjectPaths: vi.fn(() => ({
    root: '/project',
    engine: '/project/engine',
    config: '/project/fireforge.json',
    fireforgeDir: '/project/.fireforge',
    state: '/project/.fireforge/state.json',
    patches: '/project/patches',
    configs: '/project/configs',
    src: '/project/src',
    componentsDir: '/project/components',
  })),
}));

vi.mock('../manifest-register.js', () => ({
  registerBrowserContent: vi.fn(() => ({
    manifest: 'browser/base/jar.mn',
    entry: '        content/browser/custom-widget.js    (content/custom-widget.js)',
    skipped: false,
  })),
}));

vi.mock('../../utils/logger.js', () => ({
  warn: vi.fn(),
}));

import { pathExists, readText, writeText } from '../../utils/fs.js';
import { warn } from '../../utils/logger.js';

const mockPathExists = vi.mocked(pathExists);
const mockReadText = vi.mocked(readText);
const mockWriteText = vi.mocked(writeText);
const mockWarn = vi.mocked(warn);

beforeEach(() => {
  vi.clearAllMocks();
  mockPathExists.mockResolvedValue(true);
});

// ---------------------------------------------------------------------------
// addSubscriptToBrowserMain
// ---------------------------------------------------------------------------

describe('addSubscriptToBrowserMain', () => {
  const MOCK_BROWSER_MAIN = `{
  try {
    Services.scriptloader.loadSubScript("chrome://browser/content/browser-places.js", this);
  } catch (e) {
    console.error("Failed to load browser-places.js:", e);
  }
}`;

  it('inserts loadSubScript with try/catch after last existing try/catch block', async () => {
    mockReadText.mockResolvedValue(MOCK_BROWSER_MAIN);

    const result = await addSubscriptToBrowserMain('/engine', 'custom-widget');

    expect(result).toBe(true);
    expect(mockWriteText).toHaveBeenCalled();

    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    expect(written).toContain('loadSubScript("chrome://browser/content/custom-widget.js"');
    expect(written).toContain('console.error("Failed to load custom-widget.js:"');

    // Should be after the existing loadSubScript block, not inside its catch body
    const placesIdx = written.indexOf('browser-places.js');
    const canvasIdx = written.indexOf('custom-widget.js');
    expect(canvasIdx).toBeGreaterThan(placesIdx);

    // The new try block must appear AFTER the closing `}` of the existing catch block
    const lines = written.split('\n');
    const catchLine = lines.findIndex((l: string) =>
      l.includes('Failed to load browser-places.js')
    );
    const newTryLine = lines.findIndex((l: string) => l.includes('custom-widget.js'));
    // There must be a `}` closing the catch block between them
    const closingBrace = lines.findIndex(
      (l: string, idx: number) => idx > catchLine && idx < newTryLine && l.trim() === '}'
    );
    expect(closingBrace).toBeGreaterThan(catchLine);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('inserts third subscript after the second try/catch block', async () => {
    const twoSubscripts = `{
  try {
    Services.scriptloader.loadSubScript("chrome://browser/content/browser-places.js", this);
  } catch (e) {
    console.error("Failed to load browser-places.js:", e);
  }
  try {
    Services.scriptloader.loadSubScript("chrome://browser/content/custom-widget.js", this);
  } catch (e) {
    console.error("Failed to load custom-widget.js:", e);
  }
}`;
    mockReadText.mockResolvedValue(twoSubscripts);

    const result = await addSubscriptToBrowserMain('/engine', 'custom-widget-pan');

    expect(result).toBe(true);
    const written = mockWriteText.mock.calls[0]?.[1] ?? '';

    // custom-widget-pan should come after custom-widget's catch block closes
    const canvasCatchIdx = written.indexOf('Failed to load custom-widget.js');
    const panIdx = written.indexOf('custom-widget-pan.js');
    expect(panIdx).toBeGreaterThan(canvasCatchIdx);

    // The new block must be its own try/catch, not inside an existing one
    const lines = written.split('\n');
    const panLine = lines.findIndex((l: string) => l.includes('custom-widget-pan.js'));
    const precedingLine = lines[panLine - 1]?.trim(); // try {
    expect(precedingLine).toBe('try {');
  });

  it('is idempotent — skips if already present', async () => {
    mockReadText.mockResolvedValue(
      MOCK_BROWSER_MAIN +
        '\n  try { loadSubScript("chrome://browser/content/custom-widget.js"); } catch (e) {}'
    );

    const result = await addSubscriptToBrowserMain('/engine', 'custom-widget');

    expect(result).toBe(false);
    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it('throws when browser-main.js is missing', async () => {
    mockPathExists.mockResolvedValue(false);

    await expect(addSubscriptToBrowserMain('/engine', 'test')).rejects.toThrow(
      'browser-main.js not found'
    );
  });
});

// ---------------------------------------------------------------------------
// addInitToBrowserInit
// ---------------------------------------------------------------------------

describe('addInitToBrowserInit', () => {
  const MOCK_BROWSER_INIT = `var gBrowserInit = {
  onLoad() {
    gBrowser.init();
    delayedStartupPromise = new Promise(resolve => {
  },
};`;

  it('inserts init expression as first statement in onLoad()', async () => {
    mockReadText.mockResolvedValue(MOCK_BROWSER_INIT);

    const result = await addInitToBrowserInit('/engine', 'CustomWidget.init()');

    expect(result).toBe(true);
    expect(mockWriteText).toHaveBeenCalled();

    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    expect(written).toContain('CustomWidget init');
    expect(written).toContain('typeof CustomWidget !== "undefined"');
    expect(written).toContain('CustomWidget.init();');

    // Init should appear before gBrowser.init()
    const customIdx = written.indexOf('CustomWidget.init()');
    const gBrowserIdx = written.indexOf('gBrowser.init()');
    expect(customIdx).toBeLessThan(gBrowserIdx);
  });

  it('is idempotent — skips if expression already present', async () => {
    const content = MOCK_BROWSER_INIT.replace(
      'gBrowser.init();',
      'CustomWidget.init();\n    gBrowser.init();'
    );
    mockReadText.mockResolvedValue(content);

    const result = await addInitToBrowserInit('/engine', 'CustomWidget.init()');

    expect(result).toBe(false);
    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it('throws when browser-init.js is missing', async () => {
    mockPathExists.mockResolvedValue(false);

    await expect(addInitToBrowserInit('/engine', 'CustomWidget.init()')).rejects.toThrow(
      'browser-init.js not found in engine'
    );
  });

  it('falls back to the legacy init inserter with an explicit warning when AST parsing fails', async () => {
    mockReadText.mockResolvedValue(`${MOCK_BROWSER_INIT}\n# invalid js for acorn\n`);

    const result = await addInitToBrowserInit('/engine', 'CustomWidget.init()');

    expect(result).toBe(true);
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('falling back to legacy'));
    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    expect(written).toContain('CustomWidget.init();');
  });

  it('inserts second second subscript after first (without --after)', async () => {
    const contentWithTile = `var gBrowserInit = {
  onLoad() {
    // TileManager init — must be first, before Firefox subsystem
    // inits that reference native UI elements we hide.
    try {
      if (typeof TileManager !== "undefined") {
        TileManager.init();
      }
    } catch (e) {
      console.error("TileManager init failed:", e);
    }
    gBrowser.init();
    delayedStartupPromise = new Promise(resolve => {
  },
};`;
    mockReadText.mockResolvedValue(contentWithTile);

    const result = await addInitToBrowserInit('/engine', 'SidePanel.init()');

    expect(result).toBe(true);
    const written = mockWriteText.mock.calls[0]?.[1] ?? '';

    // SidePanel should come after TileManager block but before gBrowser.init()
    const tileIdx = written.indexOf('TileManager.init()');
    const sideIdx = written.indexOf('SidePanel.init()');
    const gBrowserIdx = written.indexOf('gBrowser.init()');
    expect(sideIdx).toBeGreaterThan(tileIdx);
    expect(sideIdx).toBeLessThan(gBrowserIdx);
  });

  it('inserts init block after specified --after target', async () => {
    const contentWithCanvas = `var gBrowserInit = {
  onLoad() {
    // CustomWidget init — must be first, before Firefox subsystem
    // inits that reference native UI elements we hide.
    try {
      if (typeof CustomWidget !== "undefined") {
        CustomWidget.init();
      }
    } catch (e) {
      console.error("CustomWidget init failed:", e);
    }
    gBrowser.init();
    delayedStartupPromise = new Promise(resolve => {
  },
};`;
    mockReadText.mockResolvedValue(contentWithCanvas);

    const result = await addInitToBrowserInit('/engine', 'CustomWidgetPan.init()', 'CustomWidget');

    expect(result).toBe(true);
    expect(mockWriteText).toHaveBeenCalled();

    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    // CustomWidgetPan should appear after CustomWidget block but before gBrowser.init()
    const canvasIdx = written.indexOf('CustomWidget.init()');
    const panIdx = written.indexOf('CustomWidgetPan.init()');
    const gBrowserIdx = written.indexOf('gBrowser.init()');
    expect(panIdx).toBeGreaterThan(canvasIdx);
    expect(panIdx).toBeLessThan(gBrowserIdx);
  });
});

// ---------------------------------------------------------------------------
// addDomFragment
// ---------------------------------------------------------------------------

describe('addDomFragment', () => {
  const MOCK_BROWSER_XHTML = `<?xml version="1.0"?>
<window>
  <html:body>
#include browser-sets.inc
#include browser-ui.inc
  </html:body>
</window>`;

  it('inserts #include directive before #include browser-sets.inc', async () => {
    mockReadText.mockResolvedValue(MOCK_BROWSER_XHTML);
    // The .inc.xhtml file doesn't need to exist for normal insertion (no migration)
    mockPathExists.mockImplementation((p: string) => {
      if (p.endsWith('browser.xhtml')) return Promise.resolve(true);
      // .inc.xhtml file doesn't exist — skip migration path
      return Promise.resolve(false);
    });

    const result = await addDomFragment(
      '/engine',
      'browser/components/mybrowser/mybrowser-chrome.inc.xhtml'
    );

    expect(result).toBe(true);
    expect(mockWriteText).toHaveBeenCalled();

    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    expect(written).toContain('#include ../../components/mybrowser/mybrowser-chrome.inc.xhtml');
    const includeIdx = written.indexOf('mybrowser-chrome.inc.xhtml');
    const setsIdx = written.indexOf('browser-sets.inc');
    expect(includeIdx).toBeLessThan(setsIdx);
  });

  it('is idempotent — skips if #include directive already present', async () => {
    const content = MOCK_BROWSER_XHTML.replace(
      '#include browser-sets.inc',
      '#include ../../components/mybrowser/mybrowser-chrome.inc.xhtml\n#include browser-sets.inc'
    );
    mockReadText.mockResolvedValue(content);

    const result = await addDomFragment(
      '/engine',
      'browser/components/mybrowser/mybrowser-chrome.inc.xhtml'
    );

    expect(result).toBe(false);
    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it('migrates inlined content to #include directive', async () => {
    // browser.xhtml has inlined content
    const xhtmlWithInlined = `<?xml version="1.0"?>
<window>
  <html:body>
<html:div id="mybrowser-root">inlined content here</html:div>
#include browser-sets.inc
#include browser-ui.inc
  </html:body>
</window>`;

    // The .inc.xhtml source file
    const incXhtml = '<html:div id="mybrowser-root">real content</html:div>';

    mockPathExists.mockResolvedValue(true);
    mockReadText.mockImplementation((p: string) => {
      if (p.endsWith('browser.xhtml')) return Promise.resolve(xhtmlWithInlined);
      if (p.endsWith('.inc.xhtml')) return Promise.resolve(incXhtml);
      return Promise.resolve('');
    });

    const result = await addDomFragment(
      '/engine',
      'browser/components/mybrowser/mybrowser-chrome.inc.xhtml'
    );

    expect(result).toBe(true);
    expect(mockWriteText).toHaveBeenCalled();

    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    // Should contain the #include directive
    expect(written).toContain('#include ../../components/mybrowser/mybrowser-chrome.inc.xhtml');
    // Should NOT contain the inlined content
    expect(written).not.toContain('inlined content here');
  });

  it('throws when browser.xhtml is missing', async () => {
    mockPathExists.mockResolvedValue(false);

    await expect(
      addDomFragment('/engine', 'browser/components/test/test.inc.xhtml')
    ).rejects.toThrow('browser.xhtml not found');
  });
});

// ---------------------------------------------------------------------------
// addDestroyToBrowserInit
// ---------------------------------------------------------------------------

describe('addDestroyToBrowserInit', () => {
  const MOCK_BROWSER_INIT_WITH_UNLOAD = `var gBrowserInit = {
  onLoad() {
    gBrowser.init();
  },
  onUnload() {
    gBrowser.destroy();
  },
};`;

  it('inserts destroy expression in onUnload()', async () => {
    mockReadText.mockResolvedValue(MOCK_BROWSER_INIT_WITH_UNLOAD);

    const result = await addDestroyToBrowserInit('/engine', 'CustomWidget.destroy()');

    expect(result).toBe(true);
    expect(mockWriteText).toHaveBeenCalled();

    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    expect(written).toContain('CustomWidget destroy');
    expect(written).toContain('typeof CustomWidget !== "undefined"');
    expect(written).toContain('CustomWidget.destroy();');
  });

  it('is idempotent — skips if already present', async () => {
    const content = MOCK_BROWSER_INIT_WITH_UNLOAD.replace(
      'gBrowser.destroy();',
      'CustomWidget.destroy();\n    gBrowser.destroy();'
    );
    mockReadText.mockResolvedValue(content);

    const result = await addDestroyToBrowserInit('/engine', 'CustomWidget.destroy()');

    expect(result).toBe(false);
    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it('LIFO ordering — newest destroy goes before existing', async () => {
    const contentWithExisting = `var gBrowserInit = {
  onLoad() {
    gBrowser.init();
  },
  onUnload() {
    // TileManager destroy
    try {
      if (typeof TileManager !== "undefined") {
        TileManager.destroy();
      }
    } catch (e) {
      console.error("TileManager destroy failed:", e);
    }
    gBrowser.destroy();
  },
};`;
    mockReadText.mockResolvedValue(contentWithExisting);

    const result = await addDestroyToBrowserInit('/engine', 'SidePanel.destroy()');

    expect(result).toBe(true);
    const written = mockWriteText.mock.calls[0]?.[1] ?? '';

    // SidePanel should appear BEFORE TileManager (LIFO)
    const sidePanelIdx = written.indexOf('SidePanel.destroy()');
    const tileIdx = written.indexOf('TileManager.destroy()');
    expect(sidePanelIdx).toBeLessThan(tileIdx);
  });

  it('throws when file is missing', async () => {
    mockPathExists.mockResolvedValue(false);

    await expect(addDestroyToBrowserInit('/engine', 'X.destroy()')).rejects.toThrow(
      'browser-init.js not found in engine'
    );
  });

  it('throws when onUnload()/uninit() method is missing', async () => {
    mockReadText.mockResolvedValue(`var gBrowserInit = {
  onLoad() {
    gBrowser.init();
  },
};`);

    await expect(addDestroyToBrowserInit('/engine', 'X.destroy()')).rejects.toThrow(
      'Could not find "onUnload" or "uninit"'
    );
  });
});

// ---------------------------------------------------------------------------
// wireSubscript — subscriptDir support
// ---------------------------------------------------------------------------

import { registerBrowserContent } from '../manifest-register.js';

const mockRegisterBrowserContent = vi.mocked(registerBrowserContent);

describe('wireSubscript', () => {
  const MOCK_BROWSER_MAIN = `{
  try {
    Services.scriptloader.loadSubScript("chrome://browser/content/browser-places.js", this);
  } catch (e) {
    console.error("Failed to load browser-places.js:", e);
  }
}`;

  beforeEach(() => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(MOCK_BROWSER_MAIN);
  });

  it('passes custom sourcePath to registerBrowserContent for non-default subscriptDir', async () => {
    const result = await wireSubscript('/project', 'my-widget', {
      subscriptDir: 'browser/components/mybrowser',
    });

    expect(result.subscriptAdded).toBe(true);
    expect(mockRegisterBrowserContent).toHaveBeenCalledWith(
      '/project/engine',
      'my-widget.js',
      undefined,
      '../components/mybrowser/my-widget.js'
    );
  });

  it('computes custom sourcePath independently from process cwd', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/tmp/unrelated-worktree');

    try {
      await wireSubscript('/project', 'my-widget', {
        subscriptDir: 'browser/components/mybrowser',
      });
    } finally {
      cwdSpy.mockRestore();
    }

    expect(mockRegisterBrowserContent).toHaveBeenCalledWith(
      '/project/engine',
      'my-widget.js',
      undefined,
      '../components/mybrowser/my-widget.js'
    );
  });

  it('does not pass sourcePath for default subscriptDir', async () => {
    await wireSubscript('/project', 'my-widget', {});

    expect(mockRegisterBrowserContent).toHaveBeenCalledWith(
      '/project/engine',
      'my-widget.js',
      undefined,
      undefined
    );
  });
});

// ---------------------------------------------------------------------------
// addInitToBrowserInit — idempotency with substring protection
// ---------------------------------------------------------------------------

describe('addInitToBrowserInit — idempotency', () => {
  const MOCK_BROWSER_INIT_WITH_EXISTING = `{
  onLoad() {
    // MyComponent init — must be first, before Firefox subsystem
    // inits that reference native UI elements we hide.
    try {
      if (typeof MyComponent !== "undefined") {
        MyComponent.init();
      }
    } catch (e) {
      console.error("MyComponent init failed:", e);
    }
  }
}`;

  it('returns false when expression already exists', async () => {
    mockReadText.mockResolvedValue(MOCK_BROWSER_INIT_WITH_EXISTING);
    const result = await addInitToBrowserInit('/engine', 'MyComponent.init()');
    expect(result).toBe(false);
  });

  it('returns true when only a substring matches', async () => {
    mockReadText.mockResolvedValue(MOCK_BROWSER_INIT_WITH_EXISTING);
    const result = await addInitToBrowserInit('/engine', 'MyComponentExtra.init()');
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// addSubscriptToBrowserMain — braces in strings
// ---------------------------------------------------------------------------

describe('addSubscriptToBrowserMain — braces in strings', () => {
  it('handles braces inside string literals in the source', async () => {
    const content = `{
  try {
    console.log("closing } brace");
    Services.scriptloader.loadSubScript("chrome://browser/content/existing.js", this);
  } catch (e) {
    console.error("Failed:", e);
  }
}`;
    mockReadText.mockResolvedValue(content);
    const result = await addSubscriptToBrowserMain('/engine', 'custom-widget');
    expect(result).toBe(true);
    const written = mockWriteText.mock.calls[0]?.[1] as string;
    expect(written).toContain('custom-widget.js');
    // Verify the block is inserted after the existing try/catch, not inside it
    const lines = written.split('\n');
    const customIdx = lines.findIndex((l: string) => l.includes('custom-widget.js'));
    const closingBrace = lines.findIndex((l: string) =>
      l.includes('console.log("closing } brace")')
    );
    expect(customIdx).toBeGreaterThan(closingBrace);
  });
});

// ---------------------------------------------------------------------------
// addDomFragment — idempotency with line-anchored matching
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// addInitToBrowserInit / addDestroyToBrowserInit — expression validation
// ---------------------------------------------------------------------------

describe('addInitToBrowserInit — expression validation', () => {
  it('rejects code injection in init expression', async () => {
    await expect(addInitToBrowserInit('/engine', 'foo();alert(1)//')).rejects.toThrow(
      'must contain only'
    );
  });

  it('rejects semicolons in init expression', async () => {
    await expect(addInitToBrowserInit('/engine', 'a;b')).rejects.toThrow('must contain only');
  });

  it('rejects __proto__ in init expression', async () => {
    await expect(addInitToBrowserInit('/engine', '__proto__.init()')).rejects.toThrow(
      'must not contain "__proto__"'
    );
  });

  it('rejects bracket notation in init expression', async () => {
    await expect(addInitToBrowserInit('/engine', 'window["ns"].init()')).rejects.toThrow(
      'must contain only'
    );
  });
});

describe('addDestroyToBrowserInit — expression validation', () => {
  it('rejects code injection in destroy expression', async () => {
    await expect(addDestroyToBrowserInit('/engine', 'foo();alert(1)//')).rejects.toThrow(
      'must contain only'
    );
  });

  it('rejects __proto__ in destroy expression', async () => {
    await expect(addDestroyToBrowserInit('/engine', '__proto__.destroy()')).rejects.toThrow(
      'must not contain "__proto__"'
    );
  });
});

describe('addDomFragment — idempotency', () => {
  it('returns false when include directive already exists', async () => {
    // The include path is computed relative to browser/base/content/
    const xhtmlContent = `<?xml version="1.0"?>
<window>
#include widgets/my-widget.inc.xhtml
</window>`;
    mockReadText.mockImplementation((path: string) => {
      if (path.includes('browser.xhtml')) return Promise.resolve(xhtmlContent);
      return Promise.resolve('<div id="my-widget"></div>');
    });
    const result = await addDomFragment(
      '/engine',
      'browser/base/content/widgets/my-widget.inc.xhtml'
    );
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// wire-dom-fragment — branch coverage
// ---------------------------------------------------------------------------

describe('addDomFragmentTokenized (branch coverage)', () => {
  it('falls back to <html:body> when browser-sets.inc is not found', () => {
    const content = `<?xml version="1.0"?>
<html:body>
  <div id="main"/>
</html:body>`;
    const result = addDomFragmentTokenized(content, '#include test.inc.xhtml');
    expect(result).toContain('#include test.inc.xhtml');
    const lines = result.split('\n');
    const bodyIdx = lines.findIndex((l) => l.includes('<html:body>'));
    const includeIdx = lines.findIndex((l) => l.includes('#include test.inc.xhtml'));
    expect(includeIdx).toBe(bodyIdx + 1);
  });

  it('throws when neither browser-sets.inc nor <html:body> are found', () => {
    const content = `<?xml version="1.0"?>
<div id="somethingElse"/>`;
    expect(() => addDomFragmentTokenized(content, '#include test.inc.xhtml')).toThrow(
      /Could not find insertion point/
    );
  });
});

describe('legacyAddDomFragment (branch coverage)', () => {
  it('falls back to <html:body> when browser-sets.inc is not found', () => {
    const content = `<?xml version="1.0"?>
<html:body>
  <div/>
</html:body>`;
    const result = legacyAddDomFragment(content, '#include test.inc.xhtml');
    expect(result).toContain('#include test.inc.xhtml');
    const lines = result.split('\n');
    const bodyIdx = lines.findIndex((l) => l.includes('<html:body>'));
    const includeIdx = lines.findIndex((l) => l.includes('#include test.inc.xhtml'));
    expect(includeIdx).toBe(bodyIdx + 1);
  });

  it('throws when neither browser-sets.inc nor <html:body> are found', () => {
    const content = `<div id="other"/>`;
    expect(() => legacyAddDomFragment(content, '#include test.inc.xhtml')).toThrow(
      /Could not find insertion point/
    );
  });
});

describe('addDomFragment (migration branch coverage)', () => {
  it('handles migration when DOM file has no id attribute', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText
      .mockResolvedValueOnce('#include browser-sets.inc\n<div class="noId"/>\n')
      .mockResolvedValueOnce('<div class="noId"/>');

    const result = await addDomFragment(
      '/engine',
      'browser/base/content/fragments/panel.inc.xhtml'
    );

    expect(result).toBe(true);
    expect(mockWriteText).toHaveBeenCalled();
  });

  it('handles migration when the element id is not in browser.xhtml', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText
      .mockResolvedValueOnce('#include browser-sets.inc\n<div id="something-else"/>\n')
      .mockResolvedValueOnce('<panel id="my-panel"/>');

    const result = await addDomFragment(
      '/engine',
      'browser/base/content/fragments/panel.inc.xhtml'
    );

    expect(result).toBe(true);
    expect(mockWriteText).toHaveBeenCalled();
  });
});
