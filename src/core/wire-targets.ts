// SPDX-License-Identifier: EUPL-1.2
/**
 * Wire targets barrel — re-exports all wiring target modules.
 */

export { addDestroyAST, addDestroyToBrowserInit, legacyAddDestroy } from './wire-destroy.js';
export {
  addDomFragment,
  addDomFragmentTokenized,
  legacyAddDomFragment,
} from './wire-dom-fragment.js';
export { addInitAST, addInitToBrowserInit, legacyAddInit } from './wire-init.js';
export {
  addSubscriptAST,
  addSubscriptToBrowserMain,
  legacyAddSubscript,
} from './wire-subscript.js';
