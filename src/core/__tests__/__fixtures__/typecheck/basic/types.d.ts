// Project-supplied extra shim. Augments the built-in Firefox-globals
// shim with a fictitious component-base symbol.
declare class MozMyBrowserBase {
  attachShadow(init: { mode: 'open' | 'closed' }): ShadowRoot;
}
