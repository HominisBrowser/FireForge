// SPDX-License-Identifier: EUPL-1.2
/**
 * The dependency scan `patch delete` and `patch retire` share: which later
 * patches import a file the removed patch creates, and which staged
 * declarations name it as their owner. Both commands take the patch out of
 * the queue, so both must refuse and warn on exactly the same evidence.
 */

import { basename } from 'node:path';

import type { ConflictReport } from '../../core/destructive.js';
import {
  extractImportSpecifiersWithLines,
  findForwardImportIgnoreLines,
  isForwardImportableFile,
  type PatchQueueContext,
} from '../../core/patch-lint.js';
import { GeneralError } from '../../errors/base.js';
import type { PatchMetadata } from '../../types/commands/index.js';
import { warn } from '../../utils/logger.js';

/**
 * Lists every later patch site that imports a file `target` creates.
 *
 * Both source-site maps are covered: `newFiles` (files the later patch
 * creates) and `modifiedFileAdditions` (added lines against files that
 * already exist). Scanning only newFiles misses a later patch adding
 * `import "./TargetHelper.sys.mjs"` to an existing file. Uses the shared
 * specifier extractor so dynamic `import()` and
 * `ChromeUtils.defineESModuleGetters` are picked up: the forward-import lint
 * rule already covers those forms, and removal safety must match the same
 * set or it silently drops dependencies.
 *
 * @param baseCtx - Queue context built before the removal
 * @param target - The patch about to leave the queue
 * @param command - Names for the "queue changed" refusal, e.g.
 *   `{ noun: 'deletion', verb: 'delete' }`
 * @returns One description per dependent patch
 */
export function collectRemovalDependents(
  baseCtx: PatchQueueContext,
  target: PatchMetadata,
  command: { noun: string; verb: string }
): string[] {
  const targetEntry = baseCtx.entries.find((e) => e.filename === target.filename);
  if (!targetEntry || JSON.stringify(targetEntry.metadata) !== JSON.stringify(target)) {
    throw new GeneralError(
      `Patch queue changed while preparing ${command.noun}. Re-run patch ${command.verb} to review the current target.`
    );
  }
  const targetNewFileLeaves = new Set<string>();
  for (const fullPath of targetEntry.newFiles.keys()) {
    targetNewFileLeaves.add(basename(fullPath));
  }

  const dependents: string[] = [];
  const scanSite = (entryFilename: string, sitePath: string, content: string): boolean => {
    if (!isForwardImportableFile(sitePath)) return false;

    const ignoredLines = findForwardImportIgnoreLines(content);
    const specifiers = extractImportSpecifiersWithLines(content);
    for (const { specifier, line } of specifiers) {
      if (ignoredLines.has(line)) continue;
      const cleaned = specifier.split(/[?#]/)[0] ?? specifier;
      const leaf = basename(cleaned);
      if (!leaf || !isForwardImportableFile(leaf)) continue;
      if (targetNewFileLeaves.has(leaf)) {
        dependents.push(
          `${entryFilename} (${sitePath}) imports "${specifier}" which would be deleted`
        );
        return true;
      }
    }
    return false;
  };
  for (const entry of baseCtx.entries) {
    if (entry.filename === target.filename) continue;
    if (entry.order < target.order) continue;
    let matched = false;
    for (const [newFile, content] of entry.newFiles) {
      if (scanSite(entry.filename, newFile, content)) {
        matched = true;
        break;
      }
    }
    if (matched) continue;
    for (const [modifiedPath, addedContent] of entry.modifiedFileAdditions) {
      if (scanSite(entry.filename, modifiedPath, addedContent)) break;
    }
  }
  return dependents;
}

/**
 * Warns once per patch whose staged forward-import names `target` as its
 * owner. The dangling reference also surfaces via cross-patch lint later,
 * but warning here puts the exact cleanup command in front of the operator
 * at decision time.
 *
 * @param baseCtx - Queue context built before the removal
 * @param target - The patch about to leave the queue
 * @param verb - Command name used in the warning ("delete", "retire")
 */
export function warnDanglingStagedOwners(
  baseCtx: PatchQueueContext,
  target: PatchMetadata,
  verb: string
): void {
  const holders = baseCtx.entries.filter(
    (entry) =>
      entry.filename !== target.filename &&
      (entry.metadata?.stagedDependencies?.forwardImports ?? []).some(
        (fi) => fi.owner === target.filename
      )
  );
  for (const holder of holders) {
    warn(
      `${holder.filename} declares a staged dependency with owner ${target.filename}; ` +
        `after the ${verb}, update it via "fireforge patch staged-dependency ${holder.filename} --remove ..." ` +
        'or re-point the owner at the patch that will create the file.'
    );
  }
}

/**
 * The structural conflict a removal with dependents raises.
 *
 * The wording spells out the runtime impact: `git apply` does not resolve
 * imports and succeeds even when a later patch imports a file the target
 * created, so the queue re-imports cleanly. The breakage surfaces at
 * browser startup when `ChromeUtils.importESModule` cannot locate the
 * deleted module. Operators who plan to re-introduce the imported files
 * (rename, refactor) need to know this is the impact model rather than a
 * patch-application failure.
 *
 * @param dependents - Result of {@link collectRemovalDependents}
 * @param target - The patch about to leave the queue
 */
export function removalConflict(
  dependents: readonly string[],
  target: PatchMetadata
): ConflictReport | null {
  if (dependents.length === 0) return null;
  return {
    reason: `${dependents.length} later patch(es) contain import statements that reference files created by ${target.filename}. Patch application itself will still succeed, but runtime imports will fail at browser startup until those files are re-introduced.`,
    details: [...dependents],
  };
}

/**
 * Snapshot of the queue inputs a removal's dependency scan read, compared
 * again under the lock so a change between the prompt and the commit
 * refuses instead of committing an unreviewed removal.
 */
export function queueSnapshot(context: PatchQueueContext): string {
  return JSON.stringify(
    context.entries.map(({ filename, order, diff, metadata }) => ({
      filename,
      order,
      diff,
      metadata,
    }))
  );
}
