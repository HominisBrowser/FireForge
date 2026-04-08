// SPDX-License-Identifier: EUPL-1.2
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  deregisterTestManifest,
  registerBrowserContent,
  registerFireForgeModule,
  registerSharedCSS,
  registerTestManifest,
  registerToolkitWidget,
} from '../manifest-register.js';
import {
  getRules,
  isFileRegistered,
  matchesRegistrablePattern,
  registerFile,
} from '../manifest-rules.js';

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

vi.mock('../../utils/logger.js', () => ({
  warn: vi.fn(),
}));

vi.mock('../manifest-tokenizers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../manifest-tokenizers.js')>();
  return {
    ...actual,
    tokenizeJarMn: vi.fn(actual.tokenizeJarMn),
  };
});

import { pathExists, readText, writeText } from '../../utils/fs.js';
import { warn } from '../../utils/logger.js';
import { tokenizeJarMn } from '../manifest-tokenizers.js';

const mockPathExists = vi.mocked(pathExists);
const mockReadText = vi.mocked(readText);
const mockWriteText = vi.mocked(writeText);
const mockWarn = vi.mocked(warn);
const mockTokenizeJarMn = vi.mocked(tokenizeJarMn);

beforeEach(() => {
  vi.clearAllMocks();
  mockPathExists.mockResolvedValue(true);
});

// ---------------------------------------------------------------------------
// registerSharedCSS
// ---------------------------------------------------------------------------

describe('registerSharedCSS', () => {
  const MOCK_JAR_INC_MN = `
  skin/classic/browser/autocomplete.css    (../shared/autocomplete.css)
  skin/classic/browser/browser.css         (../shared/browser.css)
  skin/classic/browser/zoom.css            (../shared/zoom.css)
`.trimStart();

  it('inserts CSS entry in alphabetical order (middle)', async () => {
    mockReadText.mockResolvedValue(MOCK_JAR_INC_MN);

    const result = await registerSharedCSS('/engine', 'custom.css');

    expect(result.skipped).toBe(false);
    expect(result.manifest).toBe('browser/themes/shared/jar.inc.mn');
    expect(mockWriteText).toHaveBeenCalled();

    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    const lines = written.split('\n');
    const customIdx = lines.findIndex((l: string) => l.includes('custom.css'));
    const browserIdx = lines.findIndex((l: string) => l.includes('browser.css'));
    const zoomIdx = lines.findIndex((l: string) => l.includes('zoom.css'));

    expect(customIdx).toBeGreaterThan(browserIdx);
    expect(customIdx).toBeLessThan(zoomIdx);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('inserts at the beginning', async () => {
    mockReadText.mockResolvedValue(MOCK_JAR_INC_MN);

    const result = await registerSharedCSS('/engine', 'aaa.css');

    expect(result.skipped).toBe(false);
    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    const lines = written.split('\n');
    const aaaIdx = lines.findIndex((l: string) => l.includes('aaa.css'));
    const autoIdx = lines.findIndex((l: string) => l.includes('autocomplete.css'));
    expect(aaaIdx).toBeLessThan(autoIdx);
  });

  it('inserts at the end', async () => {
    mockReadText.mockResolvedValue(MOCK_JAR_INC_MN);

    const result = await registerSharedCSS('/engine', 'zzz.css');

    expect(result.skipped).toBe(false);
    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    const lines = written.split('\n');
    const zzzIdx = lines.findIndex((l: string) => l.includes('zzz.css'));
    const zoomIdx = lines.findIndex((l: string) => l.includes('zoom.css'));
    expect(zzzIdx).toBeGreaterThan(zoomIdx);
  });

  it('is idempotent — skips if already registered', async () => {
    mockReadText.mockResolvedValue(MOCK_JAR_INC_MN);

    const result = await registerSharedCSS('/engine', 'browser.css');

    expect(result.skipped).toBe(true);
    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it('inserts after --after target instead of alphabetical', async () => {
    mockReadText.mockResolvedValue(MOCK_JAR_INC_MN);

    const result = await registerSharedCSS('/engine', 'custom.css', 'autocomplete.css');

    expect(result.skipped).toBe(false);
    expect(result.afterFallback).toBeFalsy();
    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    const lines = written.split('\n');
    const autoIdx = lines.findIndex((l: string) => l.includes('autocomplete.css'));
    const customIdx = lines.findIndex((l: string) => l.includes('custom.css'));
    // Should be immediately after autocomplete, not alphabetical position after browser
    expect(customIdx).toBe(autoIdx + 1);
  });

  it('falls back to alphabetical if --after target not found', async () => {
    mockReadText.mockResolvedValue(MOCK_JAR_INC_MN);

    const result = await registerSharedCSS('/engine', 'custom.css', 'nonexistent.css');

    expect(result.skipped).toBe(false);
    expect(result.afterFallback).toBe(true);
    // Should still be inserted in alphabetical position
    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    const lines = written.split('\n');
    const customIdx = lines.findIndex((l: string) => l.includes('custom.css'));
    const browserIdx = lines.findIndex((l: string) => l.includes('browser.css'));
    const zoomIdx = lines.findIndex((l: string) => l.includes('zoom.css'));
    expect(customIdx).toBeGreaterThan(browserIdx);
    expect(customIdx).toBeLessThan(zoomIdx);
  });
});

// ---------------------------------------------------------------------------
// registerBrowserContent
// ---------------------------------------------------------------------------

describe('registerBrowserContent', () => {
  const MOCK_JAR_MN = `
browser.jar:
%  content/browser %content/browser/
        content/browser/aboutDialog.js    (content/aboutDialog.js)
        content/browser/browser-init.js   (content/browser-init.js)
        content/browser/browser.js        (content/browser.js)
`.trimStart();

  it('inserts JS entry in alphabetical order', async () => {
    mockReadText.mockResolvedValue(MOCK_JAR_MN);

    const result = await registerBrowserContent('/engine', 'browser-custom.js');

    expect(result.skipped).toBe(false);
    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    const lines = written.split('\n');
    const customIdx = lines.findIndex((l: string) => l.includes('browser-custom.js'));
    const initIdx = lines.findIndex((l: string) => l.includes('browser-init.js'));
    const aboutIdx = lines.findIndex((l: string) => l.includes('aboutDialog.js'));

    expect(customIdx).toBeGreaterThan(aboutIdx);
    expect(customIdx).toBeLessThan(initIdx);
  });

  it('is idempotent — skips if already registered', async () => {
    mockReadText.mockResolvedValue(MOCK_JAR_MN);

    const result = await registerBrowserContent('/engine', 'browser.js');

    expect(result.skipped).toBe(true);
    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it('uses custom sourcePath when provided', async () => {
    mockReadText.mockResolvedValue(MOCK_JAR_MN);

    const result = await registerBrowserContent(
      '/engine',
      'my-widget.js',
      undefined,
      '../components/mybrowser/my-widget.js'
    );

    expect(result.skipped).toBe(false);
    expect(result.entry).toContain('(../components/mybrowser/my-widget.js)');
    expect(result.entry).toContain('content/browser/my-widget.js');
    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    expect(written).toContain('(../components/mybrowser/my-widget.js)');
  });
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

  it('falls back to the legacy inserter with an explicit warning when tokenization cannot find the list header', async () => {
    mockReadText.mockResolvedValue(
      [
        '    "content/test/about/browser.toml",',
        '    "content/test/general/browser.toml",',
        '',
      ].join('\n')
    );

    const result = await registerTestManifest('/engine', 'custom-widget');

    expect(result.skipped).toBe(false);
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('falling back to legacy'));
    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    expect(written).toContain('"content/test/custom-widget/browser.toml"');
  });

  it('is idempotent — skips if already registered', async () => {
    mockReadText.mockResolvedValue(MOCK_MOZ_BUILD);

    const result = await registerTestManifest('/engine', 'general');

    expect(result.skipped).toBe(true);
    expect(mockWriteText).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// registerFireForgeModule
// ---------------------------------------------------------------------------

describe('registerFireForgeModule', () => {
  const MOCK_MOZ_BUILD = `
EXTRA_JS_MODULES.testbrowser += [
    "CanvasRenderer.sys.mjs",
    "Telemetry.sys.mjs",
]
`.trimStart();

  it('inserts module in alphabetical order', async () => {
    mockReadText.mockResolvedValue(MOCK_MOZ_BUILD);

    const result = await registerFireForgeModule(
      '/engine',
      'Overlay.sys.mjs',
      'browser/modules/testbrowser'
    );

    expect(result.skipped).toBe(false);
    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    const lines = written.split('\n');
    const overlayIdx = lines.findIndex((l: string) => l.includes('Overlay'));
    const canvasIdx = lines.findIndex((l: string) => l.includes('CanvasRenderer'));
    const telemetryIdx = lines.findIndex((l: string) => l.includes('Telemetry'));

    expect(overlayIdx).toBeGreaterThan(canvasIdx);
    expect(overlayIdx).toBeLessThan(telemetryIdx);
  });

  it('is idempotent — skips if already registered', async () => {
    mockReadText.mockResolvedValue(MOCK_MOZ_BUILD);

    const result = await registerFireForgeModule(
      '/engine',
      'CanvasRenderer.sys.mjs',
      'browser/modules/testbrowser'
    );

    expect(result.skipped).toBe(true);
    expect(mockWriteText).not.toHaveBeenCalled();
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
    mockReadText.mockResolvedValue('    "content/test/aaa/browser.toml",\n');

    const result = await registerFile(
      '/project',
      'browser/base/content/test/custom-widget/browser.toml'
    );
    expect(result.manifest).toBe('browser/base/moz.build');
  });

  it('dispatches fireforge modules to registerFireForgeModule', async () => {
    mockReadText.mockResolvedValue('    "Aaa.sys.mjs",\n');

    const result = await registerFile('/project', 'browser/modules/testbrowser/Overlay.sys.mjs');
    expect(result.manifest).toBe('browser/modules/testbrowser/moz.build');
  });

  it('throws InvalidArgumentError for unknown file patterns', async () => {
    await expect(registerFile('/project', 'some/random/path.txt')).rejects.toThrow(
      'Unknown file pattern'
    );
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
});

// ---------------------------------------------------------------------------
// registerBrowserContent — branch coverage
// ---------------------------------------------------------------------------

describe('registerBrowserContent (branch coverage)', () => {
  it('inserts after a specific --after target in the tokenized path', async () => {
    const content = `browser.jar:
%  content/browser %content/browser/
        content/browser/aboutDialog.js    (content/aboutDialog.js)
        content/browser/browser-init.js   (content/browser-init.js)
        content/browser/browser.js        (content/browser.js)
`;
    mockReadText.mockResolvedValue(content);

    const result = await registerBrowserContent('/engine', 'custom.js', 'aboutDialog.js');

    expect(result.skipped).toBe(false);
    expect(result.afterFallback).toBeFalsy();
    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    const lines = written.split('\n');
    const aboutIdx = lines.findIndex((l: string) => l.includes('aboutDialog.js'));
    const customIdx = lines.findIndex((l: string) => l.includes('custom.js'));
    expect(customIdx).toBe(aboutIdx + 1);
  });

  it('falls back to alphabetical when --after target is not found', async () => {
    const content = `browser.jar:
%  content/browser %content/browser/
        content/browser/aboutDialog.js    (content/aboutDialog.js)
        content/browser/browser.js        (content/browser.js)
`;
    mockReadText.mockResolvedValue(content);

    const result = await registerBrowserContent('/engine', 'custom.js', 'nonexistent.js');

    expect(result.skipped).toBe(false);
    expect(result.afterFallback).toBe(true);
  });

  it('throws when content/browser/ section is missing and jar has no header', async () => {
    mockReadText.mockResolvedValue('');

    await expect(registerBrowserContent('/engine', 'custom.js')).rejects.toThrow(/Could not find/);
  });

  it('does not write when dryRun is true', async () => {
    const content = `browser.jar:
%  content/browser %content/browser/
        content/browser/aboutDialog.js    (content/aboutDialog.js)
`;
    mockReadText.mockResolvedValue(content);

    const result = await registerBrowserContent('/engine', 'custom.js', undefined, undefined, true);

    expect(result.skipped).toBe(false);
    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it('throws when manifest file does not exist', async () => {
    mockPathExists.mockResolvedValue(false);

    await expect(registerBrowserContent('/engine', 'custom.js')).rejects.toThrow(
      /Manifest not found/
    );
  });
});

// ---------------------------------------------------------------------------
// registerSharedCSS — branch coverage
// ---------------------------------------------------------------------------

describe('registerSharedCSS (branch coverage)', () => {
  it('throws when skin/classic/browser/ section is missing and content is empty', async () => {
    mockReadText.mockResolvedValue('');

    await expect(registerSharedCSS('/engine', 'custom.css')).rejects.toThrow(/Could not find/);
  });

  it('throws when manifest file does not exist', async () => {
    mockPathExists.mockResolvedValue(false);

    await expect(registerSharedCSS('/engine', 'custom.css')).rejects.toThrow(/Manifest not found/);
  });

  it('does not write when dryRun is true', async () => {
    mockReadText.mockResolvedValue(
      '  skin/classic/browser/browser.css    (../shared/browser.css)\n'
    );

    const result = await registerSharedCSS('/engine', 'custom.css', undefined, true);

    expect(result.skipped).toBe(false);
    expect(mockWriteText).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// manifest-rules — branch coverage
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
// getRules — extractArgs ?? '' fallback branches
// ---------------------------------------------------------------------------

describe('getRules extractArgs fallback branches', () => {
  const rules = getRules('testbrowser');

  it('falls back to empty string when shared CSS capture group is undefined', () => {
    // Simulate a match array where group 1 is undefined
    const fakeMatch = Object.assign(['browser/themes/shared/custom.css'], {
      index: 0,
      input: 'browser/themes/shared/custom.css',
      groups: undefined,
    }) as unknown as RegExpMatchArray;
    fakeMatch[1] = undefined as unknown as string;

    const rule = rules[0];
    expect(rule).toBeDefined();
    const args = rule?.extractArgs(fakeMatch);
    expect(args).toEqual(['']);
  });

  it('falls back to empty string when browser content capture group is undefined', () => {
    const fakeMatch = Object.assign(['browser/base/content/panel.js'], {
      index: 0,
      input: 'browser/base/content/panel.js',
      groups: undefined,
    }) as unknown as RegExpMatchArray;
    fakeMatch[1] = undefined as unknown as string;

    const rule = rules[1];
    expect(rule).toBeDefined();
    const args = rule?.extractArgs(fakeMatch);
    expect(args).toEqual(['']);
  });

  it('falls back to empty string when test manifest capture group is undefined', () => {
    const fakeMatch = Object.assign(['browser/base/content/test/widget/browser.toml'], {
      index: 0,
      input: 'browser/base/content/test/widget/browser.toml',
      groups: undefined,
    }) as unknown as RegExpMatchArray;
    fakeMatch[1] = undefined as unknown as string;

    const rule = rules[2];
    expect(rule).toBeDefined();
    const args = rule?.extractArgs(fakeMatch);
    expect(args).toEqual(['']);
  });

  it('falls back to empty string when fireforge module capture group is undefined', () => {
    const fakeMatch = Object.assign(['browser/modules/testbrowser/Overlay.sys.mjs'], {
      index: 0,
      input: 'browser/modules/testbrowser/Overlay.sys.mjs',
      groups: undefined,
    }) as unknown as RegExpMatchArray;
    fakeMatch[1] = undefined as unknown as string;

    const rule = rules[3];
    expect(rule).toBeDefined();
    const args = rule?.extractArgs(fakeMatch);
    expect(args).toEqual(['']);
  });

  it('falls back to empty strings when toolkit widget capture groups are undefined', () => {
    const fakeMatch = Object.assign(['toolkit/content/widgets/moz-toggle/moz-toggle.mjs'], {
      index: 0,
      input: 'toolkit/content/widgets/moz-toggle/moz-toggle.mjs',
      groups: undefined,
    }) as unknown as RegExpMatchArray;
    fakeMatch[1] = undefined as unknown as string;
    fakeMatch[2] = undefined as unknown as string;

    const rule = rules[4];
    expect(rule).toBeDefined();
    const args = rule?.extractArgs(fakeMatch);
    expect(args).toEqual(['', '']);
  });
});

// ---------------------------------------------------------------------------
// registerBrowserContent — legacy fallback coverage
// ---------------------------------------------------------------------------

describe('registerBrowserContent (legacy fallback)', () => {
  let realTokenize: typeof tokenizeJarMn;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../manifest-tokenizers.js')>(
      '../manifest-tokenizers.js'
    );
    realTokenize = actual.tokenizeJarMn;
  });

  beforeEach(() => {
    mockTokenizeJarMn.mockImplementation(() => {
      throw new Error('tokenizer failure');
    });
  });

  afterEach(() => {
    mockTokenizeJarMn.mockImplementation((...args) => realTokenize(...args));
  });

  const LEGACY_JAR_MN = `browser.jar:
%  content/browser %content/browser/
        content/browser/aboutDialog.js    (content/aboutDialog.js)
        content/browser/browser-init.js   (content/browser-init.js)
        content/browser/browser.js        (content/browser.js)
`;

  it('inserts in alphabetical order via the legacy path', async () => {
    mockReadText.mockResolvedValue(LEGACY_JAR_MN);

    const result = await registerBrowserContent('/engine', 'browser-custom.js');

    expect(result.skipped).toBe(false);
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('falling back to legacy'));
    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    const lines = written.split('\n');
    const customIdx = lines.findIndex((l: string) => l.includes('browser-custom.js'));
    const aboutIdx = lines.findIndex((l: string) => l.includes('aboutDialog.js'));
    const initIdx = lines.findIndex((l: string) => l.includes('browser-init.js'));

    expect(customIdx).toBeGreaterThan(aboutIdx);
    expect(customIdx).toBeLessThan(initIdx);
  });

  it('inserts after --after target via the legacy path', async () => {
    mockReadText.mockResolvedValue(LEGACY_JAR_MN);

    const result = await registerBrowserContent('/engine', 'custom.js', 'aboutDialog.js');

    expect(result.skipped).toBe(false);
    expect(result.afterFallback).toBeFalsy();
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('falling back to legacy'));
    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    const lines = written.split('\n');
    const aboutIdx = lines.findIndex((l: string) => l.includes('aboutDialog.js'));
    const customIdx = lines.findIndex((l: string) => l.includes('custom.js'));
    expect(customIdx).toBe(aboutIdx + 1);
  });

  it('falls back to alphabetical when --after target is not found via the legacy path', async () => {
    mockReadText.mockResolvedValue(LEGACY_JAR_MN);

    const result = await registerBrowserContent('/engine', 'custom.js', 'nonexistent.js');

    expect(result.skipped).toBe(false);
    expect(result.afterFallback).toBe(true);
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('falling back to legacy'));
    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    const lines = written.split('\n');
    const customIdx = lines.findIndex((l: string) => l.includes('custom.js'));
    const browserIdx = lines.findIndex((l: string) => l.includes('browser.js'));
    expect(customIdx).toBeGreaterThan(browserIdx);
  });

  it('throws when content/browser/ section is missing via the legacy path', async () => {
    mockReadText.mockResolvedValue('browser.jar:\n% some-directive\n');

    await expect(registerBrowserContent('/engine', 'custom.js')).rejects.toThrow(
      /Could not find content\/browser\/ section/
    );
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('falling back to legacy'));
  });
});

// ---------------------------------------------------------------------------
// registerSharedCSS — legacy fallback coverage
// ---------------------------------------------------------------------------

describe('registerSharedCSS (legacy fallback)', () => {
  let realTokenize: typeof tokenizeJarMn;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../manifest-tokenizers.js')>(
      '../manifest-tokenizers.js'
    );
    realTokenize = actual.tokenizeJarMn;
  });

  beforeEach(() => {
    mockTokenizeJarMn.mockImplementation(() => {
      throw new Error('tokenizer failure');
    });
  });

  afterEach(() => {
    mockTokenizeJarMn.mockImplementation((...args) => realTokenize(...args));
  });

  const LEGACY_JAR_INC_MN = `\
  skin/classic/browser/autocomplete.css    (../shared/autocomplete.css)
  skin/classic/browser/browser.css         (../shared/browser.css)
  skin/classic/browser/zoom.css            (../shared/zoom.css)
`;

  it('inserts in alphabetical order via the legacy path', async () => {
    mockReadText.mockResolvedValue(LEGACY_JAR_INC_MN);

    const result = await registerSharedCSS('/engine', 'custom.css');

    expect(result.skipped).toBe(false);
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('falling back to legacy'));
    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    const lines = written.split('\n');
    const customIdx = lines.findIndex((l: string) => l.includes('custom.css'));
    const browserIdx = lines.findIndex((l: string) => l.includes('browser.css'));
    const zoomIdx = lines.findIndex((l: string) => l.includes('zoom.css'));

    expect(customIdx).toBeGreaterThan(browserIdx);
    expect(customIdx).toBeLessThan(zoomIdx);
  });

  it('inserts after --after target via the legacy path', async () => {
    mockReadText.mockResolvedValue(LEGACY_JAR_INC_MN);

    const result = await registerSharedCSS('/engine', 'custom.css', 'autocomplete.css');

    expect(result.skipped).toBe(false);
    expect(result.afterFallback).toBeFalsy();
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('falling back to legacy'));
    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    const lines = written.split('\n');
    const autoIdx = lines.findIndex((l: string) => l.includes('autocomplete.css'));
    const customIdx = lines.findIndex((l: string) => l.includes('custom.css'));
    expect(customIdx).toBe(autoIdx + 1);
  });

  it('falls back to alphabetical when --after target is not found via the legacy path', async () => {
    mockReadText.mockResolvedValue(LEGACY_JAR_INC_MN);

    const result = await registerSharedCSS('/engine', 'custom.css', 'nonexistent.css');

    expect(result.skipped).toBe(false);
    expect(result.afterFallback).toBe(true);
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('falling back to legacy'));
    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    const lines = written.split('\n');
    const customIdx = lines.findIndex((l: string) => l.includes('custom.css'));
    const browserIdx = lines.findIndex((l: string) => l.includes('browser.css'));
    const zoomIdx = lines.findIndex((l: string) => l.includes('zoom.css'));
    expect(customIdx).toBeGreaterThan(browserIdx);
    expect(customIdx).toBeLessThan(zoomIdx);
  });

  it('throws when skin/classic/browser/ section is missing via the legacy path', async () => {
    mockReadText.mockResolvedValue('% some-directive\n# a comment\n');

    await expect(registerSharedCSS('/engine', 'custom.css')).rejects.toThrow(
      /Could not find skin\/classic\/browser\/ section/
    );
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('falling back to legacy'));
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
