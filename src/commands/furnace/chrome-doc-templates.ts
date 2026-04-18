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
 * XHTML shell for a top-level chrome document.
 *
 * The emitted document:
 * - Declares `windowtype="navigator:browser"` when `withTitlebar` is true
 *   so chrome-wide stylesheets that target the browser window still apply.
 * - Emits a titlebar-buttonbox placeholder when `withTitlebar` is true so
 *   platform-native window controls render.
 * - Links the per-document CSS at `chrome://browser/content/<name>-chrome.css`
 *   and the Fluent bundle `browser/<name>.ftl`.
 */
export function generateChromeDocXhtml(
  name: string,
  withTitlebar: boolean,
  license: string
): string {
  const windowAttr = withTitlebar ? ' windowtype="navigator:browser"' : '';
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
    id="${name}-window"${windowAttr}
    data-l10n-id="${name}-window-title"
    role="application">
  <head>
    <meta charset="utf-8" />
    <title data-l10n-id="${name}-window-title"></title>
    <link rel="localization" href="browser/${name}.ftl" />
    <link rel="stylesheet" href="chrome://global/skin/global.css" />
    <link rel="stylesheet" href="chrome://browser/content/${name}-chrome.css" />
    <script src="chrome://browser/content/${name}.js"></script>
  </head>
  <body>${titlebarMarkup}
    <main id="${name}-main"></main>
  </body>
</window>
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
 * Scoped CSS for a chrome document. When `withTitlebar` is false the
 * macOS `.titlebar-button { display: none }` carve-out is emitted so
 * frameless overlay-style documents don't inherit the platform window
 * controls that `global.css` applies by default.
 */
export function generateChromeDocCss(
  name: string,
  withTitlebar: boolean,
  licenseHeader: string
): string {
  const titlebarOverrides = withTitlebar
    ? ''
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
 * `content/browser/`. Emits the `*` preprocessor flag so both files flow
 * through `#filter substitution` for FireForge brand-name substitution.
 */
export function jarMnEntriesForChromeDoc(name: string): string[] {
  return [
    `*   content/browser/${name}.xhtml                (content/${name}.xhtml)`,
    `    content/browser/${name}.js                   (content/${name}.js)`,
  ];
}

/** jar.inc.mn entry that registers the scoped CSS under `content/browser/`. */
export function jarIncMnEntryForChromeDoc(name: string): string {
  return `    content/browser/${name}-chrome.css           (shared/${name}-chrome.css)`;
}

/** locales/jar.mn entry that registers the `.ftl` under the browser locale bundle. */
export function localeJarMnEntryForChromeDoc(name: string): string {
  return `    locale/browser/${name}.ftl                    (%${name}.ftl)`;
}
