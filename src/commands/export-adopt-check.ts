// SPDX-License-Identifier: EUPL-1.2
/**
 * The advice an export placement refusal appends for new files: "register
 * first" when a new system module only lacks its moz.build line, and
 * adopt-then-split for a real moved-code block, but only after checking
 * that the adopt itself would pass.
 *
 * The advice used to be offered on the moved-code heuristic alone. On one
 * queue it told the operator to adopt six new modules into an existing
 * patch when the only error was the missing registration; the adopt then
 * refused one module for importing later patches, and without it breached
 * the source patch's hard size limit. Split out of export-flow.ts for the
 * line budget.
 */

import { detectMovedCodeOverlaps, formatMovedCodeAdvice } from '../core/export-moved-code-shape.js';
import {
  countNonBinaryDiffLines,
  getPatchSizeThresholds,
  lintPatchQueue,
  type PatchQueueContext,
  type PatchQueueEntry,
  resolvePatchSizeTier,
} from '../core/patch-lint.js';
import { computeProjectedLintRegressions } from '../core/patch-lint-projection.js';
import type { PatchLintIssue } from '../types/commands/index.js';
import { projectEntryBody } from './patch/entry-projection.js';

/**
 * Why adopting `diff` into `sourceFilename` would itself be refused: the
 * forward imports the adopted files would give the source patch, and the
 * source patch's hard size limit. Empty when the adopt is clean.
 *
 * @param baseCtx - The current queue
 * @param sourceFilename - The patch the adopt would grow
 * @param diff - The pending export's diff
 */
export function findAdoptBlockers(
  baseCtx: PatchQueueContext,
  sourceFilename: string,
  diff: string
): string[] {
  const source = baseCtx.entries.find((entry) => entry.filename === sourceFilename);
  if (source === undefined) return [];
  const blockers: string[] = [];

  const pending = projectEntryBody(diff);
  const adopted: PatchQueueEntry = {
    ...source,
    diff: `${source.diff}\n${diff}`,
    newFiles: new Map([...source.newFiles, ...pending.newFiles]),
    createdFiles: new Set([...source.createdFiles, ...pending.createdFiles]),
    modifiedFileAdditions: new Map([
      ...source.modifiedFileAdditions,
      ...pending.modifiedFileAdditions,
    ]),
  };
  const isError = (issue: PatchLintIssue): boolean => issue.severity === 'error';
  const baseline = lintPatchQueue(baseCtx).filter(isError);
  const projected = lintPatchQueue({
    ...baseCtx,
    entries: baseCtx.entries.map((entry) => (entry.filename === sourceFilename ? adopted : entry)),
  }).filter(isError);
  for (const issue of computeProjectedLintRegressions(baseline, projected)) {
    if (issue.check !== 'forward-import' || !issue.patches?.includes(sourceFilename)) continue;
    for (const declaration of issue.stagedDeclarations ?? []) {
      blockers.push(
        `${declaration.file} imports "${declaration.specifier ?? ''}", created by ` +
          `${declaration.owner}, which applies after ${sourceFilename} (forward-import)`
      );
    }
  }

  if (!(source.metadata?.lintIgnore ?? []).includes('large-patch-lines')) {
    const tier = resolvePatchSizeTier(
      [...(source.metadata?.filesAffected ?? []), ...pending.newFiles.keys()],
      source.metadata?.tier
    );
    const limit = getPatchSizeThresholds(tier.tier).lines.error;
    const lines =
      countNonBinaryDiffLines(source.diff).textLines + countNonBinaryDiffLines(diff).textLines;
    if (lines > limit) {
      blockers.push(
        `${sourceFilename} would grow to about ${lines} lines, over its ${tier.tier} hard limit ` +
          `of ${limit} (large-patch-lines)`
      );
    }
  }
  return blockers;
}

/**
 * Detail lines for a placement refusal: register-first and moved-code
 * advice, each only when the projection supports it.
 *
 * @param baseCtx - The current queue
 * @param diff - The pending export's diff
 * @param projectedIssues - Error findings of the placement projection
 * @param plan - The placement's new filename and order
 */
export function describePlacementAdvice(
  baseCtx: PatchQueueContext,
  diff: string,
  projectedIssues: readonly PatchLintIssue[],
  plan: { newFilename: string; insertionOrder: number }
): string[] {
  const newFiles = projectEntryBody(diff).newFiles;
  const exported = projectedIssues.filter(
    (issue) => issue.patches?.includes(plan.newFilename) ?? issue.message.includes(plan.newFilename)
  );
  const unregisteredModules = [
    ...new Set(
      exported
        .filter((issue) => issue.check === 'unregistered-system-module' && newFiles.has(issue.file))
        .map((issue) => issue.file)
    ),
  ];
  const registrationResolvesAll =
    unregisteredModules.length > 0 &&
    exported.every((issue) => issue.check === 'unregistered-system-module');

  const overlaps = registrationResolvesAll ? [] : detectMovedCodeOverlaps(diff, baseCtx.entries);
  const strongest = overlaps[0];
  return formatMovedCodeAdvice({
    overlaps,
    newPatchName: plan.newFilename,
    insertionOrder: plan.insertionOrder,
    unregisteredModules,
    registrationResolvesAll,
    adoptBlockers:
      strongest !== undefined ? findAdoptBlockers(baseCtx, strongest.sourcePatch, diff) : [],
  });
}
