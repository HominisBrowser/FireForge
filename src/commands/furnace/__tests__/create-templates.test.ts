// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { generateMjsContent } from '../create-templates.js';

const LICENSE = '// SPDX-License-Identifier: EUPL-1.2';

describe('generateMjsContent', () => {
  it('omits the FTL preamble when localized is false', () => {
    const mjs = generateMjsContent({
      name: 'my-widget',
      className: 'MyWidget',
      description: 'A widget',
      localized: false,
      header: LICENSE,
      ftlChromeSubPath: 'toolkit/global',
      sharedFtl: undefined,
    });
    expect(mjs).not.toContain('insertFTLIfNeeded');
    expect(mjs).not.toContain('l10n?.connectRoot');
  });

  it('uses the ftlChromeSubPath/name.ftl pattern when localized and no sharedFtl', () => {
    const mjs = generateMjsContent({
      name: 'my-widget',
      className: 'MyWidget',
      description: 'A widget',
      localized: true,
      header: LICENSE,
      ftlChromeSubPath: 'toolkit/global',
      sharedFtl: undefined,
    });
    expect(mjs).toContain('insertFTLIfNeeded("toolkit/global/my-widget.ftl")');
  });

  it('falls back to bare <name>.ftl when ftlChromeSubPath is undefined', () => {
    const mjs = generateMjsContent({
      name: 'my-widget',
      className: 'MyWidget',
      description: 'A widget',
      localized: true,
      header: LICENSE,
      ftlChromeSubPath: undefined,
      sharedFtl: undefined,
    });
    expect(mjs).toContain('insertFTLIfNeeded("my-widget.ftl")');
  });

  it('uses the sharedFtl value verbatim when provided', () => {
    // The shared path is authored by whoever owns the feature bundle and
    // is stored verbatim in furnace.json. The template must emit it
    // unchanged (no chrome-subpath prefixing, no tag-name rewriting),
    // otherwise insertFTLIfNeeded() points at a URI nobody registered.
    const mjs = generateMjsContent({
      name: 'mybrowser-dock-button',
      className: 'MyBrowserDockButton',
      description: 'Dock button',
      localized: true,
      header: LICENSE,
      ftlChromeSubPath: 'toolkit/global',
      sharedFtl: 'browser/mybrowser-dock.ftl',
    });
    expect(mjs).toContain('insertFTLIfNeeded("browser/mybrowser-dock.ftl")');
    // And must not emit the per-component path even though
    // ftlChromeSubPath is set: sharedFtl wins the precedence.
    expect(mjs).not.toContain('insertFTLIfNeeded("toolkit/global/mybrowser-dock-button.ftl")');
  });

  it('still emits the l10n.connectRoot lifecycle hooks when sharedFtl is used', () => {
    // The shared bundle still flows through Fluent the same way a
    // per-component bundle would. Disabling the lifecycle hooks would
    // break l10n on the shadow root.
    const mjs = generateMjsContent({
      name: 'mybrowser-dock-button',
      className: 'MyBrowserDockButton',
      description: 'Dock button',
      localized: true,
      header: LICENSE,
      ftlChromeSubPath: 'toolkit/global',
      sharedFtl: 'browser/mybrowser-dock.ftl',
    });
    expect(mjs).toContain(
      'if (shadowRoot) {\n      this.ownerDocument.l10n?.connectRoot(shadowRoot);'
    );
    expect(mjs).toContain(
      'if (shadowRoot) {\n      this.ownerDocument.l10n?.disconnectRoot(shadowRoot);'
    );
  });

  it('emits strict-checkJs-friendly class metadata and custom element registration', () => {
    const mjs = generateMjsContent({
      name: 'my-widget',
      className: 'MyWidget',
      description: 'A widget',
      localized: false,
      header: LICENSE,
      ftlChromeSubPath: undefined,
      sharedFtl: undefined,
    });

    expect(mjs).toContain('/** @type {Record<string, unknown>} */\n  static properties = {};');
    expect(mjs).toContain(
      'customElements.define("my-widget", /** @type {CustomElementConstructor} */ (MyWidget));'
    );
  });
});
