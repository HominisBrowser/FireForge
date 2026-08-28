// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { formatDryRunPlan, formatSuccessNote } from '../create-dry-run.js';

describe('formatDryRunPlan', () => {
  it('renders .mjs and .css files for a non-localized component', () => {
    const plan = formatDryRunPlan({
      componentName: 'moz-widget',
      localized: false,
      register: true,
      composes: undefined,
      testStyle: 'none',
      description: 'A widget',
      binaryName: 'mybrowser',
    });
    expect(plan).toContain('Would create files in components/custom/moz-widget/:');
    expect(plan).toContain('moz-widget.mjs');
    expect(plan).toContain('moz-widget.css');
    expect(plan).not.toContain('.ftl');
    expect(plan).toContain('register: true');
    expect(plan).toContain('localized: false');
  });

  it('includes the .ftl in the plan when localized is set', () => {
    const plan = formatDryRunPlan({
      componentName: 'moz-widget',
      localized: true,
      register: true,
      composes: undefined,
      testStyle: 'none',
      description: '',
      binaryName: 'mybrowser',
    });
    expect(plan).toContain('moz-widget.ftl');
    expect(plan).toContain('description: (empty)');
  });

  it('renders the browser-chrome test plan with the moz.build registration line', () => {
    const plan = formatDryRunPlan({
      componentName: 'moz-mybrowser-widget',
      localized: false,
      register: true,
      composes: undefined,
      testStyle: 'browser-chrome',
      description: 'Test widget',
      binaryName: 'mybrowser',
    });
    expect(plan).toContain('engine/browser/base/content/test/mybrowser/');
    expect(plan).toContain('browser.toml');
    expect(plan).toContain('head.js');
    // The binaryName prefix in the tag is stripped so the test filename
    // doesn't redundantly contain `mybrowser-mybrowser-`.
    expect(plan).toContain('browser_mybrowser_widget.js');
    expect(plan).toContain(
      'Would register mybrowser/browser.toml in engine/browser/base/moz.build'
    );
  });

  it('names the --test-dir override, not the binary-name default, in the browser-chrome plan', () => {
    // The scaffolder honoured --test-dir while the plan kept printing
    // `.../test/<binaryName>/` and `<binaryName>/browser.toml`; an operator
    // reading the dry run was told about a directory the real run never
    // touched. Both the path and the moz.build registration name follow
    // the override now.
    const plan = formatDryRunPlan({
      componentName: 'moz-mybrowser-widget',
      localized: false,
      register: true,
      composes: undefined,
      testStyle: 'browser-chrome',
      description: '',
      binaryName: 'mybrowser',
      testDir: 'browser/base/content/test/mybrowser-tiles',
    });
    expect(plan).toContain(
      'Would create test files in engine/browser/base/content/test/mybrowser-tiles/:'
    );
    expect(plan).not.toContain('engine/browser/base/content/test/mybrowser/');
    expect(plan).toContain(
      'Would register mybrowser-tiles/browser.toml in engine/browser/base/moz.build'
    );
    expect(plan).not.toContain('mybrowser/browser.toml');
  });

  it('renders a nested --test-dir registration name with its full path below the scaffold root', () => {
    const plan = formatDryRunPlan({
      componentName: 'moz-widget',
      localized: false,
      register: true,
      composes: undefined,
      testStyle: 'browser-chrome',
      description: '',
      binaryName: 'mybrowser',
      testDir: 'browser/base/content/test/mybrowser/widgets',
    });
    expect(plan).toContain(
      'Would register mybrowser/widgets/browser.toml in engine/browser/base/moz.build'
    );
  });

  it('names the --test-dir override as the final xpcshell directory', () => {
    // xpcshell overrides name the FINAL directory: no `/<component>` segment
    // is appended (matches scaffoldXpcshellTestFiles).
    const plan = formatDryRunPlan({
      componentName: 'moz-widget',
      localized: false,
      register: true,
      composes: undefined,
      testStyle: 'xpcshell',
      description: '',
      binaryName: 'mybrowser',
      testDir: 'browser/base/content/test/mybrowser-storage',
    });
    expect(plan).toContain(
      'xpcshell test files in engine/browser/base/content/test/mybrowser-storage/'
    );
    expect(plan).not.toContain('mybrowser-xpcshell');
    expect(plan).not.toContain('mybrowser-storage/moz-widget/');
  });

  it('renders the xpcshell test plan', () => {
    const plan = formatDryRunPlan({
      componentName: 'moz-widget',
      localized: false,
      register: true,
      composes: undefined,
      testStyle: 'xpcshell',
      description: '',
      binaryName: 'mybrowser',
    });
    expect(plan).toContain(
      'xpcshell test files in engine/browser/base/content/test/mybrowser-xpcshell/moz-widget/'
    );
  });

  it('renders the mochikit test plan', () => {
    const plan = formatDryRunPlan({
      componentName: 'moz-widget',
      localized: false,
      register: true,
      composes: undefined,
      testStyle: 'mochikit',
      description: '',
      binaryName: 'mybrowser',
    });
    expect(plan).toContain('mochikit test file in engine/toolkit/content/tests/widgets/');
  });

  it('lists composed tags when composes is set', () => {
    const plan = formatDryRunPlan({
      componentName: 'moz-widget',
      localized: false,
      register: true,
      composes: ['moz-button', 'moz-toggle'],
      testStyle: 'none',
      description: '',
      binaryName: 'mybrowser',
    });
    expect(plan).toContain('composes: moz-button, moz-toggle');
  });

  it('omits the per-component .ftl from the plan when sharedFtl is set', () => {
    // Mirrors writeComponentFiles: --shared-ftl components share an
    // existing bundle, so the .ftl stub is skipped. The plan has to
    // preview that reality or operators will see a file listed that the
    // real command then does not produce.
    const plan = formatDryRunPlan({
      componentName: 'mybrowser-dock-button',
      localized: true,
      register: true,
      composes: undefined,
      sharedFtl: 'browser/mybrowser-dock.ftl',
      testStyle: 'none',
      description: 'Dock button',
      binaryName: 'mybrowser',
    });
    expect(plan).not.toContain('mybrowser-dock-button.ftl');
    expect(plan).toContain('sharedFtl: browser/mybrowser-dock.ftl');
    expect(plan).toContain('localized: true');
  });
});

describe('formatSuccessNote', () => {
  it('renders the file list and next-steps block with no test files', () => {
    const note = formatSuccessNote({
      componentName: 'moz-widget',
      files: ['moz-widget.mjs', 'moz-widget.css'],
      testFiles: [],
      testStyle: 'none',
      binaryName: 'mybrowser',
    });
    expect(note).toContain('Files created in components/custom/moz-widget/:');
    expect(note).toContain('moz-widget.mjs');
    expect(note).toContain('moz-widget.css');
    expect(note).not.toContain('Test files in');
    expect(note).toContain('Next steps:');
    expect(note).toContain('fireforge furnace preview');
  });

  it('renders the xpcshell test root when testStyle is xpcshell', () => {
    const note = formatSuccessNote({
      componentName: 'moz-widget',
      files: ['moz-widget.mjs'],
      testFiles: ['test_moz_widget_packaged.js'],
      testStyle: 'xpcshell',
      binaryName: 'mybrowser',
    });
    expect(note).toContain('engine/browser/base/content/test/mybrowser-xpcshell/moz-widget/');
  });

  it('renders the mochikit test root when testStyle is mochikit', () => {
    const note = formatSuccessNote({
      componentName: 'moz-widget',
      files: ['moz-widget.mjs'],
      testFiles: ['test_moz-widget.html'],
      testStyle: 'mochikit',
      binaryName: 'mybrowser',
    });
    expect(note).toContain('engine/toolkit/content/tests/widgets/');
  });

  it('names the --test-dir override in the browser-chrome success note', () => {
    // The real run scaffolded into the override while the success message
    // still named `.../test/<binaryName>/` — the message is the only
    // confirmation an operator gets, so it has to name the real directory.
    const note = formatSuccessNote({
      componentName: 'moz-widget',
      files: ['moz-widget.mjs'],
      testFiles: ['browser_mybrowser_widget.js'],
      testStyle: 'browser-chrome',
      binaryName: 'mybrowser',
      testDir: 'browser/base/content/test/mybrowser-tiles',
    });
    expect(note).toContain('Test files in engine/browser/base/content/test/mybrowser-tiles/:');
    expect(note).not.toContain('engine/browser/base/content/test/mybrowser/');
  });

  it('names the --test-dir override as the final directory in the xpcshell success note', () => {
    const note = formatSuccessNote({
      componentName: 'moz-widget',
      files: ['moz-widget.mjs'],
      testFiles: ['test_moz_widget_packaged.js'],
      testStyle: 'xpcshell',
      binaryName: 'mybrowser',
      testDir: 'browser/base/content/test/mybrowser-storage',
    });
    expect(note).toContain('Test files in engine/browser/base/content/test/mybrowser-storage/:');
    expect(note).not.toContain('mybrowser-xpcshell');
  });

  it('falls back to the browser-chrome test root for the default mochitest layout', () => {
    const note = formatSuccessNote({
      componentName: 'moz-widget',
      files: ['moz-widget.mjs'],
      testFiles: ['browser_mybrowser_widget.js'],
      testStyle: 'browser-chrome',
      binaryName: 'mybrowser',
    });
    expect(note).toContain('engine/browser/base/content/test/mybrowser/');
  });
});
