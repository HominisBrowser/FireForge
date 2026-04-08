// SPDX-License-Identifier: EUPL-1.2

// ---------------------------------------------------------------------------
// Helper: generate a large .sys.mjs module body for size-lint testing
// ---------------------------------------------------------------------------

/**
 * Produces a valid `.sys.mjs` file with EUPL-1.2 license header,
 * ChromeUtils lazy imports, and padded JSDoc-annotated exports
 * reaching approximately the requested line count.
 */
export function generateLargeModule(lineCount: number): string {
  const header = [
    '/* SPDX-License-Identifier: EUPL-1.2 */',
    '',
    'const lazy = {};',
    'ChromeUtils.defineESModuleGetters(lazy, {',
    '  AppConstants: "resource://gre/modules/AppConstants.sys.mjs",',
    '});',
    '',
  ];
  const body: string[] = [];
  let i = 0;
  while (header.length + body.length < lineCount - 1) {
    body.push(`/** Handler for event ${i}. */`);
    body.push(`export function handler${i}(data) {`);
    body.push(`  return { index: ${i}, processed: true, ...data };`);
    body.push('}');
    body.push('');
    i++;
  }
  return [...header, ...body].slice(0, lineCount).join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// CSS license header (EUPL-1.2, css comment style)
// ---------------------------------------------------------------------------

const CSS_LICENSE_HEADER = '/* SPDX-License-Identifier: EUPL-1.2 */';

// ---------------------------------------------------------------------------
// JS license header (EUPL-1.2, js comment style)
// ---------------------------------------------------------------------------

const JS_LICENSE_HEADER = '/* SPDX-License-Identifier: EUPL-1.2 */';

// ---------------------------------------------------------------------------
// Workflow fixtures
// ---------------------------------------------------------------------------

export const FIREFOX_WORKFLOW_FIXTURES = {
  // ----- Existing fixtures ------------------------------------------------

  roundTrip: {
    exportPath: 'browser/base/content/browser.js',
    initialFiles: {
      'browser/base/content/browser.js': 'export const browserTitle = "old";\n',
    },
    modifiedFiles: {
      'browser/base/content/browser.js': 'export const browserTitle = "new";\n',
    },
    exportOptions: {
      name: 'browser-title-roundtrip',
      category: 'ui' as const,
      description: 'Round-trip a browser title patch',
    },
    expectedFilesAffected: ['browser/base/content/browser.js'],
    expectedImportedContent: 'export const browserTitle = "new";\n',
  },
  reExportScan: {
    exportPath: 'browser/components/example/panel.js',
    initialFiles: {
      'browser/components/example/panel.js': 'export const panelVersion = 1;\n',
    },
    firstExportState: {
      'browser/components/example/panel.js': 'export const panelVersion = 2;\n',
    },
    secondExportState: {
      'browser/components/example/panel.js': 'export const panelVersion = 3;\n',
      'browser/components/example/panel-helper.js': 'export const helperEnabled = true;\n',
    },
    exportOptions: {
      name: 'panel-feature',
      category: 'ui' as const,
      description: 'Track panel changes and helper additions',
    },
    expectedFilesAffected: [
      'browser/components/example/panel-helper.js',
      'browser/components/example/panel.js',
    ],
  },
  driftGuard: {
    exportPath: 'toolkit/components/example/service.sys.mjs',
    initialFiles: {
      'toolkit/components/example/service.sys.mjs': 'export const version = 1;\n',
      'toolkit/components/example/drift.txt': 'baseline\n',
    },
    modifiedFiles: {
      'toolkit/components/example/service.sys.mjs': 'export const version = 2;\n',
    },
    driftFiles: {
      'toolkit/components/example/drift.txt': 'upstream-drift\n',
    },
    exportOptions: {
      name: 'service-version',
      category: 'infra' as const,
      description: 'Exercise import drift protection',
    },
  },

  // ----- New fixtures: CSS & theming -------------------------------------

  /** New CSS design-token stylesheet with light-dark() theming. */
  cssDesignTokens: {
    exportPath: 'browser/themes/shared/mybrowser-tokens.css',
    initialFiles: {} as Record<string, string>,
    modifiedFiles: {
      'browser/themes/shared/mybrowser-tokens.css': [
        CSS_LICENSE_HEADER,
        '',
        ':root {',
        '  /* Surfaces */',
        '  --mybrowser-surface-canvas: light-dark(#f0f0f4, #15141a);',
        '  --mybrowser-surface-tile: var(--background-color-box);',
        '  --mybrowser-surface-tile-hover: var(--button-background-color-hover);',
        '',
        '  /* Text */',
        '  --mybrowser-text-primary: var(--text-color);',
        '  --mybrowser-text-secondary: var(--text-color-deemphasized);',
        '',
        '  /* Spacing */',
        '  --mybrowser-spacing-sm: 4px;',
        '  --mybrowser-spacing-md: 8px;',
        '  --mybrowser-spacing-lg: 16px;',
        '',
        '  /* Border */',
        '  --mybrowser-border-radius: 8px;',
        '}',
        '',
        '.mybrowser-panel {',
        '  background: var(--mybrowser-surface-canvas);',
        '  color: var(--mybrowser-text-primary);',
        '  border-radius: var(--mybrowser-border-radius);',
        '  padding: var(--mybrowser-spacing-md);',
        '}',
        '',
      ].join('\n'),
    },
    exportOptions: {
      name: 'design-tokens',
      category: 'ui' as const,
      description: 'Add CSS design token stylesheet with light-dark() theming',
    },
    expectedFilesAffected: ['browser/themes/shared/mybrowser-tokens.css'],
  },

  /** CSS file with raw hex/rgb colors and missing license — triggers lint. */
  cssRawColorViolation: {
    exportPath: 'browser/themes/shared/bad-colors.css',
    initialFiles: {} as Record<string, string>,
    modifiedFiles: {
      'browser/themes/shared/bad-colors.css': [
        '.sidebar { background: #ff6600; color: rgb(0, 128, 255); }',
        '',
      ].join('\n'),
    },
    exportOptions: {
      name: 'bad-color-patch',
      category: 'ui' as const,
      description: 'CSS with raw hex/rgb colors for lint testing',
    },
    expectedFilesAffected: ['browser/themes/shared/bad-colors.css'],
    expectedLintChecks: ['raw-color-value', 'missing-license-header'] as const,
  },

  /** CSS with license header but using a foreign token prefix — triggers token-prefix-violation. */
  cssTokenPrefixViolation: {
    exportPath: 'browser/themes/shared/foreign-tokens.css',
    initialFiles: {} as Record<string, string>,
    modifiedFiles: {
      'browser/themes/shared/foreign-tokens.css': [
        CSS_LICENSE_HEADER,
        '',
        '.panel {',
        '  background: var(--some-foreign-token);',
        '  color: var(--another-unknown-prop);',
        '}',
        '',
      ].join('\n'),
    },
    exportOptions: {
      name: 'foreign-tokens',
      category: 'ui' as const,
      description: 'CSS using non-prefixed tokens for lint testing',
    },
    expectedFilesAffected: ['browser/themes/shared/foreign-tokens.css'],
    expectedLintChecks: ['token-prefix-violation'] as const,
  },

  // ----- New fixtures: .sys.mjs modules ----------------------------------

  /** Clean .sys.mjs module with proper JSDoc, observer topics, imports. */
  sysMjsModule: {
    exportPath: 'browser/modules/mybrowser/SidebarController.sys.mjs',
    initialFiles: {} as Record<string, string>,
    modifiedFiles: {
      'browser/modules/mybrowser/SidebarController.sys.mjs': [
        JS_LICENSE_HEADER,
        '',
        'const lazy = {};',
        'ChromeUtils.defineESModuleGetters(lazy, {',
        '  AppConstants: "resource://gre/modules/AppConstants.sys.mjs",',
        '});',
        '',
        '/**',
        ' * Manages sidebar panel state.',
        ' * @param {Window} win - The browser window.',
        ' */',
        'export function initSidebar(win) {',
        '  Services.obs.addObserver(',
        '    { observe() {} },',
        '    "mybrowser-sidebar-opened"',
        '  );',
        '}',
        '',
        '/** Refreshes the sidebar layout. */',
        'export function refreshSidebar() {',
        '  return lazy.AppConstants.platform;',
        '}',
        '',
      ].join('\n'),
    },
    exportOptions: {
      name: 'sidebar-controller',
      category: 'ui' as const,
      description: 'New sidebar system module with observers',
    },
    expectedFilesAffected: ['browser/modules/mybrowser/SidebarController.sys.mjs'],
  },

  /** .sys.mjs with lint violations: relative import, missing header, missing JSDoc, bad topic. */
  sysMjsLintViolations: {
    exportPath: 'browser/modules/mybrowser/BadModule.sys.mjs',
    initialFiles: {} as Record<string, string>,
    modifiedFiles: {
      'browser/modules/mybrowser/BadModule.sys.mjs': [
        'import { helper } from "./utils.mjs";',
        '',
        'export function doWork() {',
        '  Services.obs.addObserver(null, "mybrowser-badtopic");',
        '  return helper();',
        '}',
        '',
      ].join('\n'),
    },
    exportOptions: {
      name: 'bad-module',
      category: 'infra' as const,
      description: 'Module with lint violations for testing',
    },
    expectedFilesAffected: ['browser/modules/mybrowser/BadModule.sys.mjs'],
    expectedLintChecks: [
      'relative-import',
      'missing-license-header',
      'missing-jsdoc',
      'observer-topic-naming',
    ] as const,
  },

  // ----- New fixtures: upstream modification with/without marker ---------

  /** Upstream BrowserGlue modification WITH a // MYBROWSER: marker. Lint-clean. */
  browserGlueIntegration: {
    exportPath: 'browser/components/BrowserGlue.sys.mjs',
    initialFiles: {
      'browser/components/BrowserGlue.sys.mjs': [
        'const lazy = {};',
        'ChromeUtils.defineESModuleGetters(lazy, {',
        '  AboutNewTab: "resource:///modules/AboutNewTab.sys.mjs",',
        '  Interactions: "resource:///modules/Interactions.sys.mjs",',
        '});',
        '',
        'export class BrowserGlue {',
        '  observe(subject, topic) {}',
        '}',
        '',
      ].join('\n'),
    },
    modifiedFiles: {
      'browser/components/BrowserGlue.sys.mjs': [
        'const lazy = {};',
        'ChromeUtils.defineESModuleGetters(lazy, {',
        '  AboutNewTab: "resource:///modules/AboutNewTab.sys.mjs",',
        '  Interactions: "resource:///modules/Interactions.sys.mjs",',
        '  MyBrowserStore: "resource:///modules/mybrowser/MyBrowserStore.sys.mjs", // MYBROWSER: sidebar',
        '});',
        '',
        'export class BrowserGlue {',
        '  observe(subject, topic) {}',
        '}',
        '',
      ].join('\n'),
    },
    exportOptions: {
      name: 'glue-sidebar-import',
      category: 'infra' as const,
      description: 'Register sidebar module in BrowserGlue lazy imports',
    },
    expectedFilesAffected: ['browser/components/BrowserGlue.sys.mjs'],
  },

  /** Same BrowserGlue modification WITHOUT the // MYBROWSER: marker — triggers lint. */
  browserGlueMissingMarker: {
    exportPath: 'browser/components/BrowserGlue.sys.mjs',
    initialFiles: {
      'browser/components/BrowserGlue.sys.mjs': [
        'const lazy = {};',
        'ChromeUtils.defineESModuleGetters(lazy, {',
        '  AboutNewTab: "resource:///modules/AboutNewTab.sys.mjs",',
        '  Interactions: "resource:///modules/Interactions.sys.mjs",',
        '});',
        '',
        'export class BrowserGlue {',
        '  observe(subject, topic) {}',
        '}',
        '',
      ].join('\n'),
    },
    modifiedFiles: {
      'browser/components/BrowserGlue.sys.mjs': [
        'const lazy = {};',
        'ChromeUtils.defineESModuleGetters(lazy, {',
        '  AboutNewTab: "resource:///modules/AboutNewTab.sys.mjs",',
        '  Interactions: "resource:///modules/Interactions.sys.mjs",',
        '  MyBrowserStore: "resource:///modules/mybrowser/MyBrowserStore.sys.mjs",',
        '});',
        '',
        'export class BrowserGlue {',
        '  observe(subject, topic) {}',
        '}',
        '',
      ].join('\n'),
    },
    exportOptions: {
      name: 'glue-no-marker',
      category: 'infra' as const,
      description: 'BrowserGlue modification without marker comment',
    },
    expectedFilesAffected: ['browser/components/BrowserGlue.sys.mjs'],
    expectedLintChecks: ['missing-modification-comment'] as const,
  },

  // ----- New fixtures: multi-file patches --------------------------------

  /** 3-file theme patch: CSS + jar.inc.mn + moz.build. Models Hominis theme packaging. */
  multiFileThemePatch: {
    exportPath: 'browser/themes/shared/',
    initialFiles: {
      'browser/themes/shared/browser.css':
        '/* base styles */\n@import url("chrome://browser/skin/common.css");\nbody { margin: 0; }\n',
      'browser/themes/shared/jar.inc.mn':
        '  skin/classic/browser/browser.css    (../shared/browser.css)\n' +
        '  skin/classic/browser/common.css     (../shared/common.css)\n',
      'browser/modules/moz.build': 'DIRS += ["newtab"]\n',
    },
    modifiedFiles: {
      'browser/themes/shared/browser.css':
        '/* base styles */\n@import url("chrome://browser/skin/common.css");\n@import url("chrome://browser/skin/mybrowser-tokens.css");\nbody { margin: 0; }\n',
      'browser/themes/shared/jar.inc.mn':
        '  skin/classic/browser/browser.css    (../shared/browser.css)\n' +
        '  skin/classic/browser/common.css     (../shared/common.css)\n' +
        '  skin/classic/browser/mybrowser-tokens.css    (../shared/mybrowser-tokens.css)\n',
      'browser/modules/moz.build': 'DIRS += ["newtab"]\nDIRS += ["mybrowser"]\n',
    },
    exportOptions: {
      name: 'theme-registration',
      category: 'ui' as const,
      description: 'Register theme stylesheet and component directory',
    },
    expectedFilesAffected: [
      'browser/modules/moz.build',
      'browser/themes/shared/browser.css',
      'browser/themes/shared/jar.inc.mn',
    ],
  },

  // ----- New fixtures: preferences & test authoring ----------------------

  /** New .js preferences file with pref() calls. Models Hominis's prefs file. */
  prefsFile: {
    exportPath: 'browser/app/profile/mybrowser-prefs.js',
    initialFiles: {} as Record<string, string>,
    modifiedFiles: {
      'browser/app/profile/mybrowser-prefs.js': [
        JS_LICENSE_HEADER,
        '',
        '// Sidebar preferences',
        'pref("mybrowser.sidebar.enabled", true);',
        'pref("mybrowser.sidebar.width", 320);',
        '',
        '// Telemetry opt-out',
        'pref("mybrowser.telemetry.optOut", true);',
        '',
        '// Default homepage',
        'pref("mybrowser.homepage", "about:home");',
        '',
      ].join('\n'),
    },
    exportOptions: {
      name: 'default-prefs',
      category: 'privacy' as const,
      description: 'Default browser preferences',
    },
    expectedFilesAffected: ['browser/app/profile/mybrowser-prefs.js'],
  },

  /** New browser test file + updated .toml manifest. Models Hominis test authoring. */
  testFileWithManifest: {
    exportPath: 'browser/components/mybrowser/test/',
    initialFiles: {
      'browser/components/mybrowser/test/browser.toml': '[DEFAULT]\n\n["browser_existing.js"]\n',
      'browser/components/mybrowser/test/browser_existing.js':
        '"use strict";\nadd_task(async function test_placeholder() { ok(true); });\n',
    },
    modifiedFiles: {
      'browser/components/mybrowser/test/browser.toml':
        '[DEFAULT]\n\n["browser_existing.js"]\n\n["browser_sidebar.js"]\n',
      'browser/components/mybrowser/test/browser_sidebar.js': [
        JS_LICENSE_HEADER,
        '',
        '"use strict";',
        '',
        'add_task(async function test_sidebar_opens() {',
        '  const sidebar = document.getElementById("mybrowser-sidebar");',
        '  ok(sidebar, "Sidebar element exists");',
        '});',
        '',
        'add_task(async function test_sidebar_closes() {',
        '  const sidebar = document.getElementById("mybrowser-sidebar");',
        '  sidebar.hidden = true;',
        '  ok(sidebar.hidden, "Sidebar is hidden after close");',
        '});',
        '',
      ].join('\n'),
    },
    exportOptions: {
      name: 'sidebar-tests',
      category: 'ui' as const,
      description: 'Add sidebar integration test and manifest entry',
    },
    expectedFilesAffected: [
      'browser/components/mybrowser/test/browser.toml',
      'browser/components/mybrowser/test/browser_sidebar.js',
    ],
  },

  // ----- New fixtures: real-world edge cases from Hominis experimentation --

  /** Rust file modification — like real Hominis build.rs bindgen fix. Lint-clean (non-JS/CSS). */
  rustFileModification: {
    exportPath: 'tools/profiler/rust-api/build.rs',
    initialFiles: {
      'tools/profiler/rust-api/build.rs': [
        'use std::env;',
        '',
        'fn generate_bindings() {',
        '    let builder = bindgen::Builder::default()',
        '        .header("wrapper.h")',
        '        .opaque_type("std::string");',
        '    builder.generate().expect("generate failed");',
        '}',
        '',
        'fn main() {',
        '    generate_bindings();',
        '}',
        '',
      ].join('\n'),
    },
    modifiedFiles: {
      'tools/profiler/rust-api/build.rs': [
        'use std::env;',
        '',
        'fn generate_bindings() {',
        '    let builder = bindgen::Builder::default()',
        '        .header("wrapper.h")',
        '        .opaque_type("std::string")',
        '        .opaque_type("std::.*basic_string")',
        '        .blocklist_item(".*basic_string___self_view");',
        '    builder.generate().expect("generate failed");',
        '}',
        '',
        'fn main() {',
        '    generate_bindings();',
        '}',
        '',
      ].join('\n'),
    },
    exportOptions: {
      name: 'bindgen-string-fix',
      category: 'infra' as const,
      description: 'Fix std::basic_string bindgen failures',
    },
    expectedFilesAffected: ['tools/profiler/rust-api/build.rs'],
  },

  /** CSS with proper header but light-dark(#hex) raw colors — triggers warning but not error. */
  cssTokensWithRawColors: {
    exportPath: 'browser/themes/shared/mybrowser-palette.css',
    initialFiles: {} as Record<string, string>,
    modifiedFiles: {
      'browser/themes/shared/mybrowser-palette.css': [
        CSS_LICENSE_HEADER,
        '',
        ':root {',
        '  --mybrowser-surface-canvas: light-dark(#f0f0f4, #15141a);',
        '  --mybrowser-accent: light-dark(#0060df, #73a7f3);',
        '}',
        '',
      ].join('\n'),
    },
    exportOptions: {
      name: 'color-palette',
      category: 'ui' as const,
      description: 'Color palette with light-dark() values',
    },
    expectedFilesAffected: ['browser/themes/shared/mybrowser-palette.css'],
    expectedLintChecks: ['raw-color-value'] as const,
  },

  /** Re-export scenario: export, modify further, re-export with updated content. */
  reExportWithModification: {
    exportPath: 'browser/modules/mybrowser/Config.sys.mjs',
    initialFiles: {
      'browser/modules/mybrowser/Config.sys.mjs': [
        JS_LICENSE_HEADER,
        '',
        '/** Default config. */',
        'export const MAX_WORKSPACES = 8;',
        '',
      ].join('\n'),
    },
    firstExportState: {
      'browser/modules/mybrowser/Config.sys.mjs': [
        JS_LICENSE_HEADER,
        '',
        '/** Default config. */',
        'export const MAX_WORKSPACES = 16;',
        '',
      ].join('\n'),
    },
    secondExportState: {
      'browser/modules/mybrowser/Config.sys.mjs': [
        JS_LICENSE_HEADER,
        '',
        '/** Default config. */',
        'export const MAX_WORKSPACES = 16;',
        '/** Dock position. */',
        'export const DEFAULT_DOCK_POSITION = "bottom";',
        '',
      ].join('\n'),
    },
    exportOptions: {
      name: 'workspace-config',
      category: 'infra' as const,
      description: 'Workspace configuration constants',
    },
    expectedFilesAffected: ['browser/modules/mybrowser/Config.sys.mjs'],
  },

  /** Supersede scenario: same file re-exported under a new name should require --supersede. */
  supersedeGuard: {
    exportPath: 'browser/base/content/browser.js',
    initialFiles: {
      'browser/base/content/browser.js': 'export const version = 1;\n',
    },
    firstExportState: {
      'browser/base/content/browser.js': 'export const version = 2;\n',
    },
    secondExportState: {
      'browser/base/content/browser.js': 'export const version = 3;\n',
    },
    firstExportOptions: {
      name: 'version-bump-v1',
      category: 'ui' as const,
      description: 'First export of version bump',
    },
    secondExportOptions: {
      name: 'version-bump-v2',
      category: 'ui' as const,
      description: 'Second export superseding first',
    },
    expectedFilesAffected: ['browser/base/content/browser.js'],
  },
  // ----- New fixtures: real-world edge cases from Hominis deep-dive --------

  /**
   * .sys.mjs with block-comment SPDX license header.
   * This is the expected EUPL-1.2 format for JS files.
   */
  cssStyleHeaderInJsFile: {
    exportPath: 'browser/modules/mybrowser/FlushManager.sys.mjs',
    initialFiles: {} as Record<string, string>,
    modifiedFiles: {
      'browser/modules/mybrowser/FlushManager.sys.mjs': [
        '/* SPDX-License-Identifier: EUPL-1.2 */',
        '',
        '/**',
        ' * Manages the write-coalescing flush cycle.',
        ' */',
        '/** @returns {number} Flush interval in ms. */',
        'export function getFlushInterval() {',
        '  return 5000;',
        '}',
        '',
        '/** @param {Function} callback */',
        'export function scheduleFlush(callback) {',
        '  return ChromeUtils.idleDispatch(callback);',
        '}',
        '',
      ].join('\n'),
    },
    exportOptions: {
      name: 'flush-manager',
      category: 'infra' as const,
      description: 'Write-coalescing flush cycle manager',
    },
    expectedFilesAffected: ['browser/modules/mybrowser/FlushManager.sys.mjs'],
    expectedLintChecks: [] as const,
  },

  /**
   * Multi-hunk modification: large file with changes in two distant locations.
   * Models real BrowserGlue.sys.mjs where a lazy import is added near the top
   * and a startup hook is added hundreds of lines below.
   */
  multiHunkModification: {
    exportPath: 'browser/components/BrowserGlue.sys.mjs',
    initialFiles: {
      'browser/components/BrowserGlue.sys.mjs': [
        // ~40 lines of lazy import block
        'const lazy = {};',
        'ChromeUtils.defineESModuleGetters(lazy, {',
        '  AboutNewTab: "resource:///modules/AboutNewTab.sys.mjs",',
        '  Interactions: "resource:///modules/Interactions.sys.mjs",',
        '  LoginBreaches: "resource:///modules/LoginBreaches.sys.mjs",',
        '  LoginHelper: "resource://gre/modules/LoginHelper.sys.mjs",',
        '});',
        '',
        // Filler to create distance between hunks (~30 lines)
        '// Section: Constants',
        ...Array.from({ length: 25 }, (_, i) => `const CONST_${i} = ${i};`),
        '',
        '// Section: BrowserGlue',
        'export class BrowserGlue {',
        '  _beforeUIStartup() {',
        '    lazy.AboutNewTab.init();',
        '  }',
        '',
        '  _onFirstWindowLoaded() {',
        '    lazy.Interactions.init();',
        '  }',
        '',
        '  observe(subject, topic) {',
        '    if (topic === "browser-startup") {',
        '      this._beforeUIStartup();',
        '    }',
        '  }',
        '}',
        '',
      ].join('\n'),
    },
    modifiedFiles: {
      'browser/components/BrowserGlue.sys.mjs': [
        // Hunk 1: add lazy import near top
        'const lazy = {};',
        'ChromeUtils.defineESModuleGetters(lazy, {',
        '  AboutNewTab: "resource:///modules/AboutNewTab.sys.mjs",',
        '  Interactions: "resource:///modules/Interactions.sys.mjs",',
        '  LoginBreaches: "resource:///modules/LoginBreaches.sys.mjs",',
        '  LoginHelper: "resource://gre/modules/LoginHelper.sys.mjs",',
        '  MyBrowserStore: "resource:///modules/mybrowser/MyBrowserStore.sys.mjs", // MYBROWSER: storage',
        '});',
        '',
        // Same filler
        '// Section: Constants',
        ...Array.from({ length: 25 }, (_, i) => `const CONST_${i} = ${i};`),
        '',
        // Hunk 2: add startup hook
        '// Section: BrowserGlue',
        'export class BrowserGlue {',
        '  _beforeUIStartup() {',
        '    lazy.AboutNewTab.init();',
        '    lazy.MyBrowserStore.init(); // MYBROWSER: init storage',
        '  }',
        '',
        '  _onFirstWindowLoaded() {',
        '    lazy.Interactions.init();',
        '  }',
        '',
        '  observe(subject, topic) {',
        '    if (topic === "browser-startup") {',
        '      this._beforeUIStartup();',
        '    }',
        '  }',
        '}',
        '',
      ].join('\n'),
    },
    exportOptions: {
      name: 'storage-glue-hooks',
      category: 'infra' as const,
      description: 'Wire MyBrowserStore into BrowserGlue startup',
    },
    expectedFilesAffected: ['browser/components/BrowserGlue.sys.mjs'],
  },

  /**
   * Patch stacking: two patches modifying the same file sequentially.
   * Models Hominis patches 3 + 17 both touching moz.build.
   */
  patchStackBase: {
    initialFiles: {
      'browser/modules/moz.build': [
        'DIRS += [',
        '    "newtab",',
        '    "urlbar",',
        ']',
        '',
        'EXTRA_JS_MODULES += [',
        '    "BrowserUsageTelemetry.sys.mjs",',
        ']',
        '',
      ].join('\n'),
      'browser/modules/mybrowser/FlushManager.sys.mjs': [
        JS_LICENSE_HEADER,
        '',
        '/** @returns {number} */',
        'export function getFlushInterval() { return 5000; }',
        '',
      ].join('\n'),
    },
    firstPatch: {
      name: 'flush-manager-build',
      category: 'infra' as const,
      description: 'Register flush manager in build system',
      files: {
        'browser/modules/moz.build': [
          'DIRS += [',
          '    "mybrowser",',
          '    "newtab",',
          '    "urlbar",',
          ']',
          '',
          'EXTRA_JS_MODULES += [',
          '    "BrowserUsageTelemetry.sys.mjs",',
          ']',
          '',
        ].join('\n'),
      },
      exportPaths: ['browser/modules/moz.build'],
      expectedFilesAffected: ['browser/modules/moz.build'],
    },
    secondPatch: {
      name: 'storage-build-integration',
      category: 'infra' as const,
      description: 'Register HominisStore in build system',
      files: {
        'browser/modules/moz.build': [
          'DIRS += [',
          '    "mybrowser",',
          '    "newtab",',
          '    "urlbar",',
          ']',
          '',
          'EXTRA_JS_MODULES += [',
          '    "BrowserUsageTelemetry.sys.mjs",',
          '    "HominisStore.sys.mjs",',
          ']',
          '',
        ].join('\n'),
      },
      exportPaths: ['browser/modules/moz.build'],
      expectedFilesAffected: ['browser/modules/moz.build'],
    },
  },

  /**
   * Observer topic regex edge case: notifyObservers with a variable (not string literal)
   * argument followed by an object literal. The regex's [^)]* greedily consumes the
   * multi-line object, then matches a distant quote and captures a huge false-positive.
   * Models the real HominisStore.sys.mjs bug.
   */
  observerRegexEdgeCase: {
    exportPath: 'browser/modules/mybrowser/EventBus.sys.mjs',
    initialFiles: {} as Record<string, string>,
    modifiedFiles: {
      'browser/modules/mybrowser/EventBus.sys.mjs': [
        JS_LICENSE_HEADER,
        '',
        'const EVENTS = {',
        '  TILES_EVICTED: "mybrowser-tiles-evicted",',
        '};',
        '',
        '/** Notify with variable topic (triggers regex edge case). */',
        'export function emitEviction(tileIds) {',
        '  Services.obs.notifyObservers(null, EVENTS.TILES_EVICTED, JSON.stringify({',
        '    tileIds,',
        '    reason: "orphaned-file-cleanup",',
        '  }));',
        '}',
        '',
        '/** Notify with inline string topic (correct detection). */',
        'export function emitStartup() {',
        '  Services.obs.notifyObservers(null, "mybrowser-storage-started");',
        '}',
        '',
      ].join('\n'),
    },
    exportOptions: {
      name: 'event-bus',
      category: 'infra' as const,
      description: 'Event notification module for observer testing',
    },
    expectedFilesAffected: ['browser/modules/mybrowser/EventBus.sys.mjs'],
  },
} as const;

export const FIREFOX_WORKFLOW_SETUP_OPTIONS = {
  name: 'MyBrowser',
  vendor: 'My Company',
  appId: 'org.example.mybrowser',
  binaryName: 'mybrowser',
  firefoxVersion: '140.0esr',
  product: 'firefox-esr' as const,
  license: 'EUPL-1.2' as const,
};
