// SPDX-License-Identifier: EUPL-1.2
import type { FurnaceState } from '../../types/furnace.js';

/**
 * Removes every checksum entry owned by the removed component.
 */
export function dropChecksumsByPrefix(state: FurnaceState, prefix: string): FurnaceState {
  const result = { ...state };
  if (state.appliedChecksums) {
    result.appliedChecksums = Object.fromEntries(
      Object.entries(state.appliedChecksums).filter(([k]) => !k.startsWith(prefix))
    );
  }
  if (state.engineChecksums) {
    result.engineChecksums = Object.fromEntries(
      Object.entries(state.engineChecksums).filter(([k]) => !k.startsWith(prefix))
    );
  }
  return result;
}
