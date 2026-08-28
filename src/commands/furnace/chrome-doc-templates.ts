// SPDX-License-Identifier: EUPL-1.2
/**
 * File-content templates for `fireforge furnace chrome-doc create`.
 * Extracted so the command entrypoint stays under the per-file LOC budget
 * and each template can be exercised in isolation.
 *
 * The templates here mirror the shape of top-level chrome documents in
 * upstream Firefox (browser.xhtml, privatebrowsing/aboutPrivateBrowsing.html,
 * etc.) minus the fork-specific wiring. A fork author fills in the body.
 */

/**
 * Sentinel attribute emitted on every `furnace chrome-doc create`-scaffolded
 * root element. Platform modules (`DevToolsStartup`, `PageActions`,
 * `SessionStore`, `DownloadsButton`, …) that observe
 * `browser-delayed-startup-finished` and walk INTO the window assume the
 * `browser.xhtml` DOM and throw on anything else. A fork-authored patch
 * to such a module can use `hasAttribute(...)` against this sentinel as
 * a cheap, fork-neutral guard to skip the walk on a custom chrome doc.
 *
 * Exposed as a named constant so test code and external checks can
 * reference the exact attribute name without hardcoding the string.
 */
const FURNACE_CHROME_DOC_SENTINEL = 'data-furnace-chrome-doc';

/**
 * XHTML shell for a top-level chrome document.
 *
 * The emitted document:
 * - When `withTitlebar` is true, declares the `navigator:browser` minimum
 *   set: `windowtype`, `customtitlebar`, default `width`/`height`, and a
 *   `persist` allowlist for screen position + size + sizemode. Without
 *   these, a fork-owned chrome doc that ships as the main window opens
 *   at the OS intrinsic minimum size on first launch and forgets the
 *   user's last-known geometry across restarts. The titlebar-buttonbox
 *   placeholder is emitted alongside so platform-native window controls
 *   render with the matching CSS rules from `generateChromeDocCss`.
 * - Loads `chrome://global/content/customElements.js` in `<head>` ahead
 *   of the per-doc subscript. Without it, every `<moz-*>` widget the
 *   author drops into the body silently degrades to `HTMLUnknownElement`
 *   and the upstream a11y/keyboard semantics that motivated the use of
 *   the toolkit widget in the first place are lost. Matches the
 *   `webrtcIndicator.xhtml` shape upstream uses for non-`browser.xhtml`
 *   chrome documents.
 * - Links the per-document CSS at `chrome://browser/content/<name>-chrome.css`
 *   and the Fluent bundle `browser/<name>.ftl`.
 * - Keeps `data-l10n-id` on the leaf `<title>` only. Binding the same key
 *   on the root `<window>` would cause Fluent's first-paint translation
 *   pass to overwrite the entire body subtree with the message's text
 *   value (the standard `data-l10n-id`-on-non-leaf failure mode), since
 *   the FTL stub gives `<name>-window-title` a value rather than an
 *   attribute-only message.
 * - Carries the `data-furnace-chrome-doc="<name>"` sentinel so fork-side
 *   patches to upstream platform modules (DevToolsStartup, PageActions, …)
 *   that assume `browser.xhtml`'s DOM can guard against it cheaply. See
 *   the README "Platform module compatibility" section for the pattern.
 */
export function generateChromeDocXhtml(
  name: string,
  withTitlebar: boolean,
  license: string
): string {
  // navigator:browser minimum set. Carrying every attribute together —
  // not just `windowtype` — lets a fork that uses the scaffold output
  // verbatim launch as a real main window: `customtitlebar` opts into the
  // platform-native title bar handling that pairs with the buttonbox
  // markup below, the explicit width/height avoid the OS-minimum first
  // launch, and `persist` lets the platform remember geometry across
  // restarts via XULStore.
  const navigatorBrowserAttrs = withTitlebar
    ? ` windowtype="navigator:browser"
    customtitlebar="true"
    width="1024"
    height="640"
    persist="screenX screenY width height sizemode"`
    : '';
  const titlebarMarkup = withTitlebar
    ? `
    <hbox class="titlebar-buttonbox-container">
      <hbox class="titlebar-buttonbox"></hbox>
    </hbox>`
    : '';

  return `<?xml version="1.0"?>
<!-- SPDX-License-Identifier: ${license} -->
<!DOCTYPE window>
<window
    xmlns="http://www.w3.org/1999/xhtml"
    xmlns:xul="http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul"
    id="${name}-window"${navigatorBrowserAttrs}
    ${FURNACE_CHROME_DOC_SENTINEL}="${name}"
    role="application">
  <head>
    <meta charset="utf-8" />
    <title data-l10n-id="${name}-window-title"></title>
    <link rel="localization" href="browser/${name}.ftl" />
    <link rel="stylesheet" href="chrome://global/skin/global.css" />
    <link rel="stylesheet" href="chrome://browser/content/${name}-chrome.css" />
    <script src="chrome://global/content/customElements.js"></script>
    <script src="chrome://browser/content/${name}.js"></script>
  </head>
  <body>${titlebarMarkup}
    <main id="${name}-main"></main>
  </body>
</window>
`;
}

/**
 * browser.xhtml-like scaffold for the document that ships as the fork's MAIN
 * BROWSER WINDOW.
 *
 * The generic dialog-shaped `<window>` scaffold is wrong for the
 * `tokenHostDocuments[0]` / BROWSER_CHROME_URL target: platform C++ reads
 * the root element BEFORE any script runs, and expects the `browser.xhtml`
 * shape:
 *
 * - `<html id="main-window">` root (not `<window id="<name>-window">`) —
 *   upstream code from nsXULWindow sizing to session restore looks up
 *   `main-window` by id;
 * - `windowtype="navigator:browser"`, `chromehidden=""` and the geometry
 *   `persist` allowlist declared as ROOT ATTRIBUTES so the platform's
 *   pre-script pass (window tracking, XULStore geometry, chrome flags) sees
 *   them;
 * - the same head/bootstrap wiring (customElements.js, per-doc subscript,
 *   CSS + Fluent links) and `data-furnace-chrome-doc` sentinel as the
 *   generic scaffold, so jar.mn registration and the platform-module guard
 *   pattern are unchanged.
 */
export function generateBrowserWindowXhtml(name: string, license: string): string {
  return `<?xml version="1.0"?>
<!-- SPDX-License-Identifier: ${license} -->
<html
    xmlns="http://www.w3.org/1999/xhtml"
    xmlns:xul="http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul"
    id="main-window"
    windowtype="navigator:browser"
    customtitlebar="true"
    chromehidden=""
    width="1024"
    height="640"
    persist="screenX screenY width height sizemode"
    ${FURNACE_CHROME_DOC_SENTINEL}="${name}"
    role="application">
  <head>
    <meta charset="utf-8" />
    <title data-l10n-id="${name}-window-title"></title>
    <link rel="localization" href="browser/${name}.ftl" />
    <link rel="stylesheet" href="chrome://global/skin/global.css" />
    <link rel="stylesheet" href="chrome://browser/content/${name}-chrome.css" />
    <script src="chrome://global/content/customElements.js"></script>
    <script src="chrome://browser/content/${name}.js"></script>
  </head>
  <body>
    <hbox class="titlebar-buttonbox-container">
      <hbox class="titlebar-buttonbox"></hbox>
    </hbox>
    <main id="${name}-main"></main>
  </body>
</html>
`;
}

/**
 * ESM bootstrap script for the chrome document.
 *
 * The generated script fires a startup observer topic on the first idle
 * callback so other chrome code can wait on the document being ready.
 * Mirrors the pattern FireForge-built forks use to coordinate per-window
 * init across multiple top-level documents.
 */
export function generateChromeDocJs(name: string, licenseHeader: string): string {
  const topic = `${name}-startup`;
  return `${licenseHeader}

"use strict";

// Fire a startup topic on first idle so subscribers can defer their own
// init until this document is ready. Observers see the document element as
// the subject; use \`aSubject instanceof Ci.nsIDOMWindow\` if you need the
// containing window instead.
window.addEventListener(
  "DOMContentLoaded",
  () => {
    window.requestIdleCallback?.(() => {
      try {
        Services.obs.notifyObservers(document.documentElement, "${topic}");
      } catch (error) {
        // Observer notifications should never block document init — log
        // but don't throw so a missing observer service (headless / test
        // harness) still leaves the document usable.
        console.error("Failed to fire ${topic} observer:", error);
      }
    });
  },
  { once: true }
);
`;
}

/**
 * Scoped CSS for a chrome document.
 *
 * When `withTitlebar` is true, the matching navigator:browser minimum
 * CSS is emitted alongside the layout rules: the buttonbox container is
 * a draggable region (`-moz-window-dragging: drag`) so the user can drag
 * the window from the title bar, and the buttonbox itself opts into the
 * platform-native window-button-box appearance so the OS renders the
 * traffic-light / minimize-maximize-close controls in their canonical
 * positions. Without these rules the buttonbox markup still draws but
 * is unstyled and non-draggable, which is the failure mode a fork that
 * ships the scaffold verbatim hits on first launch.
 *
 * When `withTitlebar` is false the macOS `.titlebar-button { display: none }`
 * carve-out is emitted so frameless overlay-style documents don't inherit
 * the platform window controls that `global.css` applies by default.
 */
export function generateChromeDocCss(
  name: string,
  withTitlebar: boolean,
  licenseHeader: string
): string {
  const titlebarOverrides = withTitlebar
    ? `

/* navigator:browser minimum titlebar styling. Pairs with the
   \`customtitlebar="true"\` + \`titlebar-buttonbox\` markup the XHTML
   template emits when --with-titlebar is set. The container is the drag
   region; the inner buttonbox opts into the platform-native traffic
   light / minimize-maximize-close appearance via \`-moz-window-button-box\`. */
.titlebar-buttonbox-container {
  -moz-window-dragging: drag;
  display: flex;
  align-items: center;
}

.titlebar-buttonbox {
  appearance: auto;
  -moz-default-appearance: -moz-window-button-box;
}
`
    : `

/* Frameless overlay — suppress the platform titlebar buttons that
   global.css inherits on macOS. Without this carve-out the traffic-light
   controls render even though the document has no titlebar-buttonbox. */
:root[windowtype="navigator:browser"] .titlebar-button {
  display: none;
}
`;

  return `${licenseHeader}

:root {
  --${name}-padding: 16px;
}

#${name}-window {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

#${name}-main {
  flex: 1;
  padding: var(--${name}-padding);
}${titlebarOverrides}
`;
}

/** Fluent stub — one placeholder message keyed to the window title. */
export function generateChromeDocFtl(name: string, licenseHeader: string): string {
  return `${licenseHeader}

${name}-window-title = ${name}
`;
}

/**
 * Single-line jar.mn entry that registers an xhtml + js pair under
 * `content/browser/`.
 *
 * Neither emitted line carries the `*` preprocessor flag. The scaffolded
 * XHTML and JS contain no `#filter` / `#expand` / `#include` directives,
 * and mach's `process_install_manifest.py` fails the whole package step
 * with "no preprocessor directives found" when a preprocessed entry has
 * nothing for the preprocessor to do. A fork that later needs brand
 * substitution can re-introduce `*` and add a top-of-file
 * `#filter substitution` directive itself.
 */
export function jarMnEntriesForChromeDoc(name: string): string[] {
  return [
    `    content/browser/${name}.xhtml                (content/${name}.xhtml)`,
    `    content/browser/${name}.js                   (content/${name}.js)`,
  ];
}

/**
 * jar.inc.mn entry that registers the scoped CSS under `content/browser/`.
 *
 * The source path is `../shared/<name>-chrome.css` because `jar.inc.mn` is
 * included from each theme-specific manifest (`browser/themes/osx/jar.mn`,
 * `.../linux/`, `.../windows/`), and every existing entry in those manifests
 * resolves paths relative to the INCLUDING manifest's directory. A bare
 * `(shared/…)` path resolves to
 * `obj-.../browser/themes/osx/shared/<name>-chrome.css`, which does not
 * exist.
 */
export function jarIncMnEntryForChromeDoc(name: string): string {
  return `    content/browser/${name}-chrome.css           (../shared/${name}-chrome.css)`;
}

/**
 * locales/jar.mn entry that registers the `.ftl` under the browser locale
 * bundle. The source path is resolved by mach-locale-jar relative to the
 * per-locale root (e.g. `engine/browser/locales/en-US/`), and the FTL file
 * is scaffolded at `browser/${name}.ftl` under that root — the `%` prefix
 * means "per-locale content" and the `browser/` subdirectory matches where
 * the scaffolder writes. A bare `(%${name}.ftl)` points at
 * `en-US/${name}.ftl` and breaks the first post-scaffold build with
 * "jar.mn: Cannot find ${name}.ftl".
 */
export function localeJarMnEntryForChromeDoc(name: string): string {
  return `    locale/browser/${name}.ftl                    (%browser/${name}.ftl)`;
}

/**
 * Returns true when `jarMnContents` already carries a `[localization]`-style
 * wildcard rooted at `%browser/` whose pattern would already pick up a
 * scaffolded `browser/<name>.ftl` file. Recognises:
 *
 *   - `(%browser/**\/*.ftl)` — recursive (the upstream shape).
 *   - `(%browser/*.ftl)` — flat.
 *
 * Forks that have migrated entirely to `[localization]` wildcards typically
 * keep no per-file `locale/...` entries for FTL at all; appending one
 * there is dead weight at best, and an outright build break when the fork
 * has also dropped the `% locale browser …` registration. The chrome-doc
 * scaffolder consults this predicate before its locales/jar.mn append and
 * skips the per-file write when the wildcard already covers the scaffold's
 * target path.
 *
 * Conservative by design: only wildcards rooted at `%browser/` count, and
 * a `(%browser/foo.ftl)`-style explicit reference (no `*`) is not treated
 * as a capture. A fork with a narrower wildcard (e.g. `(%browser/about/*.ftl)`)
 * is correctly NOT captured by this predicate, because that wildcard would
 * not pick up the top-level `browser/<name>.ftl` the scaffold writes.
 */
export function localesFtlWildcardCapturesScaffoldedName(jarMnContents: string): boolean {
  return /\(%browser\/(?:\*\*\/)?\*\.ftl\)/.test(jarMnContents);
}
