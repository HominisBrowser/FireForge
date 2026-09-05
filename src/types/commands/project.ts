// SPDX-License-Identifier: EUPL-1.2
/**
 * Project diagnostics, status, and token coverage types.
 */

/**
 * Result of a doctor check.
 *
 * `severity` is the single source of truth. Consumers that want a boolean
 * derive it as `severity !== 'error'`.
 */
export interface DoctorCheck {
  /** Name of the check */
  name: string;
  /** Outcome of the check. Authoritative and required. */
  severity: 'ok' | 'warning' | 'error';
  /** Description of the result */
  message: string;
  /** Suggested fix when the check did not pass */
  fix?: string;
}

/**
 * Per-file token coverage breakdown.
 */
export interface TokenCoverageFileEntry {
  /** File path (relative to engine root) */
  file: string;
  /** var(--{prefix}*) usages, fully tokenized */
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
  /** var(--{prefix}*) usages, fully tokenized */
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
