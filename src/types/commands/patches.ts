// SPDX-License-Identifier: EUPL-1.2
/**
 * Types for the patch system: patch metadata, manifests, lint, and import results.
 */

/**
 * Patch categories for organizational classification.
 */
export type PatchCategory = 'branding' | 'ui' | 'privacy' | 'security' | 'infra';

/**
 * Information about a patch file.
 */
export interface PatchInfo {
  /** Full path to patch file */
  path: string;
  /** Filename without directory */
  filename: string;
  /** Order index (extracted from filename prefix like "001-") */
  order: number;
}

/**
 * Result of patch application.
 */
export interface PatchResult {
  /** Patch that was applied */
  patch: PatchInfo;
  /** Whether application succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Files that caused conflicts (if failed) */
  conflictingFiles?: string[];
  /** Whether the patch was auto-resolved (new file vs existing file conflict) */
  autoResolved?: boolean;
}

/**
 * Extended patch information with metadata.
 */
export interface PatchMetadata {
  /** Patch filename (e.g., "011-ui-sidebar.patch") */
  filename: string;
  /** Numeric order for application sequence */
  order: number;
  /** Category classification */
  category: PatchCategory;
  /** Human-readable name */
  name: string;
  /** Detailed description of what the patch does */
  description: string;
  /** ISO timestamp of when the patch was created */
  createdAt: string;
  /** ESR version the patch was created against (e.g., "140.0esr") */
  sourceEsrVersion: string;
  /** Array of file paths affected by this patch */
  filesAffected: string[];
}

/**
 * Schema for patches/patches.json file.
 */
export interface PatchesManifest {
  /** Schema version for future compatibility */
  version: 1;
  /** Array of patch metadata entries */
  patches: PatchMetadata[];
}

/**
 * Summary of import operation with continue mode.
 */
export interface ImportSummary {
  /** Total patches processed */
  total: number;
  /** Successfully applied patches */
  succeeded: PatchResult[];
  /** Failed patches */
  failed: PatchResult[];
  /** Skipped patches (not attempted after failure in default mode) */
  skipped: PatchInfo[];
}

/**
 * A single lint issue found in a patched CSS file.
 */
export interface PatchLintIssue {
  /** File path (relative to engine root) */
  file: string;
  /** Check identifier (e.g. "raw-color-value", "token-prefix-violation") */
  check: string;
  /** Human-readable description of the issue */
  message: string;
  /** Severity: errors block export, warnings are advisory */
  severity: 'error' | 'warning';
}
