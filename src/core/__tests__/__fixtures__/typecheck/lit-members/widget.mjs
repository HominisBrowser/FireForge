// A Furnace-style widget host. With typecheck.litTypes, Lit's and
// MozLitElement's real members typecheck and a misspelt one does not.
import { html } from 'chrome://global/content/vendor/lit.all.mjs';
import { MozLitElement } from 'chrome://global/content/lit-utils.mjs';

export class MozThing extends MozLitElement {
  static properties = { label: { type: String } };

  constructor() {
    super();
    this.label = '';
  }

  render() {
    return html`<p>${this.label}</p>`;
  }

  firstUpdated() {
    this.requestUpdate();
    this.dispatchOnUpdateComplete(new Event('thing-ready'));
  }

  ready() {
    // Intentional bug: the member is updateComplete.
    return this.updateCompelte;
  }
}
