// SPDX-License-Identifier: EUPL-1.2
/**
 * Attribution of projected placement lint errors, split out of
 * export-flow.ts for the line budget.
 *
 * A placement projection lints one merged queue (the renumbered existing
 * patches plus a synthetic entry for the pending patch), so a flat error
 * list reads as though the new patch caused every one of them. A renumbering
 * that re-evaluates pre-existing staged relationships (patch 455 importing a
 * module created by 456, legal only at their current ordinals) then sends
 * the operator auditing a perfectly fine export.
 *
 * Consumed by export-flow.ts. No top-level registrar is exported and none is
 * wanted.
 */
import { formatPatchLintIssue } from '../core/patch-lint.js';
import type { PatchRenameEntry } from '../core/patch-manifest.js';
import type { PatchLintIssue } from '../types/commands/index.js';

/** Inputs {@link groupProjectedPlacementErrors} needs from the plan. */
export interface PlacementAttributionPlan {
  insertionOrder: number;
  newFilename: string;
  renameMap: Map<string, PatchRenameEntry>;
}

/**
 * Identity for baseline comparison: check + site file + implicated
 * patches, with projected filenames mapped back through the rename map so
 * a pre-existing error keeps its identity across the renumber. Never
 * parses the fingerprint. It is documented rename-sensitive.
 */
function issueKey(issue: PatchLintIssue, mapBackToOldName: (name: string) => string): string {
  const patches = (issue.patches ?? []).map(mapBackToOldName).sort((a, b) => a.localeCompare(b));
  return `${issue.check}|${issue.file}|${patches.join(',')}`;
}

/**
 * Partitions the projected placement errors into three labeled groups
 * (defects in the exported content, consequences of the renumbering, and
 * errors the queue already had), rendered as indented detail lines for
 * {@link ConflictReport.details}. Grouping travels through the plain
 * `details: string[]`, so both refusal sites and confirmDestructive's
 * conflict printer show it without changes.
 */
export function groupProjectedPlacementErrors(
  projectedErrors: readonly PatchLintIssue[],
  baselineErrors: readonly PatchLintIssue[],
  plan: PlacementAttributionPlan
): string[] {
  const oldNameByNew = new Map<string, string>();
  for (const [oldFilename, rename] of plan.renameMap) {
    oldNameByNew.set(rename.newFilename, oldFilename);
  }
  const mapBack = (name: string): string => oldNameByNew.get(name) ?? name;
  const baselineKeys = new Set(baselineErrors.map((issue) => issueKey(issue, (name) => name)));

  const exported: PatchLintIssue[] = [];
  const renumbering: PatchLintIssue[] = [];
  const preExisting: PatchLintIssue[] = [];
  for (const issue of projectedErrors) {
    // The synthetic entry's filename is unique in the projection, so
    // membership in `patches` attributes exactly. Issues from older rules
    // without the field fall back to a message scan, then to "the queue".
    const implicatesNewPatch =
      issue.patches?.includes(plan.newFilename) ?? issue.message.includes(plan.newFilename);
    if (implicatesNewPatch) {
      exported.push(issue);
    } else if (baselineKeys.has(issueKey(issue, mapBack))) {
      preExisting.push(issue);
    } else {
      renumbering.push(issue);
    }
  }

  const details: string[] = [];
  const pushGroup = (header: string, issues: readonly PatchLintIssue[]): void => {
    if (issues.length === 0) return;
    details.push(header);
    for (const issue of issues) {
      details.push(`  ${formatPatchLintIssue(issue)}`);
    }
  };
  pushGroup(`errors in the exported patch content (${exported.length}):`, exported);
  pushGroup(
    `consequences of renumbering existing patches to make room at ordinal ` +
      `${plan.insertionOrder} (${renumbering.length}) — these come from ` +
      'renumbering, NOT from the exported content:',
    renumbering
  );
  pushGroup(
    `errors already present in the queue before this export (${preExisting.length}):`,
    preExisting
  );
  return details;
}
