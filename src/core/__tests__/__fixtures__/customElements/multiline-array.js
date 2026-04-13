/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Test fixture: customElements.js where each [tag, url] entry is split
// across multiple lines. The AST module should preserve this multiline
// formatting when inserting a new entry.

for (let [tag, script] of [['findbar', 'chrome://global/content/elements/findbar.js']]) {
  customElements.setElementCreationCallback(tag, () => {
    Services.scriptloader.loadSubScript(script, window);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  for (let [tag, script] of [
    [
      'moz-button',
      'chrome://global/content/elements/moz-button.mjs',
    ],
    [
      'moz-toggle',
      'chrome://global/content/elements/moz-toggle.mjs',
    ],
  ]) {
    customElements.setElementCreationCallback(tag, () => {
      ChromeUtils.importESModule(script);
    });
  }
});
