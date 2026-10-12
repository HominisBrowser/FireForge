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
   * Pre-existing bytes of files the auto-resolve overwrote (or, for a
   * binary new file, removed), keyed by engine-relative path. Kept for the
   * whole run's duration, not just the retry: if a later patch fails and
   * `rollbackPatches` reverse-applies this one, reversing a new-file patch
   * deletes the file, and these snapshots are the only way to restore what
   * was there before the auto-resolve.
   *
   * Raw bytes rather than decoded text, because the same snapshot has to
   * restore a binary target byte-for-byte.
   *
   * Typed `Uint8Array` rather than `Buffer`: this interface is published,
   * and the emitted `.d.ts` naming a Node global made a consumer without
   * `@types/node` fail to compile against the package (`TS2591` in the
   * pack smoke test). Every `Buffer` assigns to it, since `Buffer` extends
   * `Uint8Array`, and `fs.writeFile` accepts it, so nothing at the call
   * sites changes.
   */
  autoResolvedOriginals?: Map<string, Uint8Array>;
}

/**
 * A size waiver with a ceiling, one form of a `PatchMetadata.lintIgnore`
 * entry. The named size rule stays suppressed while its measurement is at
 * or below `max` and fires again past it, so a waived file cannot grow
 * without bound. Only the measured size rules (`file-too-large`,
 * `large-patch-lines`, `large-patch-files`) accept a ceiling.
 */
export interface LintIgnoreCeiling {
  /** Size rule check ID the waiver applies to. */
  rule: string;
  /** Largest measurement (lines or files) the waiver still suppresses. */
  max: number;
  /** Why the waiver exists. Required so the ceiling is reviewable. */
  reason: string;
}

/** One `PatchMetadata.lintIgnore` entry: a bare check ID or a ceiling waiver. */
export type LintIgnoreEntry = string | LintIgnoreCeiling;

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
   * Optional per-patch list of lint check IDs to suppress when this patch is
   * the target of `export`, `export-all`, or `re-export`. Exists for the
   * class of patch that is advisory-noisy by nature (a cohesive branding
   * bundle, a localised-resource pack, an auto-generated manifest) where
   * the generic `large-patch-lines` / `large-patch-files` thresholds do not
   * apply but `--skip-lint`, which silences every error rather than the one
   * that does not apply, is too coarse.
   *
   * Values are free-form check IDs (e.g. `"large-patch-lines"`). Checks not
   * listed here still run normally. An entry for an unknown check ID is a
   * no-op: the metadata documents the intent to suppress even if the check
   * is later renamed or removed.
   *
   * An entry may instead be a {@link LintIgnoreCeiling}, which waives a size
   * rule only up to a measured maximum.
   */
  lintIgnore?: LintIgnoreEntry[];
  /**
   * Optional per-patch threshold-tier override for the `large-patch-lines`
   * rule. Exists for branding patches that must touch a small number of
   * cross-cutting registration files alongside `browser/branding/<name>/`
   * (notably `browser/moz.configure`, which registers the new branding
   * flavor with the top-level configure). The narrow auto-detect allowlist
   * in `isBrandingOnlyPatch` covers the canonical shape. A fork whose
   * branding patch also touches an unlisted sibling falls through to the
   * general tier and trips the hard limit on what is legitimately one
   * branding diff.
   *
   * Declaring `tier: "branding"` forces the branding thresholds (notice
   * 8000 / warning 18000 / error 30000 lines, ≤60 files) regardless of
   * `filesAffected`. It is a weaker claim than test: an all-tests patch
   * stays in the test tier even with this set, because those thresholds are
   * already more permissive.
   *
   * Only `"branding"` is recognised. Unknown values are rejected by the
   * manifest validator, not silently stripped.
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
   * lines (a jar.mn entry, a customElements registration, an actor
   * registration) this patch adds that reference a file a later patch
   * creates. Unlike `forwardImports`, these are validated by matching the
   * declared line against the patch's added content rather than by finding
   * an import specifier, since packaging lines have no import to match.
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
 * A staged-dependency declaration a lint finding proposes: the arguments of
 * one `patch staged-dependency <patch> --add` call.
 */
export interface PatchLintStagedDeclaration {
  /** Patch that must carry the declaration. */
  patch: string;
  /** Declaration kind (`--kind`). */
  kind: 'import' | 'registration';
  /** Declaring file path relative to engine/. */
  file: string;
  /** Import specifier (`kind: import`). */
  specifier?: string;
  /** Registration line as the patch adds it (`kind: registration`). */
  line?: string;
  /** Later-created file path relative to engine/. */
  creates: string;
  /** Later patch that creates it. */
  owner: string;
}

/**
 * Schema for patches/patches.json file.
 */
export interface PatchesManifest {
  /** Schema version for future compatibility */
  version: 1;
  /** Array of patch metadata entries */
  patches: PatchMetadata[];
  /**
   * Order numbers a `patch retire` emptied on purpose. A retired slot has no
   * `.patch` file and no row in `patches`, so apply, export, lint and rebase
   * never see it; only the `patchPolicy.allowGaps: false` gap check reads it,
   * as an occupied order. A patch that later takes the same order fills the
   * slot, and the slot is dropped on that write.
   */
  retired?: PatchRetiredSlot[];
}

/** One placeholder left by `patch retire`. */
export interface PatchRetiredSlot {
  /** The order number the retired patch held. */
  order: number;
  /** Category of the retired patch, kept so the slot stays in its range. */
  category: PatchCategory;
  /** Filename of the retired patch, for the audit trail only. */
  filename: string;
  /** ISO timestamp of the retirement. */
  retiredAt: string;
  /** Optional human-readable rationale. */
  reason?: string;
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
   * rename-sensitive fingerprint.
   */
  patches?: string[];
  /**
   * For a `forward-import` or `forward-registration` finding: the staged
   * declarations that would discharge it, one per later creator. The same
   * records the printed `patch staged-dependency --add` commands carry, in
   * the shape `patch staged-dependency --from` reads back.
   */
  stagedDeclarations?: PatchLintStagedDeclaration[];
  /** Severity: errors block export, warnings are advisory, notices are informational (not counted) */
  severity: 'error' | 'warning' | 'notice';
  /**
   * Diff-scoping tag populated by `lint --since <rev>`. Absent when the
   * caller did not request diff-scoping.
   *
   * - `introduced`: the issue's file was touched in the diff since `<rev>`.
   * - `cumulative`: the issue is pre-existing patch-state drift not
   *   introduced by the current task.
   */
  tag?: 'introduced' | 'cumulative';
  /**
   * The value a size rule measured (lines for `file-too-large` and
   * `large-patch-lines`, files for `large-patch-files`). A lintIgnore
   * ceiling compares against it, and `lint --report` carries it.
   */
  measurement?: number;
}
