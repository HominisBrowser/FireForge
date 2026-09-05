// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFsMock, createLoggerMock } from '../../test-utils/module-mocks.js';
import {
  deregisterTestManifest,
  registerTestManifest,
  registerToolkitWidget,
} from '../moz-manifest-register.js';
import {
  isFileRegistered,
  matchesRegistrablePattern,
  registerFile,
} from '../moz-manifest-rules.js';

vi.mock('../../utils/fs.js', () => createFsMock());

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
  loadConfig: vi.fn(() =>
    Promise.resolve({
      name: 'Test Browser',
      vendor: 'Test',
      appId: 'org.test.browser',
      binaryName: 'testbrowser',
      firefox: { version: '145.0', product: 'firefox' },
    })
  ),
}));

vi.mock('../../utils/logger.js', () => createLoggerMock());

vi.mock('../moz-manifest-tokenizers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../moz-manifest-tokenizers.js')>();
  return {
    ...actual,
    tokenizeJarMn: vi.fn(actual.tokenizeJarMn),
  };
});

import { nativePath } from '../../test-utils/index.js';
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
// registerTestManifest
// ---------------------------------------------------------------------------

describe('registerTestManifest', () => {
  const MOCK_MOZ_BUILD = `
BROWSER_CHROME_MANIFESTS += [
    "content/test/about/browser.toml",
    "content/test/general/browser.toml",
    "content/test/sidebar/browser.toml",
]
`.trimStart();

  it('inserts test manifest in alphabetical order', async () => {
    mockReadText.mockResolvedValue(MOCK_MOZ_BUILD);

    const result = await registerTestManifest('/engine', 'custom-widget');

    expect(result.skipped).toBe(false);
    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    const lines = written.split('\n');
    const widgetIdx = lines.findIndex((l: string) => l.includes('custom-widget'));
    const aboutIdx = lines.findIndex((l: string) => l.includes('about'));
    const generalIdx = lines.findIndex((l: string) => l.includes('general'));

    expect(widgetIdx).toBeGreaterThan(aboutIdx);
    expect(widgetIdx).toBeLessThan(generalIdx);
  });

  it('is idempotent — skips if already registered', async () => {
    mockReadText.mockResolvedValue(MOCK_MOZ_BUILD);

    const result = await registerTestManifest('/engine', 'general');

    expect(result.skipped).toBe(true);
    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it('registers a NESTED test directory at arbitrary depth', async () => {
    mockReadText.mockResolvedValue(MOCK_MOZ_BUILD);

    const result = await registerTestManifest('/engine', 'mybrowser/settings');

    expect(result.skipped).toBe(false);
    expect(result.entry).toContain('content/test/mybrowser/settings/browser.toml');
    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    expect(written).toContain('"content/test/mybrowser/settings/browser.toml",');
  });
});

// ---------------------------------------------------------------------------
// registerToolkitWidget
// ---------------------------------------------------------------------------

describe('registerToolkitWidget', () => {
  const MOCK_TOOLKIT_JAR_MN = `
toolkit.jar:
% content global %content/global/
   content/global/elements/findbar.js  (widgets/findbar/findbar.js)
   content/global/elements/wizard.js  (widgets/wizard/wizard.js)
`.trimStart();

  it('inserts widget entries in alphabetical order within the elements section', async () => {
    mockReadText.mockResolvedValue(MOCK_TOOLKIT_JAR_MN);

    const result = await registerToolkitWidget('/engine', 'search-textbox', 'search-textbox.mjs');

    expect(result.skipped).toBe(false);
    expect(result.manifest).toBe('toolkit/content/jar.mn');
    expect(result.previousEntry).toContain('findbar.js');

    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    const lines = written.split('\n');
    const findbarIdx = lines.findIndex((line: string) => line.includes('findbar.js'));
    const widgetIdx = lines.findIndex((line: string) => line.includes('search-textbox.mjs'));
    const wizardIdx = lines.findIndex((line: string) => line.includes('wizard.js'));

    expect(widgetIdx).toBeGreaterThan(findbarIdx);
    expect(widgetIdx).toBeLessThan(wizardIdx);
    expect(written).toContain('(widgets/search-textbox/search-textbox.mjs)');
  });

  it('supports dry-run mode without writing the manifest', async () => {
    mockReadText.mockResolvedValue(MOCK_TOOLKIT_JAR_MN);

    const result = await registerToolkitWidget(
      '/engine',
      'search-textbox',
      'search-textbox.css',
      true
    );

    expect(result.skipped).toBe(false);
    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it('is idempotent when the widget file is already registered', async () => {
    mockReadText.mockResolvedValue(MOCK_TOOLKIT_JAR_MN);

    const result = await registerToolkitWidget('/engine', 'wizard', 'wizard.js');

    expect(result.skipped).toBe(true);
    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it('throws when the toolkit widget section cannot be located', async () => {
    mockReadText.mockResolvedValue('% content global %content/global/\n');

    await expect(
      registerToolkitWidget('/engine', 'search-textbox', 'search-textbox.mjs')
    ).rejects.toThrow('Could not find content/global/elements/ section');
  });
});

// ---------------------------------------------------------------------------
// registerFile (dispatcher)
// ---------------------------------------------------------------------------

describe('registerFile', () => {
  it('dispatches browser/themes/shared/*.css to registerSharedCSS', async () => {
    mockReadText.mockResolvedValue('  skin/classic/browser/aaa.css    (../shared/aaa.css)\n');

    const result = await registerFile('/project', 'browser/themes/shared/custom.css');
    expect(result.manifest).toBe('browser/themes/shared/jar.inc.mn');
  });

  it('dispatches browser/base/content/*.js to registerBrowserContent', async () => {
    mockReadText.mockResolvedValue('        content/browser/aaa.js    (content/aaa.js)\n');

    const result = await registerFile('/project', 'browser/base/content/custom.js');
    expect(result.manifest).toBe('browser/base/jar.mn');
  });

  it('dispatches test manifests to registerTestManifest', async () => {
    // A real moz.build list, header included. A bare list body only parses
    // under the lax legacy regex scanner; the tokenizer, now the only path,
    // needs the header.
    mockReadText.mockResolvedValue(
      ['BROWSER_CHROME_MANIFESTS += [', '    "content/test/aaa/browser.toml",', ']', ''].join('\n')
    );

    const result = await registerFile(
      '/project',
      'browser/base/content/test/custom-widget/browser.toml'
    );
    expect(result.manifest).toBe('browser/base/moz.build');
  });

  it('dispatches fireforge modules to registerFireForgeModule', async () => {
    mockReadText.mockResolvedValue(
      ['EXTRA_JS_MODULES += [', '    "Aaa.sys.mjs",', ']', ''].join('\n')
    );

    const result = await registerFile('/project', 'browser/modules/testbrowser/Overlay.sys.mjs');
    expect(result.manifest).toBe('browser/modules/testbrowser/moz.build');
  });

  it('throws InvalidArgumentError for unknown file patterns', async () => {
    await expect(registerFile('/project', 'some/random/path.txt')).rejects.toThrow(
      'Unknown file pattern'
    );
    // The supported-pattern list must name every registrable shape.
    await expect(registerFile('/project', 'some/random/path.txt')).rejects.toThrow(
      /test_\*\.js.*xpcshell\.toml/s
    );
  });

  it('dispatches nested browser.toml manifests to registerTestManifest', async () => {
    mockReadText.mockResolvedValue(
      ['BROWSER_CHROME_MANIFESTS += [', '    "content/test/aaa/browser.toml",', ']', ''].join('\n')
    );

    const result = await registerFile(
      '/project',
      'browser/base/content/test/custom-widget/settings/browser.toml'
    );
    expect(result.manifest).toBe('browser/base/moz.build');
    expect(result.entry).toContain('content/test/custom-widget/settings/browser.toml');
  });

  it('dispatches xpcshell test files to the xpcshell.toml writer', async () => {
    // The directory's xpcshell.toml exists and already lists another test.
    mockReadText.mockResolvedValue('[DEFAULT]\n\n["test_aaa.js"]\n');

    const result = await registerFile(
      '/project',
      'browser/components/testbrowser/test/unit/test_store.js'
    );
    expect(result.manifest).toBe('browser/components/testbrowser/test/unit/xpcshell.toml');
    expect(result.skipped).toBe(false);
  });

  it('xpcshell test files without a manifest fail with a --create-manifest hint', async () => {
    mockPathExists.mockResolvedValue(false);
    await expect(
      registerFile('/project', 'browser/components/testbrowser/test/unit/test_store.js')
    ).rejects.toThrow(/Manifest not found[\s\S]*--create-manifest/);
  });

  it('dispatches browser/base/content/*.xhtml to registerBrowserContent', async () => {
    mockReadText.mockResolvedValue('        content/browser/aaa.js    (content/aaa.js)\n');

    const result = await registerFile('/project', 'browser/base/content/overlay.xhtml');
    expect(result.manifest).toBe('browser/base/jar.mn');
  });

  it('dispatches browser/base/content/*.css to registerBrowserContent', async () => {
    mockReadText.mockResolvedValue('        content/browser/aaa.js    (content/aaa.js)\n');

    const result = await registerFile('/project', 'browser/base/content/overlay.css');
    expect(result.manifest).toBe('browser/base/jar.mn');
  });

  it('throws helpful advice for .ftl locale files', async () => {
    await expect(
      registerFile('/project', 'browser/locales/en-US/browser/overlay.ftl')
    ).rejects.toThrow('auto-discovered via jar.mn glob patterns');
  });

  it('throws helpful advice for individual test files', async () => {
    await expect(
      registerFile('/project', 'browser/base/content/test/sidebar/head.html')
    ).rejects.toThrow('browser.toml');
  });

  it('throws xpcshell-specific advice for xpcshell.toml manifests', async () => {
    // `furnace create --test-style xpcshell` and `furnace chrome-doc create
    // --with-tests` scaffold `xpcshell.toml` under a dedicated
    // subdirectory. Routing `register <path>/xpcshell.toml` through the
    // generic testMatch branch suggests registering browser.toml — wrong
    // manifest type AND a path that does not exist. The dedicated xpcshell
    // branch points operators at XPCSHELL_TESTS_MANIFESTS in the appropriate
    // moz.build.
    await expect(
      registerFile(
        '/project',
        'browser/base/content/test/mybrowser-xpcshell/my-widget/xpcshell.toml'
      )
    ).rejects.toThrow(/XPCSHELL_TESTS_MANIFESTS/);
    await expect(
      registerFile(
        '/project',
        'browser/base/content/test/mybrowser-xpcshell/my-widget/xpcshell.toml'
      )
    ).rejects.toThrow(/xpcshell\.toml manifests are not auto-registered/);
  });

  it('throws helpful advice for .inc.xhtml fragments under browser/base/content', async () => {
    // A browser-content pattern matching every .xhtml under
    // browser/base/content/ also matches `.inc.xhtml` fragments consumed via
    // `#include`, so status flags them as "potentially unregistered" and
    // register proposes a bogus jar.mn entry. The narrowed pattern excludes
    // `.inc.xhtml` and routes the call through getUnregistrableAdvice so the
    // operator sees the `wire` guidance instead.
    await expect(
      registerFile('/project', 'browser/base/content/my-fragment.inc.xhtml')
    ).rejects.toThrow(/`?\.inc\.xhtml`? fragments are consumed via `#include`/);
  });
});

describe('isFileRegistered', () => {
  it('returns false for a registrable file missing from its manifest', async () => {
    mockReadText.mockResolvedValue(
      '  skin/classic/browser/browser.css    (../shared/browser.css)\n'
    );

    await expect(isFileRegistered('/project', 'browser/themes/shared/custom.css')).resolves.toBe(
      false
    );
  });

  it('returns true for a registrable file already present in its manifest', async () => {
    mockReadText.mockResolvedValue(
      '  skin/classic/browser/mybrowser-tokens.css    (../shared/mybrowser-tokens.css)\n'
    );

    await expect(
      isFileRegistered('/project', 'browser/themes/shared/mybrowser-tokens.css')
    ).resolves.toBe(true);
  });

  it('throws InvalidArgumentError for non-registrable files', async () => {
    await expect(isFileRegistered('/project', 'docs/notes.txt')).rejects.toThrow(
      'Unknown file pattern'
    );
  });

  it('throws helpful advice for .ftl files instead of generic error', async () => {
    await expect(
      isFileRegistered('/project', 'browser/locales/en-US/browser/overlay.ftl')
    ).rejects.toThrow('auto-discovered via jar.mn glob patterns');
  });

  it('throws helpful advice for individual test files instead of generic error', async () => {
    // Note: .js files under test/ also match the browser/base/content/ rule,
    // so we test with a non-JS test artifact (e.g. .html) that won't match.
    await expect(
      isFileRegistered('/project', 'browser/base/content/test/sidebar/head.html')
    ).rejects.toThrow('browser.toml');
  });

  it('throws advice for .inc.xhtml fragments instead of routing them into jar.mn', async () => {
    await expect(
      isFileRegistered('/project', 'browser/base/content/my-fragment.inc.xhtml')
    ).rejects.toThrow(/\.inc\.xhtml/);
  });

  it('checks xpcshell test files against their xpcshell.toml', async () => {
    mockReadText.mockResolvedValue('[DEFAULT]\n\n["test_store.js"]\n');
    await expect(
      isFileRegistered('/project', 'browser/components/testbrowser/test/unit/test_store.js')
    ).resolves.toBe(true);
    mockReadText.mockResolvedValue('[DEFAULT]\n\n["test_other.js"]\n');
    await expect(
      isFileRegistered('/project', 'browser/components/testbrowser/test/unit/test_store.js')
    ).resolves.toBe(false);
  });

  it('checks nested browser.toml manifests', async () => {
    mockReadText.mockResolvedValue('    "content/test/widget/inner/browser.toml",\n');
    await expect(
      isFileRegistered('/project', 'browser/base/content/test/widget/inner/browser.toml')
    ).resolves.toBe(true);
  });

  it('mentions the register-based scaffold path in xpcshell.toml advice', async () => {
    await expect(
      isFileRegistered('/project', 'browser/components/testbrowser/test/unit/xpcshell.toml')
    ).rejects.toThrow(/--create-manifest/);
  });
});

// ---------------------------------------------------------------------------
// registerFile --create-manifest threading
// ---------------------------------------------------------------------------

describe('registerFile with createManifest', () => {
  it('scaffolds a missing module moz.build instead of failing', async () => {
    // No manifests exist anywhere except the parent browser/modules/moz.build.
    mockPathExists.mockImplementation((filePath: string) =>
      Promise.resolve(filePath === nativePath('/project/engine/browser/modules/moz.build'))
    );
    mockReadText.mockResolvedValue('DIRS += [\n    "newtab",\n]\n');

    const result = await registerFile(
      '/project',
      'browser/modules/testbrowser/Overlay.sys.mjs',
      false,
      undefined,
      { createManifest: true }
    );

    expect(result.manifest).toBe('browser/modules/testbrowser/moz.build');
    expect(result.scaffoldActions?.some((a) => a.manifest === 'browser/modules/moz.build')).toBe(
      true
    );
    expect(mockWriteText).toHaveBeenCalledWith(
      nativePath('/project/engine/browser/modules/testbrowser/moz.build'),
      expect.stringContaining('EXTRA_JS_MODULES.testbrowser')
    );
  });

  it('creates the xpcshell.toml and wires XPCSHELL_TESTS_MANIFESTS', async () => {
    mockPathExists.mockImplementation((filePath: string) =>
      Promise.resolve(
        filePath === nativePath('/project/engine/browser/components/testbrowser/moz.build')
      )
    );
    mockReadText.mockResolvedValue('EXTRA_JS_MODULES.testbrowser += [\n    "Store.sys.mjs",\n]\n');

    const result = await registerFile(
      '/project',
      'browser/components/testbrowser/test/unit/test_store.js',
      false,
      undefined,
      { createManifest: true }
    );

    expect(result.manifest).toBe('browser/components/testbrowser/test/unit/xpcshell.toml');
    expect(mockWriteText).toHaveBeenCalledWith(
      nativePath('/project/engine/browser/components/testbrowser/test/unit/xpcshell.toml'),
      expect.stringContaining('["test_store.js"]')
    );
    expect(mockWriteText).toHaveBeenCalledWith(
      nativePath('/project/engine/browser/components/testbrowser/moz.build'),
      expect.stringContaining('XPCSHELL_TESTS_MANIFESTS')
    );
  });
});

// ---------------------------------------------------------------------------
// matchesRegistrablePattern — .inc.xhtml carve-out (status heuristic)
// ---------------------------------------------------------------------------

describe('matchesRegistrablePattern — .inc.xhtml carve-out', () => {
  it('returns false for .inc.xhtml fragments so status does not flag them', () => {
    // The direct gate for the status-command case: `status` iterates new
    // files through matchesRegistrablePattern to decide what to surface as
    // "potentially unregistered". A broader pattern lights up every wired
    // `.inc.xhtml` fragment, even though the file is intentionally consumed
    // via `#include`.
    expect(
      matchesRegistrablePattern('browser/base/content/my-fragment.inc.xhtml', 'mybrowser')
    ).toBe(false);
  });

  it('still matches plain .xhtml files under browser/base/content', () => {
    expect(matchesRegistrablePattern('browser/base/content/my-overlay.xhtml', 'mybrowser')).toBe(
      true
    );
  });

  it('returns false for browser-chrome test files', () => {
    // `status --unmanaged` must not flag `browser_<fork>_<case>.js` under
    // `browser/base/content/test/<dir>/` as "potentially unregistered" —
    // `register` would then add it to jar.mn as chrome content, the wrong
    // manifest (the right one is the sibling browser.toml). The pattern
    // excludes the test subtree so these paths fall through to the
    // browser.toml advice in `getUnregistrableAdvice`.
    expect(
      matchesRegistrablePattern(
        'browser/base/content/test/forgeqa/browser_forgeqa_qa_browser.js',
        'mybrowser'
      )
    ).toBe(false);
    expect(
      matchesRegistrablePattern('browser/base/content/test/forgeqa/head.js', 'mybrowser')
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// manifest-rules — error paths when a manifest is absent
// ---------------------------------------------------------------------------

describe('isFileRegistered (manifest not found)', () => {
  it('throws when shared CSS manifest is missing', async () => {
    mockPathExists.mockResolvedValue(false);

    await expect(isFileRegistered('/project', 'browser/themes/shared/custom.css')).rejects.toThrow(
      /Manifest not found/
    );
  });

  it('throws when browser content manifest is missing', async () => {
    mockPathExists.mockResolvedValue(false);

    await expect(isFileRegistered('/project', 'browser/base/content/custom.js')).rejects.toThrow(
      /Manifest not found/
    );
  });

  it('throws when test manifest moz.build is missing', async () => {
    mockPathExists.mockResolvedValue(false);

    await expect(
      isFileRegistered('/project', 'browser/base/content/test/custom-widget/browser.toml')
    ).rejects.toThrow(/Manifest not found/);
  });

  it('throws when module moz.build is missing', async () => {
    mockPathExists.mockResolvedValue(false);

    await expect(
      isFileRegistered('/project', 'browser/modules/testbrowser/Custom.sys.mjs')
    ).rejects.toThrow(/Manifest not found/);
  });

  it('throws when toolkit widget manifest is missing', async () => {
    mockPathExists.mockResolvedValue(false);

    await expect(
      isFileRegistered('/project', 'toolkit/content/widgets/moz-toggle/moz-toggle.mjs')
    ).rejects.toThrow(/Manifest not found/);
  });
});

describe('matchesRegistrablePattern', () => {
  it('returns true for a shared CSS path', () => {
    expect(matchesRegistrablePattern('browser/themes/shared/custom.css', 'testbrowser')).toBe(true);
  });

  it('returns true for a browser content JS path', () => {
    expect(matchesRegistrablePattern('browser/base/content/panel.js', 'testbrowser')).toBe(true);
  });

  it('returns true for a toolkit widget path', () => {
    expect(
      matchesRegistrablePattern('toolkit/content/widgets/moz-toggle/moz-toggle.mjs', 'testbrowser')
    ).toBe(true);
  });

  it('returns false for an unrecognized path', () => {
    expect(matchesRegistrablePattern('docs/README.md', 'testbrowser')).toBe(false);
  });
});

describe('registerFile (toolkit widget dispatch)', () => {
  it('dispatches toolkit widget files to registerToolkitWidget', async () => {
    mockReadText.mockResolvedValue(
      `toolkit.jar:
% content global %content/global/
   content/global/elements/findbar.js  (widgets/findbar/findbar.js)
`
    );

    const result = await registerFile(
      '/project',
      'toolkit/content/widgets/moz-toggle/moz-toggle.mjs'
    );
    expect(result.manifest).toBe('toolkit/content/jar.mn');
  });
});

// ---------------------------------------------------------------------------
// isFileRegistered — full rule dispatch coverage
// ---------------------------------------------------------------------------

describe('isFileRegistered (all rule paths)', () => {
  it('returns true for browser content already in jar.mn', async () => {
    mockReadText.mockResolvedValue('        content/browser/panel.js    (content/panel.js)\n');

    await expect(isFileRegistered('/project', 'browser/base/content/panel.js')).resolves.toBe(true);
  });

  it('returns false for browser content missing from jar.mn', async () => {
    mockReadText.mockResolvedValue(
      '        content/browser/aboutDialog.js    (content/aboutDialog.js)\n'
    );

    await expect(isFileRegistered('/project', 'browser/base/content/panel.js')).resolves.toBe(
      false
    );
  });

  it('returns true for browser content .mjs file already in jar.mn', async () => {
    mockReadText.mockResolvedValue(
      '        content/browser/sidebar.mjs    (content/sidebar.mjs)\n'
    );

    await expect(isFileRegistered('/project', 'browser/base/content/sidebar.mjs')).resolves.toBe(
      true
    );
  });

  it('returns true for test manifest already in moz.build', async () => {
    mockReadText.mockResolvedValue('    "content/test/custom-widget/browser.toml",\n');

    await expect(
      isFileRegistered('/project', 'browser/base/content/test/custom-widget/browser.toml')
    ).resolves.toBe(true);
  });

  it('returns false for test manifest missing from moz.build', async () => {
    mockReadText.mockResolvedValue('    "content/test/other-widget/browser.toml",\n');

    await expect(
      isFileRegistered('/project', 'browser/base/content/test/custom-widget/browser.toml')
    ).resolves.toBe(false);
  });

  it('returns true for fireforge module already in moz.build', async () => {
    mockReadText.mockResolvedValue('    "Overlay.sys.mjs",\n');

    await expect(
      isFileRegistered('/project', 'browser/modules/testbrowser/Overlay.sys.mjs')
    ).resolves.toBe(true);
  });

  it('returns false for fireforge module missing from moz.build', async () => {
    mockReadText.mockResolvedValue('    "Other.sys.mjs",\n');

    await expect(
      isFileRegistered('/project', 'browser/modules/testbrowser/Overlay.sys.mjs')
    ).resolves.toBe(false);
  });

  it('returns true for toolkit widget already in jar.mn', async () => {
    mockReadText.mockResolvedValue(
      '   content/global/elements/moz-toggle.mjs  (widgets/moz-toggle/moz-toggle.mjs)\n'
    );

    await expect(
      isFileRegistered('/project', 'toolkit/content/widgets/moz-toggle/moz-toggle.mjs')
    ).resolves.toBe(true);
  });

  it('returns false for toolkit widget missing from jar.mn', async () => {
    mockReadText.mockResolvedValue(
      '   content/global/elements/findbar.js  (widgets/findbar/findbar.js)\n'
    );

    await expect(
      isFileRegistered('/project', 'toolkit/content/widgets/moz-toggle/moz-toggle.mjs')
    ).resolves.toBe(false);
  });

  it('returns true for toolkit widget CSS file already in jar.mn', async () => {
    mockReadText.mockResolvedValue(
      '   content/global/elements/moz-toggle.css  (widgets/moz-toggle/moz-toggle.css)\n'
    );

    await expect(
      isFileRegistered('/project', 'toolkit/content/widgets/moz-toggle/moz-toggle.css')
    ).resolves.toBe(true);
  });
});

// ---------------------------------------------------------------------------
// matchesRegistrablePattern — additional pattern coverage
// ---------------------------------------------------------------------------

describe('matchesRegistrablePattern (additional patterns)', () => {
  it('returns true for a test manifest path', () => {
    expect(
      matchesRegistrablePattern(
        'browser/base/content/test/custom-widget/browser.toml',
        'testbrowser'
      )
    ).toBe(true);
  });

  it('returns true for a fireforge module path', () => {
    expect(
      matchesRegistrablePattern('browser/modules/testbrowser/Overlay.sys.mjs', 'testbrowser')
    ).toBe(true);
  });

  it('returns false for a fireforge module with wrong binary name', () => {
    expect(
      matchesRegistrablePattern('browser/modules/otherbrowser/Overlay.sys.mjs', 'testbrowser')
    ).toBe(false);
  });

  it('normalizes Windows-style backslash paths', () => {
    expect(matchesRegistrablePattern('browser\\themes\\shared\\custom.css', 'testbrowser')).toBe(
      true
    );
  });

  it('normalizes Windows-style backslash paths for toolkit widgets', () => {
    expect(
      matchesRegistrablePattern(
        'toolkit\\content\\widgets\\moz-toggle\\moz-toggle.mjs',
        'testbrowser'
      )
    ).toBe(true);
  });

  it('returns false for Windows-style unrecognized path', () => {
    expect(matchesRegistrablePattern('docs\\notes.txt', 'testbrowser')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isFileRegistered — Windows path normalization
// ---------------------------------------------------------------------------

describe('isFileRegistered (Windows path normalization)', () => {
  it('normalizes backslashes for shared CSS lookup', async () => {
    mockReadText.mockResolvedValue('  skin/classic/browser/custom.css    (../shared/custom.css)\n');

    await expect(isFileRegistered('/project', 'browser\\themes\\shared\\custom.css')).resolves.toBe(
      true
    );
  });

  it('normalizes backslashes for browser content lookup', async () => {
    mockReadText.mockResolvedValue('        content/browser/panel.js    (content/panel.js)\n');

    await expect(isFileRegistered('/project', 'browser\\base\\content\\panel.js')).resolves.toBe(
      true
    );
  });

  it('normalizes backslashes for toolkit widget lookup', async () => {
    mockReadText.mockResolvedValue(
      '   content/global/elements/moz-toggle.mjs  (widgets/moz-toggle/moz-toggle.mjs)\n'
    );

    await expect(
      isFileRegistered('/project', 'toolkit\\content\\widgets\\moz-toggle\\moz-toggle.mjs')
    ).resolves.toBe(true);
  });

  it('throws for unknown pattern with backslashes', async () => {
    await expect(isFileRegistered('/project', 'docs\\notes.txt')).rejects.toThrow(
      'Unknown file pattern'
    );
  });
});

// ---------------------------------------------------------------------------
// registerFile — Windows path normalization
// ---------------------------------------------------------------------------

describe('registerFile (Windows path normalization)', () => {
  it('normalizes backslashes when dispatching shared CSS', async () => {
    mockReadText.mockResolvedValue('  skin/classic/browser/aaa.css    (../shared/aaa.css)\n');

    const result = await registerFile('/project', 'browser\\themes\\shared\\custom.css');
    expect(result.manifest).toBe('browser/themes/shared/jar.inc.mn');
  });

  it('normalizes backslashes when dispatching browser content', async () => {
    mockReadText.mockResolvedValue('        content/browser/aaa.js    (content/aaa.js)\n');

    const result = await registerFile('/project', 'browser\\base\\content\\custom.js');
    expect(result.manifest).toBe('browser/base/jar.mn');
  });

  it('normalizes backslashes when dispatching toolkit widget', async () => {
    mockReadText.mockResolvedValue(
      `toolkit.jar:
% content global %content/global/
   content/global/elements/findbar.js  (widgets/findbar/findbar.js)
`
    );

    const result = await registerFile(
      '/project',
      'toolkit\\content\\widgets\\moz-toggle\\moz-toggle.mjs'
    );
    expect(result.manifest).toBe('toolkit/content/jar.mn');
  });

  it('throws for unknown pattern with backslashes', async () => {
    await expect(registerFile('/project', 'docs\\notes.txt')).rejects.toThrow(
      'Unknown file pattern'
    );
  });
});

// ---------------------------------------------------------------------------
// deregisterTestManifest
// ---------------------------------------------------------------------------

describe('deregisterTestManifest', () => {
  const MOCK_MOZ_BUILD = `
BROWSER_CHROME_MANIFESTS += [
    "content/test/about/browser.toml",
    "content/test/mybrowser/browser.toml",
    "content/test/sidebar/browser.toml",
]
`.trimStart();

  beforeEach(() => {
    vi.clearAllMocks();
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(MOCK_MOZ_BUILD);
  });

  it('removes the test manifest entry and returns true', async () => {
    const result = await deregisterTestManifest('/engine', 'mybrowser');

    expect(result).toBe(true);
    expect(mockWriteText).toHaveBeenCalled();
    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    expect(written).not.toContain('mybrowser');
    expect(written).toContain('about');
    expect(written).toContain('sidebar');
  });

  it('returns false when moz.build does not exist', async () => {
    mockPathExists.mockResolvedValue(false);

    const result = await deregisterTestManifest('/engine', 'mybrowser');

    expect(result).toBe(false);
    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it('returns false when entry is not in moz.build', async () => {
    const result = await deregisterTestManifest('/engine', 'nonexistent');

    expect(result).toBe(false);
    expect(mockWriteText).not.toHaveBeenCalled();
  });
});

describe('--after support', () => {
  it('warns when --after is passed to a manifest that cannot honour it', async () => {
    // The visible half: an accepted-but-ignored flag is taken as `_after`
    // and the entry inserted alphabetically, with no indication the
    // operator's placement was dropped.
    mockReadText.mockResolvedValue(
      ['EXTRA_JS_MODULES += [', '    "Aaa.sys.mjs",', ']', ''].join('\n')
    );

    await registerFile(
      '/project',
      'browser/modules/testbrowser/Overlay.sys.mjs',
      false,
      'Aaa.sys.mjs'
    );

    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('--after is not supported'));
  });

  it('does not warn when --after is passed to a manifest that honours it', async () => {
    mockWarn.mockClear();
    mockReadText.mockResolvedValue('        content/browser/aaa.js    (content/aaa.js)\n');

    await registerFile('/project', 'browser/base/content/custom.js', false, 'aaa.js');

    const afterWarnings = mockWarn.mock.calls.filter((c) =>
      c[0].includes('--after is not supported')
    );
    expect(afterWarnings).toHaveLength(0);
  });
});
