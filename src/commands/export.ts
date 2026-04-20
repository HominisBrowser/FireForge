// SPDX-License-Identifier: EUPL-1.2
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { Command, Option } from 'commander';

import { getProjectPaths, loadConfig } from '../core/config.js';
import { appendHistory, confirmDestructive } from '../core/destructive.js';
import { collectFurnaceManagedPrefixes } from '../core/furnace-config.js';
import { getStatusWithCodes, isGitRepository } from '../core/git.js';
import { generateBinaryFilePatch, generateFullFilePatch } from '../core/git-diff.js';
import { isBinaryFile } from '../core/git-file-ops.js';
import {
  getModifiedFilesInDir,
  getUntrackedFiles,
  getUntrackedFilesInDir,
} from '../core/git-status.js';
import { extractAffectedFiles } from '../core/patch-apply.js';
import { commitExportedPatch } from '../core/patch-export.js';
import { GeneralError, InvalidArgumentError } from '../errors/base.js';
import type { CommandContext } from '../types/cli.js';
import type { ExportOptions, PatchCategory, PatchMetadata } from '../types/commands/index.js';
import { toError } from '../utils/errors.js';
import { ensureDir, pathExists } from '../utils/fs.js';
import { info, intro, outro, spinner, verbose, warn } from '../utils/logger.js';
import { pickDefined } from '../utils/options.js';
import { stripEnginePrefix } from '../utils/paths.js';
import { parsePositiveIntegerFlag, PATCH_CATEGORIES } from '../utils/validation.js';
import {
  commitPlacementExport,
  type PlacementPlan,
  placementSummary,
  projectPlacementForLint,
  renderDryRunPreview,
  resolvePlacementPlan,
} from './export-flow.js';
import {
  autoFixLicenseHeaders,
  confirmSupersedePatches,
  promptExportPatchMetadata,
  runPatchLint,
} from './export-shared.js';

async function collectExportFiles(
  paths: ReturnType<typeof getProjectPaths>,
  files: string[]
): Promise<string[]> {
  const collectedFiles = new Set<string>();

  let fileStatuses: { status: string; file: string }[] | undefined;
  let untrackedFiles: string[] | undefined;

  // Accept both repo-root-relative (`engine/browser/...`) and engine-relative
  // (`browser/...`) paths for every input, matching `register`/`test`/`lint`.
  // Previously, an `engine/`-prefixed path fell through to
  // `File "engine/..." has no changes to export.` because the status lookup
  // sees paths relative to `paths.engine` and the explicit prefix double-
  // rooted the candidate. `stripEnginePrefix` makes that user-facing form
  // a no-op for the lookup pipeline.
  for (const rawInputPath of files) {
    const inputPath = stripEnginePrefix(rawInputPath);
    const fullInputPath = join(paths.engine, inputPath);
    let isDirectory = false;
    try {
      const fileStat = await stat(fullInputPath);
      isDirectory = fileStat.isDirectory();
    } catch (error: unknown) {
      verbose(
        `Treating ${inputPath} as a file because directory stat failed: ${toError(error).message}`
      );
    }

    if (isDirectory) {
      const dirPath = inputPath.endsWith('/') ? inputPath.slice(0, -1) : inputPath;
      const modifiedFiles = await getModifiedFilesInDir(paths.engine, dirPath);
      const dirUntrackedFiles = await getUntrackedFilesInDir(paths.engine, dirPath);
      for (const f of modifiedFiles) collectedFiles.add(f);
      for (const f of dirUntrackedFiles) collectedFiles.add(f);
    } else {
      if (inputPath.endsWith('/')) {
        throw new GeneralError(`"${inputPath}" is not a valid file or directory.`);
      }

      if (!fileStatuses) {
        fileStatuses = await getStatusWithCodes(paths.engine);
      }
      const fileStatus = fileStatuses.find((s) => s.file === inputPath);

      if (!fileStatus) {
        if (!untrackedFiles) {
          untrackedFiles = await getUntrackedFiles(paths.engine);
        }
        if (!untrackedFiles.includes(inputPath)) {
          throw new GeneralError(
            `File "${inputPath}" has no changes to export.\n\n` +
              'Run "fireforge status" to see modified files.'
          );
        }
      }

      collectedFiles.add(inputPath);
    }
  }

  return [...collectedFiles].sort();
}

async function generatePatchDiff(engineDir: string, allFiles: string[]): Promise<string> {
  const diffs: string[] = [];

  for (const file of allFiles) {
    const fullPath = join(engineDir, file);
    const isExistingBinary = (await pathExists(fullPath)) && (await isBinaryFile(engineDir, file));
    const diff = isExistingBinary
      ? await generateBinaryFilePatch(engineDir, file)
      : await generateFullFilePatch(engineDir, file);

    if (isExistingBinary) {
      if (diff.trim()) {
        info(`Including binary file: ${file}`);
      } else {
        warn(`Skipping binary file with no diff: ${file}`);
      }
    }

    if (diff.trim()) {
      diffs.push(diff);
    }
  }

  return diffs.join('\n');
}

/**
 * Runs the export command to export file changes as a patch.
 * Accepts one or more file/directory paths and bundles them into a single patch.
 * @param projectRoot - Root directory of the project
 * @param files - File or directory paths to export (relative to engine/)
 * @param options - Export options
 */
// The command body is intentionally linear: validation → diff → placement
// gate → dry-run/placement/default write. Splitting it further would
// spread the error-handling (spinner.error, try/catch) across multiple
// helpers and hurt readability more than it would help.
// eslint-disable-next-line max-lines-per-function
export async function exportCommand(
  projectRoot: string,
  files: string[],
  options: ExportOptions
): Promise<void> {
  const isDryRun = options.dryRun === true;
  intro(isDryRun ? 'FireForge Export (dry run)' : 'FireForge Export');

  // Placement flags are mutually exclusive with each other.
  const placementFlagCount = [
    options.order !== undefined,
    options.before !== undefined,
    options.after !== undefined,
  ].filter(Boolean).length;
  if (placementFlagCount > 1) {
    throw new InvalidArgumentError(
      '--order, --before, and --after are mutually exclusive.',
      'export placement'
    );
  }

  const paths = getProjectPaths(projectRoot);

  // Check if engine exists
  if (!(await pathExists(paths.engine))) {
    throw new GeneralError('Firefox source not found. Run "fireforge download" first.');
  }

  // Check if it's a git repository
  if (!(await isGitRepository(paths.engine))) {
    throw new GeneralError(
      'Engine directory is not a git repository. Run "fireforge download" to initialize.'
    );
  }

  let allFiles = await collectExportFiles(paths, files);

  // Filter out furnace-managed files when --exclude-furnace is set
  if (options.excludeFurnace) {
    const furnacePrefixes = await collectFurnaceManagedPrefixes(projectRoot);
    if (furnacePrefixes.size > 0) {
      const before = allFiles.length;
      allFiles = allFiles.filter(
        (file) => ![...furnacePrefixes].some((prefix) => file.startsWith(prefix))
      );
      const excluded = before - allFiles.length;
      if (excluded > 0) {
        info(`Excluded ${excluded} furnace-managed file${excluded === 1 ? '' : 's'} from export`);
      }
    }
  }

  if (allFiles.length === 0) {
    const pathList = files.join(', ');
    throw new GeneralError(
      `Paths "${pathList}" have no changes to export.\n\n` +
        'Run "fireforge status" to see modified files.'
    );
  }

  let diff = await generatePatchDiff(paths.engine, allFiles);

  if (!diff.trim()) {
    if (options.skipLint) {
      throw new GeneralError(
        'The specified paths have no diff content to export. ' +
          '(--skip-lint is set; lint checks were bypassed but there are still no content changes — ' +
          'the paths may have only been lint-level differences that resolved, or the working tree is already clean.)'
      );
    }
    throw new GeneralError('The specified paths have no diff content to export.');
  }

  // Ensure patches directory exists
  await ensureDir(paths.patches);

  const config = await loadConfig(projectRoot);
  const isInteractive = process.stdin.isTTY && process.stdout.isTTY;

  // Auto-fix missing license headers on new files (interactive only)
  const headersAdded = await autoFixLicenseHeaders(paths.engine, diff, config, isInteractive);
  if (headersAdded) {
    diff = await generatePatchDiff(paths.engine, allFiles);
  }

  const metadata = await promptExportPatchMetadata(options, isInteractive, 'export');
  if (!metadata) return;
  const { patchName, selectedCategory, description } = metadata;

  const s = spinner(isDryRun ? 'Planning export...' : 'Exporting patch...');

  try {
    // Extract affected files from diff
    const filesAffected = extractAffectedFiles(diff);

    await runPatchLint(paths.engine, filesAffected, diff, config, options.skipLint);

    // Resolve placement (if any flag was given). Placement is mutually
    // exclusive with supersede — the semantics overlap confusingly.
    let placementPlan: PlacementPlan | null = null;
    if (placementFlagCount > 0) {
      if (options.supersede) {
        throw new InvalidArgumentError(
          'Placement flags (--order/--before/--after) cannot be combined with --supersede.',
          'export placement'
        );
      }
      placementPlan = await resolvePlacementPlan(
        paths.patches,
        options,
        selectedCategory,
        patchName
      );

      const conflicts = await projectPlacementForLint(paths.patches, placementPlan, diff);
      const summary = placementSummary(placementPlan);
      const renameCount = placementPlan.renameMap.size;

      // Route through confirmDestructive when the operation is destructive
      // enough to warrant a prompt (more than one rename) OR when the user
      // asked for a dry-run. The dry-run branch must always print the
      // placement summary — previously, single-rename/no-rename dry-runs
      // exited silently with no filename or projected layout.
      if (renameCount > 1 || isDryRun) {
        s.stop();
        const decision = await confirmDestructive({
          operation: 'export-order',
          title: `Export with placement at order ${placementPlan.insertionOrder}`,
          summary,
          yes: options.yes === true,
          dryRun: isDryRun,
          unsafeOverride: options.forceUnsafe === true,
          conflicts,
        });
        if (decision === 'dry-run') {
          outro('Dry run complete — no changes made');
          return;
        }
        if (decision === 'cancelled') {
          outro('Export cancelled');
          return;
        }
      } else if (conflicts && options.forceUnsafe !== true) {
        s.stop();
        throw new InvalidArgumentError(
          `Refusing to run export: ${conflicts.reason}. Pass --force-unsafe to override.`,
          '--force-unsafe'
        );
      }
    }

    // Dry-run path: compute the plan and print it, never write.
    if (isDryRun && !placementPlan) {
      s.stop('Plan ready');
      await renderDryRunPreview({
        patchesDir: paths.patches,
        category: selectedCategory,
        name: patchName,
        description,
        filesAffected,
        sourceEsrVersion: config.firefox.version,
        explicitSupersede: options.supersede === true,
      });
      outro('Dry run complete — no changes made');
      return;
    }

    // Placement path (non-dry-run): run the renumber + write + manifest
    // update under a single patch directory lock so concurrent exports
    // cannot race into the renumber gap. Dry-runs with a placement plan
    // are fully handled in the placement gate above and never reach here.
    if (placementPlan) {
      const placementMetadata: PatchMetadata = {
        filename: placementPlan.newFilename,
        order: placementPlan.insertionOrder,
        category: selectedCategory,
        name: patchName,
        description,
        createdAt: new Date().toISOString(),
        sourceEsrVersion: config.firefox.version,
        filesAffected,
      };
      const committedPlan = await commitPlacementExport({
        patchesDir: paths.patches,
        options,
        category: selectedCategory,
        name: patchName,
        diff,
        metadata: placementMetadata,
        expectedPlan: placementPlan,
        unsafeOverride: options.forceUnsafe === true,
        // History append runs inside the same lock as the mutation so
        // concurrent placement exports cannot interleave their records
        // and a crash between mutation and record cannot orphan the
        // audit entry.
        onCommitted: async (finalPlan) => {
          await appendHistory(paths.patches, {
            operation: 'export-order',
            args: {
              filename: finalPlan.newFilename,
              order: finalPlan.insertionOrder,
              renames: Array.from(finalPlan.renameMap.entries()).map(([from, entry]) => ({
                from,
                to: entry.newFilename,
                order: entry.newOrder,
              })),
            },
            ...(options.yes === true ? { yes: true } : {}),
            ...(options.forceUnsafe === true ? { unsafeOverride: true } : {}),
            result: 'ok',
          });
        },
      });

      s.stop(`Exported to ${committedPlan.newFilename}`);
      info(`\nPatch saved to: patches/${committedPlan.newFilename}`);
      info(`Files affected: ${filesAffected.join(', ')}`);
      outro('Export complete');
      return;
    }

    // Default (no dry-run, no placement) path: the pre-existing behavior.
    // Check how many existing patches would be superseded
    const shouldProceed = await confirmSupersedePatches(
      paths.patches,
      filesAffected,
      options.supersede,
      isInteractive,
      s
    );
    if (!shouldProceed) return;

    const { patchFilename, superseded } = await commitExportedPatch({
      patchesDir: paths.patches,
      category: selectedCategory,
      name: patchName,
      description,
      diff,
      filesAffected,
      sourceEsrVersion: config.firefox.version,
    });

    for (const oldPatch of superseded) {
      info(`Superseded: ${oldPatch.filename}`);
    }

    s.stop(`Exported to ${patchFilename}`);

    info(`\nPatch saved to: patches/${patchFilename}`);
    if (filesAffected.length > 0) {
      info(`Files affected: ${filesAffected.join(', ')}`);
    }
    outro('Export complete');
  } catch (error: unknown) {
    s.error('Export failed');
    throw error;
  }
}

/** Registers the export command on the CLI program. */
export function registerExport(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  program
    .command('export <paths...>')
    .description('Export new changes as a patch (use re-export to update existing patches)')
    .option('-n, --name <name>', 'Name for the patch')
    .addOption(
      new Option('-c, --category <category>', 'Patch category').choices([...PATCH_CATEGORIES])
    )
    .option('-d, --description <desc>', 'Description of the patch')
    .option('--supersede', 'Allow superseding multiple existing patches')
    .option('--skip-lint', 'Skip patch lint checks (downgrade errors to warnings)')
    .option('--dry-run', 'Print the export plan (including supersede preview) without writing')
    .addOption(
      new Option(
        '--order <N>',
        'Place the new patch at this ordinal, shifting subsequent patches up'
      ).argParser((v) => parsePositiveIntegerFlag('--order', v))
    )
    .option('--before <anchor>', 'Place the new patch immediately before <anchor>')
    .option('--after <anchor>', 'Place the new patch immediately after <anchor>')
    .option('-y, --yes', 'Skip confirmation for placement renumbers (required for non-TTY)')
    .option('--force-unsafe', 'Bypass cross-patch lint refusal on projected placement')
    .option('--exclude-furnace', 'Exclude furnace-managed file paths from the export')
    .action(
      withErrorHandling(
        async (
          paths: string[],
          options: {
            name?: string;
            category?: string;
            description?: string;
            supersede?: boolean;
            skipLint?: boolean;
            dryRun?: boolean;
            order?: number;
            before?: string;
            after?: string;
            yes?: boolean;
            forceUnsafe?: boolean;
            excludeFurnace?: boolean;
          }
        ) => {
          const { category, ...rest } = options;
          await exportCommand(getProjectRoot(), paths, {
            ...pickDefined(rest),
            ...(category !== undefined ? { category: category as PatchCategory } : {}),
          });
        }
      )
    );
}
