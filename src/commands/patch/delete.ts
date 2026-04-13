// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge patch delete <name>` — removes a patch from the queue.
 *
 * Destructive: refuses when a later patch imports a module owned by the
 * target (that would leave a dangling forward import), prompts for
 * confirmation interactively, requires `--yes` for non-TTY, supports
 * `--dry-run`, and appends to `patches/.fireforge-history.jsonl` on success.
 */

import { basename } from 'node:path';

import { Command } from 'commander';

import { getProjectPaths } from '../../core/config.js';
import { appendHistory, confirmDestructive, type ConflictReport } from '../../core/destructive.js';
import {
  buildPatchQueueContext,
  extractImportSpecifiersWithLines,
  findForwardImportIgnoreLines,
  isForwardImportableFile,
} from '../../core/patch-lint.js';
import { withPatchDirectoryLock } from '../../core/patch-lock.js';
import { loadPatchesManifest, removePatchFileAndManifest } from '../../core/patch-manifest.js';
import { GeneralError, InvalidArgumentError } from '../../errors/base.js';
import type { CommandContext } from '../../types/cli.js';
import type { PatchDeleteOptions, PatchMetadata } from '../../types/commands/index.js';
import { toError } from '../../utils/errors.js';
import { pathExists } from '../../utils/fs.js';
import { info, intro, outro, warn } from '../../utils/logger.js';
import { pickDefined } from '../../utils/options.js';

/**
 * Resolves `<name>` (ordinal number or filename) to a manifest entry.
 * Mirrors re-export's `resolvePatchIdentifier` so the two resolvers behave
 * consistently — future work can lift this into a shared helper once a
 * third consumer appears.
 */
function resolvePatchIdentifier(
  identifier: string,
  patches: PatchMetadata[]
): PatchMetadata | null {
  if (/^\d+$/.test(identifier)) {
    const order = parseInt(identifier, 10);
    return patches.find((p) => p.order === order) ?? null;
  }
  const normalized = identifier.endsWith('.patch') ? identifier : `${identifier}.patch`;
  return patches.find((p) => p.filename === normalized) ?? null;
}

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

  const paths = getProjectPaths(projectRoot);
  if (!(await pathExists(paths.patches))) {
    throw new GeneralError('Patches directory not found. No patches to delete.');
  }

  const manifest = await loadPatchesManifest(paths.patches);
  if (!manifest || manifest.patches.length === 0) {
    throw new GeneralError('No patches in manifest.');
  }

  const target = resolvePatchIdentifier(identifier, manifest.patches);
  if (!target) {
    throw new InvalidArgumentError(
      `Patch "${identifier}" not found. Available: ${manifest.patches.map((p) => p.filename).join(', ')}`,
      identifier
    );
  }

  // Build the full queue context once so we can scan each patch's newFiles
  // without re-parsing for the dependency check below.
  const baseCtx = await buildPatchQueueContext(paths.patches);

  // Hard refusal: run the forward-import rule against the projected state.
  // Any issue that names the target patch in its message still applies; any
  // new forward-import that appears *only because the target is gone* means
  // another patch was depending on the target's newly-created files.
  // Simpler check: run the rule on the *original* context and look for
  // imports that resolve into the target's new files from earlier patches.
  // Even simpler: an import owned by a later patch pointing at any of the
  // target's newly-created files is a dependency on the target. We build
  // that check directly from baseCtx.
  const targetEntry = baseCtx.entries.find((e) => e.filename === target.filename);
  const targetNewFileLeaves = new Set<string>();
  if (targetEntry) {
    for (const fullPath of targetEntry.newFiles.keys()) {
      targetNewFileLeaves.add(basename(fullPath));
    }
  }

  // Scan every later patch's new files AND its added lines on pre-existing
  // files for import specifiers that resolve to a leaf owned by the target.
  // Uses the shared specifier extractor so dynamic import() and
  // ChromeUtils.defineESModuleGetters are picked up — the forward-import
  // lint rule already covers those forms and delete safety must match the
  // same set or it silently drops dependencies.
  //
  // We cover both source-site maps: `newFiles` (files the later patch
  // creates) and `modifiedFileAdditions` (added lines against files that
  // already exist). Scanning only newFiles was the second-degree miss
  // that motivated this change — a later patch could add
  // `import "./TargetHelper.sys.mjs"` to an existing file and the delete
  // guard would never see the dependency.
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

  const conflicts: ConflictReport | null =
    dependents.length > 0
      ? {
          reason: `${dependents.length} later patch(es) depend on files created by ${target.filename}`,
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

  if (decision === 'dry-run') {
    outro('Dry run complete — no changes made');
    return;
  }
  if (decision === 'cancelled') {
    outro('Delete cancelled');
    return;
  }

  // Proceed: remove under the patch directory lock so concurrent exports
  // cannot race us into the same manifest row. The history append lives
  // inside the same lock so two concurrent deletes cannot interleave
  // history records beyond what POSIX O_APPEND atomicity guarantees for a
  // single record, and so a crash between mutation and history write
  // cannot leave a committed mutation with no audit trail alongside a
  // concurrent mutation's record appearing first. A history append
  // failure is warned but not re-thrown: by that point the mutation
  // has committed and reporting failure to the caller would mislead.
  await withPatchDirectoryLock(paths.patches, async () => {
    await removePatchFileAndManifest(paths.patches, target.filename);
    try {
      await appendHistory(paths.patches, {
        operation: 'patch-delete',
        args: {
          filename: target.filename,
          order: target.order,
          filesAffected: target.filesAffected,
        },
        ...(options.yes === true ? { yes: true } : {}),
        ...(options.forceUnsafe === true ? { unsafeOverride: true } : {}),
        result: 'ok',
      });
    } catch (historyError: unknown) {
      warn(
        `History log append failed after patch delete committed (${target.filename}): ${toError(historyError).message}`
      );
    }
  });

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
  parent
    .command('delete <name>')
    .description('Delete a patch from the queue (destructive)')
    .option('--dry-run', 'Show what would happen without writing')
    .option('-y, --yes', 'Skip confirmation prompt (required for non-TTY)')
    .option(
      '--force-unsafe',
      'Bypass the refusal when a later patch depends on this patch (last resort)'
    )
    .action(
      withErrorHandling(
        async (
          name: string,
          options: { dryRun?: boolean; yes?: boolean; forceUnsafe?: boolean }
        ) => {
          await patchDeleteCommand(getProjectRoot(), name, pickDefined(options));
        }
      )
    );
}
