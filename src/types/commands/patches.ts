// SPDX-License-Identifier: EUPL-1.2
/**
 * Types for the patch system: patch metadata, manifests, lint, and import results.
 */

import type { FirefoxProduct } from '../config.js';

/**
 * Patch categories for organizational classification.
 */
export type PatchCategory = string;

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
  /**
   * Pre-existing content of files the auto-resolve overwrote, keyed by
   * engine-relative path. Kept for the RUN's duration (not just the retry):
   * if a later patch fails and `rollbackPatches` reverse-applies this one,
   * reversing a new-file patch DELETES the file — these snapshots are the
   * only way to restore what was there before the auto-resolve.
   */
  autoResolvedOriginals?: Map<string, string>;
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
  /**
   * Deprecated compatibility alias for the source version the patch was
   * created against. New writes also include `sourceVersion`.
   */
  sourceEsrVersion: string;
  /** Firefox source product the patch was created against. */
  sourceProduct?: FirefoxProduct;
  /** Firefox source version the patch was created against. */
  sourceVersion?: string;
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
  /**
   * Optional per-patch threshold-tier override for the `large-patch-lines`
   * rule. Exists for branding patches that must touch a small number of
   * cross-cutting registration files alongside `browser/branding/<name>/`
   * (notably `browser/moz.configure` to register the new branding flavor
   * with the top-level configure). The narrow auto-detect allowlist in
   * `isBrandingOnlyPatch` covers the canonical shape, but a fork whose
   * branding patch also touches an unlisted sibling (for example a
   * `browser/themes/<name>/` override or a vendor-specific icon
   * resource) falls through to the general tier and trips the hard
   * limit on what is legitimately one branding diff.
   *
   * Declaring `tier: "branding"` here forces the branding thresholds
   * (notice 8000 / warning 18000 / error 30000 lines, ≤60 files)
   * regardless of `filesAffected`. The tier is the weaker claim than
   * test — a patch of all-tests still lands in the test tier even if
   * this field is set, because the test-tier thresholds are already
   * more permissive and a test that is also branding-shaped is
   * vanishingly rare.
   *
   * Only `"branding"` is currently recognised. Unknown values are
   * rejected by the manifest validator, not silently stripped.
   */
  tier?: 'branding';
  /**
   * Optional declarations for intentional staged dependencies between
   * patches. These are metadata-only escape hatches for cases where an
   * early patch must import or register a helper created later in the
   * queue during a staged migration. They keep tooling-specific markers
   * out of Firefox source while remaining exact enough that unrelated
   * forward imports still fail.
   */
  stagedDependencies?: PatchStagedDependencies;
}

/** Staged dependency metadata owned by a patch. */
export interface PatchStagedDependencies {
  /** Exact forward-import declarations allowed for this patch. */
  forwardImports?: PatchStagedForwardImport[];
  /**
   * Registration-shaped forward dependencies: packaging or registration
   * LINES (a jar.mn entry, a customElements registration, an actor
   * registration) this patch adds that reference a file a later patch
   * creates. Unlike `forwardImports`, these are validated by matching the
   * declared line against the patch's added content, not by finding an
   * import specifier — packaging lines have no import to match.
   */
  registrations?: PatchStagedRegistration[];
}

/** A single intentional forward import to a later-created file. */
export interface PatchStagedForwardImport {
  /** Importing file path relative to engine/. */
  file: string;
  /** Exact import specifier as it appears in source. */
  specifier: string;
  /** Later-created file path relative to engine/. */
  creates: string;
  /** Optional exact patch filename expected to create `creates`. */
  owner?: string;
  /** Optional human-readable rationale for the staged dependency. */
  reason?: string;
}

/**
 * A single intentional registration/packaging line referencing a
 * later-created file.
 */
export interface PatchStagedRegistration {
  /** Declaring file path relative to engine/ (e.g. `toolkit/content/jar.mn`). */
  file: string;
  /**
   * The registration/packaging line exactly as the patch adds it. Compared
   * whitespace-trimmed against the patch's added lines in `file`, so
   * indentation differences do not break the match.
   */
  line: string;
  /** Later-created file path relative to engine/. */
  creates: string;
  /** Optional exact patch filename expected to create `creates`. */
  owner?: string;
  /** Optional human-readable rationale for the staged dependency. */
  reason?: string;
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
  /**
   * Queue entry filenames this issue implicates (the declaring/importing
   * patch, or every creator for a duplicate-creation clash). Used by the
   * export placement gate to attribute projected errors to the exported
   * patch vs pre-existing patches without parsing messages or the
   * rename-sensitive fingerprint (FORGE K9).
   */
  patches?: string[];
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
