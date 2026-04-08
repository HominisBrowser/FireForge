// SPDX-License-Identifier: EUPL-1.2
/**
 * Project diagnostics, status, and token coverage types.
 */

/**
 * Result of a doctor check.
 */
export interface DoctorCheck {
  /** Name of the check */
  name: string;
  /** Whether the check passed */
  passed: boolean;
  /** Severity of the result */
  severity?: 'ok' | 'warning' | 'error';
  /** Description of the result */
  message: string;
  /** Suggested fix if check failed */
  fix?: string;
  /** Whether this check passed with a warning */
  warning?: boolean;
}

/**
 * Status of the project.
 */
export interface ProjectStatus {
  /** Whether fireforge.json exists */
  hasConfig: boolean;
  /** Whether engine/ exists */
  hasEngine: boolean;
  /** Whether patches/ exists */
  hasPatches: boolean;
  /** Number of patch files */
  patchCount: number;
  /** Whether build output exists */
  hasBuild: boolean;
  /** Firefox version from config */
  firefoxVersion?: string;
  /** Downloaded Firefox version */
  downloadedVersion?: string;
}

/**
 * Per-file token coverage breakdown.
 */
export interface TokenCoverageFileEntry {
  /** File path (relative to engine root) */
  file: string;
  /** var(--{prefix}*) usages — fully tokenized */
  tokenUsages: number;
  /** var(--*) usages referencing allowlisted tokens */
  allowlisted: number;
  /** var(--*) usages not in token namespace and not allowlisted */
  unknownVars: number;
  /** Raw color values (hex, rgb, hsl) found outside comments */
  rawColors: number;
}

/**
 * Aggregate token coverage report.
 */
export interface TokenCoverageReport {
  /** Total CSS files scanned */
  filesScanned: number;
  /** var(--{prefix}*) usages — fully tokenized */
  tokenUsages: number;
  /** var(--*) usages referencing allowlisted tokens */
  allowlistedUsages: number;
  /** var(--*) usages not in token namespace and not allowlisted */
  unknownVarUsages: number;
  /** Raw color values (hex, rgb, hsl) found outside comments */
  rawColorCount: number;
  /** Per-file breakdown */
  files: TokenCoverageFileEntry[];
}
