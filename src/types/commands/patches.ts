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
  /** ESR version the patch was created against (e.g., "140.9.0esr") */
  sourceEsrVersion: string;
  /** Array of file paths affected by this patch */
  filesAffected: string[];
  /**
   * Optional per-patch list of lint check IDs to suppress when this patch
   * is the target of `export`, `export-all`, or `re-export`. Exists for
   * the class of patch that is advisory-noisy by nature — a cohesive
   * branding bundle, a localised-resource pack, an auto-generated
   * manifest — where the generic `large-patch-lines` / `large-patch-files`
   * thresholds do not apply but `--skip-lint` (which silences *all*
   * errors, not just the one that does not apply) is too coarse a hammer.
   *
   * Previously the only escape hatches were `--skip-lint` (blunt) or the
   * full `rebase` flow (refreshes the same patch through a code path that
   * silently skips `runPatchLint` — an asymmetry that forced operators
   * through a multi-minute Firefox source re-download just to refresh
   * one patch body).
   *
   * Values are free-form check IDs (e.g. `"large-patch-lines"`,
   * `"large-patch-files"`). Checks not listed here still run normally.
   * An entry for an unknown check ID is a no-op — the patch metadata
   * documents the *intent* to suppress even if the check is later
   * renamed or removed.
   */
  lintIgnore?: string[];
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
  /**
   * Stable machine-readable identity for this finding.
   *
   * Use when the human-readable `message` may drift between otherwise
   * equivalent runs (for example because a rule embeds line numbers,
   * rename-sensitive patch filenames, or other contextual detail).
   * Consumers that diff lint outputs should prefer this over `message`
   * when it is present.
   */
  fingerprint?: string;
  /** Human-readable description of the issue */
  message: string;
  /** Severity: errors block export, warnings are advisory, notices are informational (not counted) */
  severity: 'error' | 'warning' | 'notice';
  /**
   * Diff-scoping tag populated by `lint --since <rev>`. Absent when the
   * caller did not request diff-scoping.
   *
   * - `introduced` — the issue's file was touched in the diff since `<rev>`.
   * - `cumulative` — the issue is pre-existing patch-state drift not
   *   introduced by the current task.
   */
  tag?: 'introduced' | 'cumulative';
}
