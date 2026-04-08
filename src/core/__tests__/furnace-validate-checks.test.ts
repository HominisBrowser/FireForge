// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { validateAccessibility as directValidateAccessibility } from '../furnace-validate-accessibility.js';
import {
  checkRegistrationConsistency,
  validateAccessibility,
  validateCompatibility,
  validateJarMnEntries,
  validateRegistrationPatterns,
  validateStructure,
  validateTokenLink,
} from '../furnace-validate-checks.js';
import { validateCompatibility as directValidateCompatibility } from '../furnace-validate-compatibility.js';
import {
  checkRegistrationConsistency as directCheckRegistrationConsistency,
  validateJarMnEntries as directValidateJarMnEntries,
  validateRegistrationPatterns as directValidateRegistrationPatterns,
  validateTokenLink as directValidateTokenLink,
} from '../furnace-validate-registration.js';
import { validateStructure as directValidateStructure } from '../furnace-validate-structure.js';

describe('furnace-validate-checks exports', () => {
  it('re-exports the focused validation helpers', () => {
    expect(validateStructure).toBe(directValidateStructure);
    expect(validateAccessibility).toBe(directValidateAccessibility);
    expect(validateCompatibility).toBe(directValidateCompatibility);
    expect(validateRegistrationPatterns).toBe(directValidateRegistrationPatterns);
    expect(checkRegistrationConsistency).toBe(directCheckRegistrationConsistency);
    expect(validateJarMnEntries).toBe(directValidateJarMnEntries);
    expect(validateTokenLink).toBe(directValidateTokenLink);
  });
});
