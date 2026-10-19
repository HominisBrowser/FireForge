// SPDX-License-Identifier: EUPL-1.2
/**
 * Machine-readable per-patch lint report (`lint --per-patch --report
 * <path>`). One mechanism serves two observability gaps: consumers get each
 * patch's size metrics against the same thresholds the size rules fire on,
 * instead of mirroring `countNonBinaryDiffLines`, and lintIgnore-suppressed
 * issues stay visible with their measurements rather than vanishing.
 *
 * Helper module consumed by lint-per-patch.ts. No registrar is exported and
 * none is wanted.
 */
import {
  getPatchSizeThresholds,
  type PatchSizeThresholds,
  type PatchSizeTierDecision,
  resolvePatchSizeTier,
} from '../core/patch-lint.js';
import {
  evaluateLintIgnoreCeilings,
  evaluateLintIgnoreWaivers,
  type LintIgnoreCeilingStatus,
  type LintIgnoreWaiverStatus,
} from '../core/patch-lint-ignore.js';
import type { PatchLintIssue, PatchMetadata } from '../types/commands/index.js';
import type { FireForgeConfig, PatchLintPatchSizeMetric } from '../types/config.js';
import { writeJson } from '../utils/fs.js';
import { info } from '../utils/logger.js';

const LINT_REPORT_SCHEMA_VERSION = 1;

/**
 * Structural view of one per-patch lint outcome. Mirrors the relevant
 * fields of lint-per-patch's QueuedPatchResult without importing it:
 * that module imports this one, and a type back-edge would trip the
 * dpdm cycle gate.
 */
export interface PerPatchReportResult {
  status: 'skipped' | 'cached' | 'linted';
  existingFiles: string[];
  rawIssues: PatchLintIssue[];
  suppressedIssues: PatchLintIssue[];
  lineCount: number;
}

interface LintReportPatch {
  filename: string;
  name: string;
  status: 'skipped' | 'cached' | 'linted';
  /** What `lineCount` counts: `patchLint.patchSizeMetric`. */
  metric: PatchLintPatchSizeMetric;
  lineCount: number;
  filesAffected: number;
  tier: PatchSizeTierDecision;
  thresholds: PatchSizeThresholds;
  issues: PatchLintIssue[];
  suppressedIssues: PatchLintIssue[];
  /**
   * Each `{ rule, max, reason }` lintIgnore ceiling with the current
   * measurement and whether it holds, was exceeded, or is removable.
   * Empty when the patch carries no ceiling or was skipped.
   */
  lintIgnoreCeilings: LintIgnoreCeilingStatus[];
  /**
   * Every lintIgnore entry, bare IDs (`max: null`) and ceilings alike, with
   * its current measurement and state. Empty when the patch carries none or
   * was skipped. `lintIgnoreCeilings` keeps its ceiling-only shape.
   */
  lintIgnoreWaivers: LintIgnoreWaiverStatus[];
}

/**
 * Writes the per-patch lint report JSON. Called after the per-patch
 * results are assembled in patch order. Policy findings are
 * patch-attributed by their `filename` field upstream and are not
 * duplicated here. Cross-patch findings (`forward-import`,
 * `forward-registration`, …) go in `queueIssues`, with the
 * `stagedDeclarations` that discharge them, so the report can be handed to
 * `patch staged-dependency --from` as is.
 */
export async function writePerPatchLintReport(
  reportPath: string,
  subset: readonly PatchMetadata[],
  results: readonly PerPatchReportResult[],
  config: Pick<FireForgeConfig, 'patchLint'>,
  queueIssues: readonly PatchLintIssue[] = []
): Promise<void> {
  const metric = config.patchLint?.patchSizeMetric ?? 'diff';
  const patches: LintReportPatch[] = [];
  let errors = 0;
  let warnings = 0;
  let suppressed = 0;
  let linted = 0;
  let skipped = 0;

  for (let i = 0; i < subset.length; i++) {
    const patch = subset[i];
    const result = results[i];
    if (!patch || !result) continue;
    const tier = resolvePatchSizeTier(result.existingFiles, patch.tier);
    const findings = [...result.rawIssues, ...result.suppressedIssues];
    const measurements = { lines: result.lineCount, files: patch.filesAffected.length };
    patches.push({
      filename: patch.filename,
      name: patch.name,
      status: result.status,
      metric,
      lineCount: result.lineCount,
      filesAffected: patch.filesAffected.length,
      tier,
      thresholds: getPatchSizeThresholds(tier.tier, config),
      issues: result.rawIssues,
      suppressedIssues: result.suppressedIssues,
      lintIgnoreCeilings:
        result.status === 'skipped'
          ? []
          : evaluateLintIgnoreCeilings(patch.lintIgnore, findings, measurements),
      lintIgnoreWaivers:
        result.status === 'skipped'
          ? []
          : evaluateLintIgnoreWaivers(patch.lintIgnore, findings, measurements),
    });
    if (result.status === 'skipped') skipped++;
    else linted++;
    errors += result.rawIssues.filter((issue) => issue.severity === 'error').length;
    warnings += result.rawIssues.filter((issue) => issue.severity === 'warning').length;
    suppressed += result.suppressedIssues.length;
  }

  await writeJson(reportPath, {
    schemaVersion: LINT_REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    patches,
    queueIssues,
    totals: { linted, skipped, errors, warnings, suppressed },
  });
  info(`Per-patch lint report written to ${reportPath}.`);
}
