// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge patch delete <name>`: removes a patch from the queue.
 *
 * Destructive: refuses when a later patch imports a module owned by the
 * target (that would leave a dangling forward import), prompts for
 * confirmation interactively, requires `--yes` for non-TTY, supports
 * `--dry-run`, and appends to `patches/.fireforge-history.jsonl` on success.
 */

import { basename } from 'node:path';

import { Command } from 'commander';

import { confirmDestructive, type ConflictReport } from '../../core/destructive.js';
import { appendHistoryBestEffort } from '../../core/history-log.js';
import {
  buildPatchQueueContext,
  extractImportSpecifiersWithLines,
  findForwardImportIgnoreLines,
  isForwardImportableFile,
} from '../../core/patch-lint.js';
import { withPatchDirectoryLock } from '../../core/patch-lock.js';
import { removePatchFileAndManifest } from '../../core/patch-manifest.js';
import type { CommandContext } from '../../types/cli.js';
import type { PatchDeleteOptions } from '../../types/commands/index.js';
import { info, intro, outro, warn } from '../../utils/logger.js';
import { addWaitLockOption, pickDefined, resolveWaitLockSeconds } from '../../utils/options.js';
import { proceedAfterDecision } from '../destructive-decision.js';
import { requirePatchQueue, requirePatchTarget } from './patch-context.js';

/**
 * Runs the `patch delete` command: removes a patch file and its manifest
 * row atomically, refusing when a later patch imports a leaf owned by the
 * target.
 *
 * @param projectRoot - Project root directory
 * @param identifier - Patch filename or ordinal number to delete
 * @param options - Command options
 */
export async function patchDeleteCommand(
  projectRoot: string,
  identifier: string,
  options: PatchDeleteOptions = {}
): Promise<void> {
  intro(options.dryRun ? 'FireForge patch delete (dry run)' : 'FireForge patch delete');

  const { paths, manifest } = await requirePatchQueue(projectRoot, {
    missingDirMessage: 'Patches directory not found. No patches to delete.',
  });
  const target = requirePatchTarget(identifier, manifest.patches);

  // Build the full queue context once so we can scan each patch's newFiles
  // without re-parsing for the dependency check below.
  const baseCtx = await buildPatchQueueContext(paths.patches);

  // Hard refusal: an import owned by a later patch that points at any of
  // the target's newly-created files is a dependency on the target. That
  // check is built directly from `baseCtx` rather than by diffing lint runs
  // over a projected state.
  const targetEntry = baseCtx.entries.find((e) => e.filename === target.filename);
  const targetNewFileLeaves = new Set<string>();
  if (targetEntry) {
    for (const fullPath of targetEntry.newFiles.keys()) {
      targetNewFileLeaves.add(basename(fullPath));
    }
  }

  // Scan every later patch's new files and its added lines on pre-existing
  // files for import specifiers that resolve to a leaf owned by the target.
  // Uses the shared specifier extractor so dynamic `import()` and
  // `ChromeUtils.defineESModuleGetters` are picked up: the forward-import
  // lint rule already covers those forms, and delete safety must match the
  // same set or it silently drops dependencies.
  //
  // Both source-site maps are covered: `newFiles` (files the later patch
  // creates) and `modifiedFileAdditions` (added lines against files that
  // already exist). Scanning only newFiles misses a later patch adding
  // `import "./TargetHelper.sys.mjs"` to an existing file.
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

  // Staged-dependency declarations on other patches may name the deleted
  // patch as their forward-import owner. The dangling reference also
  // surfaces via cross-patch lint later, but warning here puts the exact
  // cleanup command in front of the operator at decision time.
  const danglingOwnerHolders = baseCtx.entries.filter(
    (entry) =>
      entry.filename !== target.filename &&
      (entry.metadata?.stagedDependencies?.forwardImports ?? []).some(
        (fi) => fi.owner === target.filename
      )
  );
  for (const holder of danglingOwnerHolders) {
    warn(
      `${holder.filename} declares a staged dependency with owner ${target.filename}; ` +
        `after the delete, update it via "fireforge patch staged-dependency ${holder.filename} --remove ..." ` +
        'or re-point the owner at the patch that will create the file.'
    );
  }

  const conflicts: ConflictReport | null =
    dependents.length > 0
      ? {
          // The wording spells out the runtime impact: `git apply`
          // does not resolve imports and succeeds even when a later patch
          // imports a file the target created, so the queue re-imports
          // cleanly. The breakage surfaces at browser startup when
          // `ChromeUtils.importESModule` cannot locate the deleted module.
          // Operators who plan to re-introduce the imported files (rename,
          // refactor) need to know this is the impact model rather than a
          // patch-application failure.
          reason: `${dependents.length} later patch(es) contain import statements that reference files created by ${target.filename}. Patch application itself will still succeed, but runtime imports will fail at browser startup until those files are re-introduced.`,
          details: dependents,
        }
      : null;

  const summary: string[] = [
    `delete ${target.filename}  (category: ${target.category}, order: ${target.order})`,
    `description: ${target.description || '(none)'}`,
    `files currently claimed by this patch (${target.filesAffected.length}):`,
  ];
  for (const file of target.filesAffected) {
    summary.push(`  ${file}  → will become unmanaged`);
  }

  const decision = await confirmDestructive({
    operation: 'patch-delete',
    title: `Delete ${target.filename}`,
    summary,
    yes: options.yes === true,
    dryRun: options.dryRun === true,
    unsafeOverride: options.forceUnsafe === true,
    conflicts,
  });

  if (!proceedAfterDecision(decision, 'Delete cancelled')) return;

  // Proceed: remove under the patch directory lock so concurrent exports
  // cannot race us into the same manifest row. The history append lives
  // inside the same lock so two concurrent deletes cannot interleave history
  // records beyond what POSIX O_APPEND guarantees for a single record, and
  // so a crash between mutation and history write cannot leave a committed
  // mutation with no audit trail. A history append failure is warned but not
  // re-thrown: by that point the mutation has committed, and reporting
  // failure to the caller would mislead.
  await withPatchDirectoryLock(
    paths.patches,
    async () => {
      await removePatchFileAndManifest(paths.patches, target.filename);
      await appendHistoryBestEffort(
        paths.patches,
        {
          operation: 'patch-delete',
          args: {
            filename: target.filename,
            order: target.order,
            filesAffected: target.filesAffected,
          },
          ...(options.yes === true ? { yes: true } : {}),
          ...(options.forceUnsafe === true ? { unsafeOverride: true } : {}),
          result: 'ok',
        },
        `patch delete committed (${target.filename})`
      );
    },
    { waitLockSeconds: resolveWaitLockSeconds(options.waitLock), command: 'patch delete' }
  );

  info(`Deleted ${target.filename}.`);
  outro('Delete complete');
}

/**
 * Registers the `patch delete` subcommand on the `patch` parent.
 *
 * @param parent - Parent Commander command
 * @param context - Shared CLI registration context
 */
export function registerPatchDelete(parent: Command, context: CommandContext): void {
  const { getProjectRoot, withErrorHandling } = context;
  const command = parent
    .command('delete <name>')
    .description('Delete a patch from the queue (destructive)')
    .option('--dry-run', 'Show what would happen without writing')
    .option('-y, --yes', 'Skip confirmation prompt (required for non-TTY)')
    .option(
      '--force-unsafe',
      'Bypass the refusal when a later patch depends on this patch (last resort)'
    );
  addWaitLockOption(command).action(
    withErrorHandling(
      async (
        name: string,
        options: {
          dryRun?: boolean;
          yes?: boolean;
          forceUnsafe?: boolean;
          waitLock?: number | boolean;
        }
      ) => {
        await patchDeleteCommand(getProjectRoot(), name, pickDefined(options));
      }
    )
  );
}
