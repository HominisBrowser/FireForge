// SPDX-License-Identifier: EUPL-1.2
import { InvalidArgumentError } from '../errors/base.js';

/**
 * Validates that a brand override matches the configured brand.
 * @param configuredBrand - The brand configured in fireforge.json
 * @param requestedBrand - The brand requested via CLI flag
 * @throws InvalidArgumentError if the brands don't match
 */
export function validateBrandOverride(configuredBrand: string, requestedBrand?: string): void {
  if (!requestedBrand || requestedBrand === configuredBrand) {
    return;
  }

  throw new InvalidArgumentError(
    `Brand override "${requestedBrand}" is not supported yet. FireForge currently operates only on the configured brand "${configuredBrand}".`,
    'brand'
  );
}
