// SPDX-License-Identifier: EUPL-1.2
// Re-export all validation checks from their focused modules.
export { validateAccessibility } from './furnace-validate-accessibility.js';
export { validateCompatibility } from './furnace-validate-compatibility.js';
export {
  checkRegistrationConsistency,
  validateJarMnEntries,
  validateRegistrationPatterns,
  validateTokenLink,
} from './furnace-validate-registration.js';
export { validateStructure } from './furnace-validate-structure.js';
