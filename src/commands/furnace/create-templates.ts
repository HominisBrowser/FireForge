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
 * Path resolution precedence (when `localized` is true):
 *   1. `sharedFtl` — used verbatim. The caller has resolved it from
 *      `--shared-ftl` / `furnace.json`; this template does no rewriting.
 *      Use this when the component participates in a feature-scoped
 *      bundle that another component owns.
 *   2. `<ftlChromeSubPath>/<name>.ftl` — the default per-component path,
 *      matching the locale jar.mn entry that `furnace apply` writes.
 *   3. `<name>.ftl` — fallback when no chrome sub-path was resolvable.
 */
export function generateMjsContent(
  name: string,
  className: string,
  description: string,
  localized: boolean,
  header: string,
  ftlChromeSubPath: string | undefined,
  sharedFtl: string | undefined
): string {
  const ftlPath =
    sharedFtl !== undefined
      ? sharedFtl
      : ftlChromeSubPath !== undefined
        ? `${ftlChromeSubPath}/${name}.ftl`
        : `${name}.ftl`;
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
  return `test_${name.replace(/-/g, '_')}_packaged.js`;
}

/**
 * Generates an xpcshell test file for a custom component.
 *
 * xpcshell cannot execute a component module that imports
 * `chrome://global/content/vendor/lit.all.mjs` — the Lit bundle touches
 * `window` at module-load time and the xpcshell harness has no `window`
 * global. Before 0.16.0 the scaffold called `ChromeUtils.importESModule`
 * on the component's MJS, which reliably failed with
 * `ReferenceError: window is not defined` for every Lit-based fork
 * component. FireForge's diagnostics then misrouted the failure to the
 * "stale build artifacts" branch, sending operators on a rebuild loop
 * that couldn't fix a runtime-environment incompatibility.
 *
 * The rewrite here mirrors the chrome-doc packaging test: XCurProcD is
 * probed at a pair of candidate layouts (dist/bin/browser and the macOS
 * .app-bundle / ESR layout) to confirm the `.mjs` and `.css` files
 * landed where jar.mn promised. That's the assertion xpcshell CAN make.
 * Functional tests that need DOM/shadow-root/keyboard behaviour belong
 * in a browser-chrome mochitest — scaffolded via
 * `fireforge furnace create --test-style browser-chrome`.
 */
export function generateXpcshellTestContent(name: string, header: string): string {
  const taskSuffix = name.replace(/-/g, '_');
  return `${header}

"use strict";

// Packaging verification for the "${name}" custom component.
//
// Why this is not a module-load test:
//   ChromeUtils.importESModule("chrome://global/content/elements/${name}.mjs")
//   pulls in \`chrome://global/content/vendor/lit.all.mjs\`, which
//   references \`window\` during its module body — there is no \`window\`
//   global in xpcshell, so every attempt throws
//   \`ReferenceError: window is not defined\`. For Lit-based components,
//   xpcshell can only verify that the files reached the packaged tree;
//   functional UI assertions belong in a browser-chrome mochitest
//   (see \`fireforge furnace create --test-style browser-chrome\`).
//
// Out of scope: builds that pack omni.ja (MOZ_CHROME_MULTILOCALE, some
// release configs). The probe assumes an unpacked tree, which is what
// \`mach build\` produces by default. A packed build would need to unzip
// omni.ja to verify the same files.

add_task(async function test_${taskSuffix}_files_packaged() {
  const appDir = Services.dirsvc.get("XCurProcD", Ci.nsIFile);

  // Two candidate layouts are probed per asset:
  //   1) \`<AppDir>/chrome/global/elements/…\` — unpacked layout when
  //      XCurProcD honours \`firefox-appdir = "browser"\` and resolves
  //      into \`dist/bin/browser/\`.
  //   2) \`<AppDir>/browser/chrome/global/elements/…\` — macOS .app
  //      bundle and some ESR layouts where XCurProcD sits one level
  //      above \`browser/\`.
  function probeEither(primary, fallback, description) {
    const primaryFile = appDir.clone();
    for (const segment of primary) {
      primaryFile.append(segment);
    }
    const fallbackFile = appDir.clone();
    for (const segment of fallback) {
      fallbackFile.append(segment);
    }
    const found = primaryFile.exists() ? primaryFile : fallbackFile.exists() ? fallbackFile : null;
    Assert.ok(
      found !== null,
      description +
        " missing at both " +
        primaryFile.path +
        " and " +
        fallbackFile.path +
        ' — run "fireforge build --ui" and retry. If the file IS present at one of those paths, xpcshell is probing a stale build tree.',
    );
    if (found !== null) {
      Assert.greater(
        found.fileSize,
        0,
        description +
          " is zero-length at " +
          found.path +
          " — packaging copied an empty file, check the source template.",
      );
    }
  }

  probeEither(
    ["chrome", "global", "elements", "${name}.mjs"],
    ["browser", "chrome", "global", "elements", "${name}.mjs"],
    "${name}.mjs",
  );
  probeEither(
    ["chrome", "global", "elements", "${name}.css"],
    ["browser", "chrome", "global", "elements", "${name}.css"],
    "${name}.css",
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

/** Returns the canonical mochikit test file basename for a component. */
export function mochikitTestFileName(name: string): string {
  return `test_${name}.html`;
}

/**
 * Generates a MochiKit (chrome://mochikit) test for a custom component.
 *
 * MochiKit tests load the component module directly via the global chrome
 * URI and assert that `customElements.get(<tag>)` returns a constructor.
 * They run on forks whose top-level chrome document lacks a `tabbrowser`
 * (the class of bug that forces `--xpcshell` for storage code) because
 * they do not traverse `URILoadingHelper.openLinkIn`.
 *
 * The scaffold here is a smoke test — the component is defined and the
 * constructor is a function. Real UI assertions (render output, l10n
 * wiring, keyboard interactions) are intentionally left out because they
 * depend on the component's shape; operators can extend the test using
 * the same SimpleTest APIs upstream toolkit widgets (moz-button, etc.)
 * rely on.
 *
 * The template deliberately omits `SimpleTest.waitForExplicitFinish()`.
 * `add_task` owns the test lifecycle: when every queued task resolves,
 * the task harness calls `SimpleTest.finish()` on its own. Combining
 * `waitForExplicitFinish()` with `add_task` *and* no explicit
 * `SimpleTest.finish()` inside the task body makes the harness wait
 * forever, which the 2026-04-21 eval run tripped into as an indefinite
 * hang on a `fireforge test --headless` against a scaffolded widget
 * test. Leaving `waitForExplicitFinish()` out matches the convention
 * upstream toolkit widget tests use (see `test_moz-button.html` and
 * siblings under `toolkit/content/tests/widgets/`).
 */
export function generateMochikitTestContent(name: string): string {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Test the ${name} custom element</title>
    <script src="chrome://mochikit/content/tests/SimpleTest/SimpleTest.js"></script>
    <link rel="stylesheet" href="chrome://mochikit/content/tests/SimpleTest/test.css" />
  </head>
  <body>
    <p id="display"></p>
    <div id="content" style="display: none"></div>
    <pre id="test"></pre>
    <script type="module">
      import "chrome://global/content/elements/${name}.mjs";

      add_task(async function test_${name.replace(/-/g, '_')}_defined() {
        const ctor = await customElements.whenDefined("${name}");
        ok(ctor, "${name} custom element should be defined");
        is(typeof ctor, "function", "Constructor should be a function");
      });
    </script>
  </body>
</html>
`;
}

/**
 * Generates the `chrome.toml` entry block to append for a newly scaffolded
 * mochikit test. When the manifest already exists the caller appends this
 * snippet; when absent, the caller writes a file that starts with a
 * `[DEFAULT]` stanza followed by this block.
 */
export function generateMochikitChromeTomlEntry(name: string): string {
  return `["${mochikitTestFileName(name)}"]\n`;
}

/**
 * Generates the minimal `chrome.toml` used when the file does not yet
 * exist in the tree. Keeps the `[DEFAULT]` stanza empty so each scaffold
 * adds its own per-test entry, matching the stock Firefox convention.
 */
export function generateMochikitChromeTomlSkeleton(header: string): string {
  return `${header}

[DEFAULT]

`;
}
