// SPDX-License-Identifier: EUPL-1.2
import type { OverrideComponentConfig } from '../types/furnace.js';

/** The source files Furnace deploys for an upstream widget override. */
export function isOverrideCopyCandidate(
  entryName: string,
  type: OverrideComponentConfig['type']
): boolean {
  if (entryName === 'override.json') {
    return false;
  }

  if (type === 'css-only') {
    return entryName.endsWith('.css');
  }

  return entryName.endsWith('.mjs') || entryName.endsWith('.css') || entryName.endsWith('.ftl');
}
