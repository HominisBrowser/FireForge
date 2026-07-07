// SPDX-License-Identifier: EUPL-1.2
/**
 * Detects drift between an override's stored `baseVersion` and the current
 * Firefox version recorded in `fireforge.json`.
 *
 * Overrides are forks of Firefox source files taken at a specific point in
 * time. If Firefox moves forward and the override's `baseVersion` is not
 * refreshed, the override may apply against a file whose upstream shape has
 * changed — which is the single biggest silent failure mode for furnace.
 *
 * This module is deliberately pure and string-only: it does no I/O and does
 * not parse Firefox version components. Comparing by string equality is
 * sufficient because `fireforge.json` stores a canonical version string
 * (e.g. `"140.9.0esr"`) and overrides are created with exactly that string
 * copied from `forgeConfig.firefox.version`. Any string mismatch is worth
 * surfacing — even "140.0" vs "140.9.0esr" is a real drift signal.
 *
 * The result GATES apply/deploy: both warn and then FAIL without --force
 * (see furnaceApplyCommand / furnaceDeployCommand), and `furnace sync`
 * re-checks it after refresh before applying. Status reports drift
 * alongside the component overview. Keep this doc in sync with the gates —
 * an earlier version claimed the result was advisory, which invited
 * re-breaking the gate.
 */

import type { FurnaceConfig } from '../types/furnace.js';

/** Severity of the version drift between an override's base and the current Firefox version. */
export type DriftSeverity = 'major' | 'minor' | 'patch';

export interface OverrideVersionDrift {
  name: string;
  /** The version the override was originally created against. */
  baseVersion: string;
  /** The Firefox version currently recorded in `fireforge.json`. */
  currentVersion: string;
  /** How severe the drift is, based on comparing version components. */
  severity: DriftSeverity;
}

/**
 * Parses a version string into its major, minor, and patch numeric
 * components. Non-numeric suffixes (e.g. "esr") are stripped. Returns
 * `[NaN, NaN, NaN]` for unparseable strings.
 */
function parseVersionComponents(version: string): [number, number, number] {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version);
  if (!match) return [NaN, NaN, NaN];
  return [
    Number(match[1]),
    match[2] !== undefined ? Number(match[2]) : 0,
    match[3] !== undefined ? Number(match[3]) : 0,
  ];
}

/**
 * Classifies how severe a version drift is by comparing the numeric
 * components of the two version strings. Falls back to `'major'` when
 * either version is unparseable — this ensures that unusual version
 * formats surface with the highest visibility rather than being silently
 * downgraded.
 */
export function classifyDriftSeverity(baseVersion: string, currentVersion: string): DriftSeverity {
  const [baseMajor, baseMinor] = parseVersionComponents(baseVersion);
  const [curMajor, curMinor] = parseVersionComponents(currentVersion);

  if (isNaN(baseMajor) || isNaN(curMajor)) return 'major';
  if (baseMajor !== curMajor) return 'major';
  if (baseMinor !== curMinor) return 'minor';
  return 'patch';
}

/**
 * Returns every override whose recorded `baseVersion` does not match the
 * current Firefox version. Returns an empty array when everything is in
 * sync, when there are no overrides, or when `currentVersion` is empty
 * (the caller should surface config problems via a different path).
 */
export function findOverrideBaseVersionDrift(
  config: FurnaceConfig,
  currentVersion: string
): OverrideVersionDrift[] {
  if (!currentVersion) return [];

  const drift: OverrideVersionDrift[] = [];
  for (const [name, override] of Object.entries(config.overrides)) {
    if (override.baseVersion && override.baseVersion !== currentVersion) {
      drift.push({
        name,
        baseVersion: override.baseVersion,
        currentVersion,
        severity: classifyDriftSeverity(override.baseVersion, currentVersion),
      });
    }
  }

  return drift;
}

/**
 * Formats a single drift entry into a one-line human-readable warning.
 * Kept alongside the detector so the same wording is reused by every
 * command that surfaces drift.
 */
export function formatOverrideBaseVersionDriftWarning(entry: OverrideVersionDrift): string {
  const severityLabel =
    entry.severity === 'major'
      ? ' (major version jump)'
      : entry.severity === 'minor'
        ? ' (minor version change)'
        : ' (patch-level change)';
  return `Override "${entry.name}" was created against Firefox ${entry.baseVersion}, but fireforge.json records ${entry.currentVersion}${severityLabel}. The upstream component may have changed — re-run "fireforge furnace validate ${entry.name}" and refresh the override if needed.`;
}

/** Formats a blocking preflight error for one or more stale overrides. */
export function formatOverrideBaseVersionDriftError(entries: OverrideVersionDrift[]): string {
  const names = entries.map((entry) => entry.name).sort();
  const summary =
    entries.length === 1
      ? `Override "${names[0]}" is stale against the Firefox version recorded in fireforge.json.`
      : `${entries.length} overrides are stale against the Firefox version recorded in fireforge.json (${names.join(', ')}).`;

  return (
    `${summary}\n\n` +
    'Run "fireforge furnace refresh <name>" to merge upstream changes, ' +
    'update baseVersion in furnace.json to acknowledge the new baseline, ' +
    'or pass --force to proceed despite the drift.'
  );
}
