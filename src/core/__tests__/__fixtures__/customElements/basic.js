/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Test fixture: minimal customElements.js shape with a single-line legacy
// Pattern A array (loadSubScript) and a single-line ESM Pattern B array
// inside DOMContentLoaded.

for (let [tag, script] of [
  ['findbar', 'chrome://global/content/elements/findbar.js'],
  ['panel-list', 'chrome://global/content/elements/panel-list.js'],
]) {
  customElements.setElementCreationCallback(tag, () => {
    Services.scriptloader.loadSubScript(script, window);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  for (let [tag, script] of [
    ['moz-button', 'chrome://global/content/elements/moz-button.mjs'],
    ['moz-card', 'chrome://global/content/elements/moz-card.mjs'],
  ]) {
    customElements.setElementCreationCallback(tag, () => {
      ChromeUtils.importESModule(script);
    });
  }
});
