// A widget whose query getter is typed through MozLitElementWith: a class
// field would redefine the getter MozLitElement installs, and a constructor
// declaration would read it before renderRoot exists.
import { MozLitElement } from 'chrome://global/content/lit-utils.mjs';

const Base = /** @type {MozLitElementWith<{ input: HTMLInputElement }>} */ (MozLitElement);

export class MozQueries extends Base {
  static queries = { input: 'input' };

  focusInput() {
    this.input.focus();
    return this.updateComplete;
  }

  misspelt() {
    // Intentional bug: the query is input.
    return this.inptu;
  }
}
