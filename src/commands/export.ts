// SPDX-License-Identifier: EUPL-1.2
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { Command, Option } from 'commander';

import { getProjectPaths, loadConfig } from '../core/config.js';
import { appendHistory } from '../core/destructive.js';
import { withEngineSessionLock } from '../core/engine-session-lock.js';
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
import { buildPatchQueueContext } from '../core/patch-lint.js';
import { loadPatchesManifest } from '../core/patch-manifest.js';
import { buildPatchSourceMetadata } from '../core/patch-source-metadata.js';
import { GeneralError, InvalidArgumentError } from '../errors/base.js';
import type { CommandContext } from '../types/cli.js';
import type { ExportOptions, PatchMetadata } from '../types/commands/index.js';
import type { FireForgeConfig } from '../types/config.js';
import { toError } from '../utils/errors.js';
import { ensureDir, pathExists } from '../utils/fs.js';
import { info, intro, outro, spinner, verbose, warn } from '../utils/logger.js';
import { commanderArgParser, pickDefined } from '../utils/options.js';
import { stripEnginePrefix } from '../utils/paths.js';
import { parsePositiveIntegerFlag } from '../utils/validation.js';
import { commitPlacementExport, type PlacementPlan, renderDryRunPreview } from './export-flow.js';
import { gatePlacementPlan, patchMetadataExtras } from './export-placement-gate.js';
import {
  autoFixLicenseHeaders,
  promptExportPatchMetadata,
  runPatchLint,
  runSupersedeAndOverlapGates,
} from './export-shared.js';

/** Collected export candidates, tracking which came from directory expansion. */
interface CollectedExportFiles {
  files: string[];
  /** Files discovered by expanding a DIRECTORY argument (not named explicitly). */
  fromDirectory: Set<string>;
}

async function collectExportFiles(
  paths: ReturnType<typeof getProjectPaths>,
  files: string[]
): Promise<CollectedExportFiles> {
  const collectedFiles = new Set<string>();
  const fromDirectory = new Set<string>();

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
      for (const f of modifiedFiles) {
        collectedFiles.add(f);
        fromDirectory.add(f);
      }
      for (const f of dirUntrackedFiles) {
        collectedFiles.add(f);
        fromDirectory.add(f);
      }
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
      // A file named explicitly always stays in the export set, even if a
      // directory argument also swept it up.
      fromDirectory.delete(inputPath);
    }
  }

  return { files: [...collectedFiles].sort(), fromDirectory };
}

/**
 * Auto-excludes directory-derived files already owned by OTHER patches
 * (0.34.0 field report): a directory export used to plan files owned by
 * earlier patches into the new patch, and the duplicate-new-file-creation
 * refusal surfaced only at placement lint, suggesting --force-unsafe —
 * the wrong tool for "leave that file with its owner". Explicitly named
 * files are never excluded (the overlap gates still confront the operator
 * with those). Prints one notice per exclusion.
 */
async function excludeFilesOwnedByOtherPatches(
  patchesDir: string,
  collected: CollectedExportFiles
): Promise<string[]> {
  if (collected.fromDirectory.size === 0) return collected.files;
  const manifest = await loadPatchesManifest(patchesDir);
  if (!manifest) return collected.files;

  const owners = new Map<string, string>();
  for (const patch of manifest.patches) {
    for (const file of patch.filesAffected) {
      if (!owners.has(file)) owners.set(file, patch.filename);
    }
  }

  const kept: string[] = [];
  let excludedCount = 0;
  for (const file of collected.files) {
    const owner = collected.fromDirectory.has(file) ? owners.get(file) : undefined;
    if (owner !== undefined) {
      info(`Excluding ${file} from the directory export (owned by ${owner})`);
      excludedCount += 1;
    } else {
      kept.push(file);
    }
  }
  if (excludedCount > 0) {
    info(
      `Excluded ${excludedCount} file${excludedCount === 1 ? '' : 's'} owned by other patches. ` +
        'Use "fireforge re-export <patch> --files ..." to update the owning patch, or name the ' +
        'file explicitly in this export to move it deliberately.'
    );
  }
  return kept;
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

/** Everything `exportCommand` resolves before the spinner starts. */
interface ExportPreparation {
  paths: ReturnType<typeof getProjectPaths>;
  placementFlagCount: number;
  diff: string;
  config: FireForgeConfig;
  isInteractive: boolean;
  metadata: NonNullable<Awaited<ReturnType<typeof promptExportPatchMetadata>>>;
}

/**
 * Validation + diff phase of `exportCommand`: checks flag combinations and
 * the engine checkout, collects the export file set (honouring
 * `--exclude-furnace`), generates the diff, auto-fixes license headers,
 * and prompts for patch metadata. Returns `null` when the operator
 * cancelled the metadata prompt (the command ends silently, matching the
 * prompt's own cancel handling).
 */
async function prepareExport(
  projectRoot: string,
  files: string[],
  options: ExportOptions
): Promise<ExportPreparation | null> {
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

  const collected = await collectExportFiles(paths, files);
  let allFiles = await excludeFilesOwnedByOtherPatches(paths.patches, collected);
  const ownershipExclusions = collected.files.length - allFiles.length;

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
    if (ownershipExclusions > 0) {
      throw new GeneralError(
        `Every changed file under "${pathList}" is already owned by another patch ` +
          '(see the exclusions above).\n\n' +
          'Use "fireforge re-export <patch> --files ..." to refresh the owning patch instead.'
      );
    }
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

  // Ensure patches directory exists. Skip during a dry-run so the command
  // is purely read-only (matching export-all's dry-run contract).
  if (!options.dryRun) {
    await ensureDir(paths.patches);
  }

  const config = await loadConfig(projectRoot);
  const isInteractive = process.stdin.isTTY && process.stdout.isTTY;

  // Auto-fix missing license headers on new files (interactive only;
  // report-only under --dry-run so the preview never mutates engine/)
  const headersAdded = await autoFixLicenseHeaders(
    paths.engine,
    diff,
    config,
    isInteractive,
    options.dryRun ?? false
  );
  if (headersAdded) {
    diff = await generatePatchDiff(paths.engine, allFiles);
  }

  const metadata = await promptExportPatchMetadata(options, isInteractive, 'export', config);
  if (!metadata) return null;

  return { paths, placementFlagCount, diff, config, isInteractive, metadata };
}

/**
 * Runs the export command to export file changes as a patch.
 * Accepts one or more file/directory paths and bundles them into a single patch.
 * @param projectRoot - Root directory of the project
 * @param files - File or directory paths to export (relative to engine/)
 * @param options - Export options
 */
export async function exportCommand(
  projectRoot: string,
  files: string[],
  options: ExportOptions
): Promise<void> {
  const isDryRun = options.dryRun === true;
  intro(isDryRun ? 'FireForge Export (dry run)' : 'FireForge Export');

  const prepared = await prepareExport(projectRoot, files, options);
  if (!prepared) return;
  const { paths, placementFlagCount, diff, config, isInteractive, metadata } = prepared;
  const { patchName, selectedCategory, description } = metadata;

  const s = spinner(isDryRun ? 'Planning export...' : 'Exporting patch...');

  try {
    // Extract affected files from diff
    const filesAffected = extractAffectedFiles(diff);

    // Apply the just-set --tier and --lint-ignore on the lint pass so the
    // operator's intent takes effect on this invocation, not only on the
    // next one. Without this, a fresh export with `--tier branding` would
    // still hit general thresholds because the lint runs before the
    // metadata is committed.
    const exportIgnoreChecks =
      options.lintIgnore && options.lintIgnore.length > 0
        ? new Set<string>(options.lintIgnore)
        : undefined;
    const patchQueueCtx = (await pathExists(paths.patches))
      ? await buildPatchQueueContext(paths.patches)
      : undefined;
    await runPatchLint(
      paths.engine,
      filesAffected,
      diff,
      config,
      options.skipLint,
      patchQueueCtx,
      exportIgnoreChecks,
      options.tier
    );

    // Resolve placement (if any flag was given). Placement is mutually
    // exclusive with supersede — the semantics overlap confusingly.
    let placementPlan: PlacementPlan | null = null;
    if (placementFlagCount > 0) {
      const gated = await gatePlacementPlan({
        patchesDir: paths.patches,
        options,
        selectedCategory,
        patchName,
        description,
        filesAffected,
        diff,
        config,
        isDryRun,
        s,
      });
      if (gated === 'stop') return;
      placementPlan = gated;
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
        ...buildPatchSourceMetadata(config.firefox),
        explicitSupersede: options.supersede === true,
        allowOverlap: options.allowOverlap === true,
        ...patchMetadataExtras(options),
        config,
        forceUnsafe: options.forceUnsafe === true,
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
        ...buildPatchSourceMetadata(config.firefox),
        filesAffected,
        ...patchMetadataExtras(options),
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
        config,
        forceUnsafe: options.forceUnsafe === true,
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
    const shouldProceedPastGates = await runSupersedeAndOverlapGates({
      patchesDir: paths.patches,
      filesAffected,
      supersede: options.supersede,
      allowOverlap: options.allowOverlap === true,
      isInteractive,
      s,
    });
    if (!shouldProceedPastGates) return;

    const { patchFilename, superseded } = await commitExportedPatch({
      patchesDir: paths.patches,
      category: selectedCategory,
      name: patchName,
      description,
      diff,
      filesAffected,
      ...buildPatchSourceMetadata(config.firefox),
      ...patchMetadataExtras(options),
      config,
      policyCommand: 'export',
      forceUnsafe: options.forceUnsafe === true,
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
    .option('-c, --category <category>', 'Patch category')
    .option('-d, --description <desc>', 'Description of the patch')
    .option('--supersede', 'Allow superseding multiple existing patches')
    .option('--skip-lint', 'Skip patch lint checks (downgrade errors to warnings)')
    .option('--dry-run', 'Print the export plan (including supersede preview) without writing')
    .addOption(
      new Option(
        '--order <N>',
        'Place the new patch at this exact unused order without renumbering existing patches'
      ).argParser(commanderArgParser((v) => parsePositiveIntegerFlag('--order', v)))
    )
    .option('--before <anchor>', 'Place the new patch immediately before <anchor>')
    .option('--after <anchor>', 'Place the new patch immediately after <anchor>')
    .option('-y, --yes', 'Skip confirmation for placement renumbers (required for non-TTY)')
    .option('--force-unsafe', 'Bypass cross-patch lint refusal on projected placement')
    .option('--exclude-furnace', 'Exclude furnace-managed file paths from the export')
    .option(
      '--allow-overlap',
      'Acknowledge cross-patch ownership overlap (default mode only; the resulting queue fails verify)'
    )
    .addOption(
      new Option(
        '--tier <tier>',
        'Force a tier override on the new patch (only "branding" recognised)'
      ).choices(['branding'])
    )
    .option(
      '--lint-ignore <check-id>',
      'Suppress a lint check on this patch (writes to PatchMetadata.lintIgnore; repeatable)',
      (value: string, prev: string[]) => [...prev, value],
      [] as string[]
    )
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
            allowOverlap?: boolean;
            tier?: string;
            lintIgnore?: string[];
          }
        ) => {
          const { category, tier, lintIgnore, ...rest } = options;
          const projectRoot = getProjectRoot();
          await withEngineSessionLock(projectRoot, 'export', () =>
            exportCommand(projectRoot, paths, {
              ...pickDefined(rest),
              ...(category !== undefined ? { category } : {}),
              ...(tier !== undefined ? { tier: tier as 'branding' } : {}),
              ...(lintIgnore !== undefined && lintIgnore.length > 0 ? { lintIgnore } : {}),
            })
          );
        }
      )
    );
}
