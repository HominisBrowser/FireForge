// SPDX-License-Identifier: EUPL-1.2
/**
 * Machine-readable per-patch lint report (`lint --per-patch --report
 * <path>`). One mechanism serves two observability gaps: consumers get each
 * patch's size metrics against the SAME thresholds the size rules fire on,
 * instead of mirroring `countNonBinaryDiffLines`, and lintIgnore-suppressed
 * issues stay visible with their measurements rather than vanishing.
 *
 * Helper module consumed by lint-per-patch.ts; no registrar is exported and
 * none is wanted.
 */
import {
  getPatchSizeThresholds,
  type PatchSizeThresholds,
  type PatchSizeTierDecision,
  resolvePatchSizeTier,
} from '../core/patch-lint.js';
import type { PatchLintIssue, PatchMetadata } from '../types/commands/index.js';
import { writeJson } from '../utils/fs.js';
import { info } from '../utils/logger.js';

const LINT_REPORT_SCHEMA_VERSION = 1;

/**
 * Structural view of one per-patch lint outcome. Mirrors the relevant
 * fields of lint-per-patch's QueuedPatchResult without importing it —
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
  lineCount: number;
  filesAffected: number;
  tier: PatchSizeTierDecision;
  thresholds: PatchSizeThresholds;
  issues: PatchLintIssue[];
  suppressedIssues: PatchLintIssue[];
}

/**
 * Writes the per-patch lint report JSON. Called after the per-patch
 * results are assembled in patch order; queue-level and policy findings
 * are patch-attributed by their `file`/`filename` fields upstream and
 * are NOT duplicated here — the report is the per-patch view.
 */
export async function writePerPatchLintReport(
  reportPath: string,
  subset: readonly PatchMetadata[],
  results: readonly PerPatchReportResult[]
): Promise<void> {
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
    patches.push({
      filename: patch.filename,
      name: patch.name,
      status: result.status,
      lineCount: result.lineCount,
      filesAffected: patch.filesAffected.length,
      tier,
      thresholds: getPatchSizeThresholds(tier.tier),
      issues: result.rawIssues,
      suppressedIssues: result.suppressedIssues,
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
    totals: { linted, skipped, errors, warnings, suppressed },
  });
  info(`Per-patch lint report written to ${reportPath}.`);
}
