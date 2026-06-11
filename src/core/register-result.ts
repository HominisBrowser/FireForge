// SPDX-License-Identifier: EUPL-1.2
/**
 * Shared result shape for manifest registration operations, split out of
 * the `manifest-register.ts` barrel so the `register-*` leaf modules can
 * import it without importing the barrel that re-exports them — that
 * type-only back-edge made the registration dependency graph cyclic.
 */

/**
 * Result of a manifest registration operation.
 */
export interface RegisterResult {
  /** The manifest file that was modified */
  manifest: string;
  /** The entry that was inserted */
  entry: string;
  /** The entry after which the new entry was inserted (for user display) */
  previousEntry?: string | undefined;
  /** Whether the entry already existed (skipped) */
  skipped: boolean;
  /** Whether --after target was not found and fell back to alphabetical */
  afterFallback?: boolean | undefined;
}
