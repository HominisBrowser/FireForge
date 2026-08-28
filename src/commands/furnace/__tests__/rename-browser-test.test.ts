// SPDX-License-Identifier: EUPL-1.2
/**
 * Browser-chrome test-body rewriting for `furnace rename`.
 *
 * Bare, unanchored, global replacements make a rename of `moz-panel` rewrite
 * `moz-panel-group` and every other identifier merely *containing* the old
 * name. The two sibling rewriters (`furnace/rename.ts` and
 * `rename-xpcshell.ts`) carry word-boundary guards for the same reason.
 */
import { describe, expect, it } from 'vitest';

import { updateBrowserChromeTestContent } from '../rename-browser-test.js';

const BINARY = 'mybrowser';

describe('updateBrowserChromeTestContent', () => {
  it('rewrites the tag, class, underscored form, and test stem', () => {
    const source = [
      'add_task(async function test_sidebar_defined() {',
      '  const ctor = await waitForElement("moz-sidebar");',
      '  Assert.ok(ctor instanceof MozSidebar, "moz-sidebar is defined");',
      '});',
    ].join('\n');

    const out = updateBrowserChromeTestContent(source, 'moz-sidebar', 'moz-nav', BINARY);

    expect(out).toContain('waitForElement("moz-nav")');
    expect(out).toContain('MozNav');
    expect(out).toContain('test_nav_defined');
    expect(out).not.toContain('moz-sidebar');
    expect(out).not.toContain('MozSidebar');
  });

  it('does not rewrite a longer tag that merely starts with the old name', () => {
    // The motivating hazard: renaming `moz-panel` must not touch
    // `moz-panel-group`, a different component entirely.
    const source = [
      'const a = await waitForElement("moz-panel");',
      'const b = await waitForElement("moz-panel-group");',
    ].join('\n');

    const out = updateBrowserChromeTestContent(source, 'moz-panel', 'moz-drawer', BINARY);

    expect(out).toContain('waitForElement("moz-drawer")');
    expect(out).toContain('waitForElement("moz-panel-group")');
  });

  it('does not rewrite an identifier that merely contains the stem', () => {
    // `deriveTestStem('moz-panel')` is the bare fragment `panel`, which an
    // unanchored rule replaces everywhere it appears as a substring.
    const source = [
      'add_task(async function test_panel_defined() {',
      '  const panelHost = document.getElementById("sidepanelHost");',
      '  const repanel = makeRepanel();',
      '});',
    ].join('\n');

    const out = updateBrowserChromeTestContent(source, 'moz-panel', 'moz-drawer', BINARY);

    expect(out).toContain('test_drawer_defined');
    // `panelHost`, `sidepanelHost` and `repanel` are unrelated identifiers.
    expect(out).toContain('panelHost');
    expect(out).toContain('sidepanelHost');
    expect(out).toContain('repanel');
  });

  it('does not rewrite a class name embedded in a longer identifier', () => {
    const source = 'class MozPanelGroupHelper {}\nconst x = MozPanel;';
    const out = updateBrowserChromeTestContent(source, 'moz-panel', 'moz-drawer', BINARY);

    expect(out).toContain('MozPanelGroupHelper');
    expect(out).toContain('MozDrawer;');
  });

  it('does not apply a rule to another rule’s output', () => {
    // The four rewrites were chained `.replace()` calls, so each saw the
    // previous one's output. `acme-widget` -> `acme-widget-v2` rewrote via the
    // underscored form, and the stem rule then matched the `acme_widget` still
    // sitting inside that result: `test_acme_widget_v2_v2_defined`.
    const source = [
      'add_task(async function test_acme_widget_defined() {',
      '  const ctor = await waitForElement("acme-widget");',
      '});',
    ].join('\n');

    const out = updateBrowserChromeTestContent(source, 'acme-widget', 'acme-widget-v2', BINARY);

    expect(out).toContain('test_acme_widget_v2_defined');
    expect(out).not.toContain('_v2_v2');
    expect(out).toContain('waitForElement("acme-widget-v2")');
  });

  it('does not rewrite an unrelated underscore-delimited test name', () => {
    // `deriveTestStem('moz-panel')` is `panel`, and `_` has to stay a legal
    // neighbour for `test_panel_defined` to match at all — which meant
    // `test_panel_group_integration` matched too. The stem is anchored to the
    // one shape the scaffold emits instead.
    const source = [
      'add_task(async function test_panel_defined() {});',
      'add_task(async function test_panel_group_integration() {});',
      'const helper = panel_group_helper;',
    ].join('\n');

    const out = updateBrowserChromeTestContent(source, 'moz-panel', 'moz-drawer', BINARY);

    expect(out).toContain('test_drawer_defined');
    expect(out).toContain('test_panel_group_integration');
    expect(out).toContain('panel_group_helper');
  });

  it('strips the binary prefix when deriving the stem', () => {
    const source = 'add_task(async function test_widget_defined() {});';
    const out = updateBrowserChromeTestContent(
      source,
      `moz-${BINARY}-widget`,
      `moz-${BINARY}-gadget`,
      BINARY
    );
    expect(out).toContain('test_gadget_defined');
  });

  it('renames a hyphen-less tag to its hyphenated form, not the underscored one', () => {
    // With no hyphen in the old name, the underscored form IS the tag, so the
    // underscored rule and the tag rule matched the same text — and mapping by
    // matched text let the underscored rule win, writing `widget_v2` where the
    // tag `widget-v2` was meant.
    const source = 'await customElements.whenDefined("widget");';
    const out = updateBrowserChromeTestContent(source, 'widget', 'widget-v2', BINARY);
    expect(out).toContain('whenDefined("widget-v2")');
    expect(out).not.toContain('widget_v2');
  });

  it('does not rewrite the stem shape inside a longer identifier', () => {
    const source = 'const x = mytest_panel_defined_extra;';
    const out = updateBrowserChromeTestContent(source, 'moz-panel', 'moz-drawer', BINARY);
    expect(out).toContain('mytest_panel_defined_extra');
  });
});
