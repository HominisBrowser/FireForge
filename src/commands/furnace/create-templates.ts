// SPDX-License-Identifier: EUPL-1.2
/**
 * File-content templates for `fireforge furnace create`. Extracted from the
 * command entrypoint so the generator is unit-testable in isolation and the
 * command file stays under the per-file LOC budget.
 */

/**
 * Generates the .mjs file content for a custom component.
 *
 * `MozLitElement` does NOT expose `insertFTLIfNeeded` — that method lives on
 * `MozXULElement`. Calling it from `connectedCallback` on a Lit-based
 * component throws `TypeError: this.insertFTLIfNeeded is not a function` at
 * every connect. Upstream Firefox components (e.g. `moz-input-folder.mjs`)
 * solve this with a module-level guarded call on `window.MozXULElement` and
 * per-instance shadow-DOM Fluent attachment via `l10n.connectRoot`. We mirror
 * that pattern here so `--localized` produces functional code.
 *
 * The FTL path mirrors the locale jar.mn entry that `furnace apply` writes:
 * `<ftlChromeSubPath>/<name>.ftl`. For the default `toolkit/global` tree this
 * yields `toolkit/global/<name>.ftl`, which matches the URI upstream toolkit
 * widgets ship.
 */
export function generateMjsContent(
  name: string,
  className: string,
  description: string,
  localized: boolean,
  header: string,
  ftlChromeSubPath: string | undefined
): string {
  const ftlPath =
    ftlChromeSubPath !== undefined ? `${ftlChromeSubPath}/${name}.ftl` : `${name}.ftl`;
  const ftlModulePreamble = localized
    ? `
window.MozXULElement?.insertFTLIfNeeded("${ftlPath}");
`
    : '';

  const lifecycleHooks = localized
    ? `
  connectedCallback() {
    super.connectedCallback();
    this.ownerDocument.l10n?.connectRoot(this.shadowRoot);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.ownerDocument.l10n?.disconnectRoot(this.shadowRoot);
  }
`
    : '';

  return `${header}

import { html } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";
${ftlModulePreamble}
/**
 * ${description || name}
 *
 * @tagname ${name}
 */
class ${className} extends MozLitElement {
  static properties = {};

  constructor() {
    super();
  }
${lifecycleHooks}
  render() {
    return html\`
      <link rel="stylesheet" href="chrome://global/content/elements/${name}.css" />
      <slot></slot>
    \`;
  }
}
customElements.define("${name}", ${className});
`;
}

/** Generates the .css file content for a custom component. */
export function generateCssContent(header: string): string {
  return `${header}

:host {
  display: block;
}
`;
}

/** Generates the .ftl file content for a custom component. */
export function generateFtlContent(name: string, header: string): string {
  return `${header}

## Strings for the ${name} component
`;
}

/** Returns the canonical xpcshell test file basename for a component. */
export function xpcshellTestFileName(name: string): string {
  return `test_${name.replace(/-/g, '_')}_module_loads.js`;
}

/**
 * Generates an xpcshell test file for a custom component.
 *
 * xpcshell tests run headless without a `tabbrowser`, so they suit
 * storage/observer/module-loading code in forks that do not mount the
 * upstream browser chrome (and therefore lack `openLinkIn` →
 * `URILoadingHelper`). The scaffold imports the component module via
 * `ChromeUtils.importESModule` and asserts the module resolves — enough
 * to catch registration regressions without touching DOM rendering paths
 * that xpcshell cannot execute.
 */
export function generateXpcshellTestContent(name: string, header: string): string {
  return `${header}

"use strict";

add_task(async function test_${name.replace(/-/g, '_')}_module_loads() {
  // Module-load smoke check: resolves the ESM at its registered chrome URI.
  // Replace or extend with storage-layer assertions as the component grows
  // (Services.storage, observer topics, JSONFile, etc. are all available
  // here without a tabbrowser).
  const moduleUri = "chrome://global/content/elements/${name}.mjs";
  const module = await ChromeUtils.importESModule(moduleUri);
  Assert.ok(
    module,
    "${name}.mjs should load under xpcshell (storage-layer code path).",
  );
});
`;
}

/**
 * Generates an `xpcshell.toml` manifest for a custom component's test
 * directory. Kept minimal — adding prefs, head.js, and support-files is
 * left to the operator because those decisions depend on what the
 * component actually touches (Services.storage, observer topics, etc.).
 */
export function generateXpcshellManifestContent(name: string, header: string): string {
  return `${header}

[DEFAULT]
head = ""

["${xpcshellTestFileName(name)}"]
`;
}
