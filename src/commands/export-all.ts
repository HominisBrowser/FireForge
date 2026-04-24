// SPDX-License-Identifier: EUPL-1.2
import { Command, Option } from 'commander';

import { isBrandingManagedPath } from '../core/branding.js';
import { getProjectPaths, loadConfig } from '../core/config.js';
import { collectFurnaceManagedPrefixes } from '../core/furnace-config.js';
import { hasChanges, isGitRepository } from '../core/git.js';
import { getAllDiff, getDiffForFilesAgainstHead } from '../core/git-diff.js';
import { expandUntrackedDirectoryEntries, getWorkingTreeStatus } from '../core/git-status.js';
import { extractAffectedFiles } from '../core/patch-apply.js';
import { commitExportedPatch, findAllPatchesForFiles } from '../core/patch-export.js';
import {
  buildPatchQueueContext,
  collectNewFileCreatorsByPath,
  detectNewFilesInDiff,
} from '../core/patch-lint.js';
import { GeneralError } from '../errors/base.js';
import type { CommandContext } from '../types/cli.js';
import type { ExportOptions, PatchCategory } from '../types/commands/index.js';
import { ensureDir, pathExists } from '../utils/fs.js';
import { info, intro, outro, spinner } from '../utils/logger.js';
import { pickDefined } from '../utils/options.js';
import { PATCH_CATEGORIES } from '../utils/validation.js';
import {
  autoFixLicenseHeaders,
  confirmSupersedePatches,
  guardOwnershipOverlap,
  promptExportPatchMetadata,
  runPatchLint,
} from './export-shared.js';

async function checkBrandingManagedFiles(
  paths: ReturnType<typeof getProjectPaths>,
  config: Awaited<ReturnType<typeof loadConfig>>
): Promise<void> {
  const changedFiles = await getWorkingTreeStatus(paths.engine);
  const brandingManagedFiles = changedFiles
    .flatMap((entry) =>
      [entry.file, entry.originalPath].filter((value): value is string => !!value)
    )
    .filter((file) => isBrandingManagedPath(file, config.binaryName));

  if (brandingManagedFiles.length > 0) {
    throw new GeneralError(
      'Export-all refuses to capture tool-managed branding changes by default.\n\n' +
        'Review these files with "fireforge status" first. If you intentionally want a branding patch, export the specific branding paths explicitly with "fireforge export ...".'
    );
  }
}

/**
 * Policy around Furnace-managed files in the aggregate diff.
 *
 * Default behavior refuses the export (Furnace paths belong to
 * `furnace apply`). `--exclude-furnace` flips the policy from refusal to
 * filtering: the command still runs, but the Furnace-managed paths are
 * dropped from the diff and counted in an info line so operators in
 * mixed workspaces can capture only the non-Furnace subset.
 *
 * Returns the set of Furnace-managed paths to exclude (empty when the
 * policy is "refuse" and nothing is in the working tree).
 */
async function resolveFurnaceExclusionPolicy(
  paths: ReturnType<typeof getProjectPaths>,
  projectRoot: string,
  excludeFurnace: boolean | undefined
): Promise<Set<string>> {
  const prefixes = await collectFurnaceManagedPrefixes(projectRoot);
  if (prefixes.size === 0) return new Set();

  // Expand collapsed `?? dir/` entries before matching against Furnace
  // prefixes — otherwise a Furnace-introduced directory slips past the
  // filter and later lands in the non-Furnace path list that feeds the
  // aggregate diff, where `getDiffForFilesAgainstHead` crashes with
  // EISDIR (eval finding: export-all unusable on a fresh project with
  // Furnace scaffolding).
  const rawStatus = await getWorkingTreeStatus(paths.engine);
  const changedFiles = await expandUntrackedDirectoryEntries(paths.engine, rawStatus);
  const furnaceManagedFiles = changedFiles
    .flatMap((entry) =>
      [entry.file, entry.originalPath].filter((value): value is string => !!value)
    )
    .filter((file) => [...prefixes].some((prefix) => file.startsWith(prefix)));

  if (furnaceManagedFiles.length === 0) return new Set();

  if (excludeFurnace) {
    return new Set(furnaceManagedFiles);
  }

  throw new GeneralError(
    'Export-all refuses to capture Furnace-managed component changes.\n\n' +
      'These files are deployed by "fireforge furnace apply" and should be managed through the Furnace workflow. ' +
      'Review them with "fireforge status" or "fireforge furnace status", ' +
      'or pass --exclude-furnace to export the non-Furnace subset of the diff.'
  );
}

/**
 * Refuses the export when the aggregate diff would create (new-file-mode) a
 * path that some existing patch in the queue already creates. `verify`
 * detects this post-hoc via `collectNewFileCreatorsByPath`, but by the time
 * `verify` runs the operator has already landed a patch that irreversibly
 * sits atop the queue — resolving the conflict from there requires a
 * `patch delete` or hand-surgery on `re-export --files`. Catching it here,
 * pre-write, keeps the queue clean and gives the operator a specific path
 * to narrow with `export` + explicit file scoping (which lets them drop
 * the already-claimed path without losing other edits).
 *
 * Slots in alongside the existing branding and furnace guards so the three
 * "export-all refuses" branches remain the single, symmetric fence around
 * unintended captures.
 */
async function checkDuplicateNewFileCreations(
  paths: ReturnType<typeof getProjectPaths>,
  diff: string
): Promise<void> {
  if (!(await pathExists(paths.patches))) return;

  const pendingNewFiles = detectNewFilesInDiff(diff);
  if (pendingNewFiles.size === 0) return;

  const ctx = await buildPatchQueueContext(paths.patches);
  if (ctx.entries.length === 0) return;

  const creators = collectNewFileCreatorsByPath(ctx);
  const conflicts: Array<{ path: string; owners: string[] }> = [];
  for (const path of pendingNewFiles) {
    const owners = creators.get(path);
    if (owners && owners.length > 0) {
      conflicts.push({ path, owners });
    }
  }

  if (conflicts.length === 0) return;

  const conflictList = conflicts
    .map(({ path, owners }) => `  • ${path} — already created by ${owners.join(', ')}`)
    .join('\n');
  throw new GeneralError(
    'Export-all refuses to capture new-file creations that are already claimed by existing patches.\n\n' +
      `Conflicting creations:\n${conflictList}\n\n` +
      'Only one patch may create a given path. Run "fireforge export <path> [...]" with an explicit file list that omits the already-claimed path(s), or resolve the conflict via "fireforge patch delete" / "fireforge re-export --files" before retrying export-all.'
  );
}

/**
 * Runs the export-all command to export all changes as a patch.
 * @param projectRoot - Root directory of the project
 * @param options - Export options
 */
export async function exportAllCommand(
  projectRoot: string,
  options: ExportOptions = {}
): Promise<void> {
  intro('FireForge Export All');

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

  // Check for changes
  if (!(await hasChanges(paths.engine))) {
    info('No changes to export');
    outro('Nothing to export');
    return;
  }

  const config = await loadConfig(projectRoot);
  await checkBrandingManagedFiles(paths, config);
  const furnaceExcluded = await resolveFurnaceExclusionPolicy(
    paths,
    projectRoot,
    options.excludeFurnace
  );

  // Get the full diff. When --exclude-furnace is set and furnaceExcluded
  // is non-empty, rescope the diff to the non-Furnace path subset so the
  // resulting patch does not contain any Furnace-managed hunks. We use
  // `getDiffForFilesAgainstHead` over the filtered path list rather than
  // post-hoc string surgery on the aggregate diff, which keeps the
  // output shape aligned with the single-file `export` command.
  let diff: string;
  if (furnaceExcluded.size > 0) {
    const rawChanged = await getWorkingTreeStatus(paths.engine);
    const allChanged = await expandUntrackedDirectoryEntries(paths.engine, rawChanged);
    const nonFurnacePaths = [
      ...new Set(
        allChanged
          .flatMap((entry) =>
            [entry.file, entry.originalPath].filter((value): value is string => !!value)
          )
          .filter((file) => !furnaceExcluded.has(file))
      ),
    ].sort();

    if (nonFurnacePaths.length === 0) {
      info(
        `Excluded ${furnaceExcluded.size} furnace-managed file(s) from export; no non-Furnace changes remain.`
      );
      outro('Nothing to export');
      return;
    }

    diff = await getDiffForFilesAgainstHead(paths.engine, nonFurnacePaths);
    info(
      `Excluded ${furnaceExcluded.size} furnace-managed file(s) from export; exporting ${nonFurnacePaths.length} remaining path(s).`
    );
  } else {
    diff = await getAllDiff(paths.engine);
  }

  if (!diff.trim()) {
    info('No diff content to export');
    outro('Nothing to export');
    return;
  }

  // Duplicate-creation preflight needs the diff in hand to see which paths
  // the aggregate would newly create, so it runs here instead of alongside
  // the branding / furnace guards that operate on the raw status list.
  await checkDuplicateNewFileCreations(paths, diff);

  // Check for non-interactive mode
  const isInteractive = process.stdin.isTTY && process.stdout.isTTY;

  // Auto-fix missing license headers on new files (interactive only)
  const headersAdded = await autoFixLicenseHeaders(paths.engine, diff, config, isInteractive);
  if (headersAdded) {
    diff = await getAllDiff(paths.engine);
  }

  const metadata = await promptExportPatchMetadata(options, isInteractive, 'export-all');
  if (!metadata) return;
  const { patchName, selectedCategory, description } = metadata;

  // Ensure patches directory exists
  await ensureDir(paths.patches);

  const s = spinner('Exporting all changes...');

  try {
    // Extract affected files from diff
    const filesAffected = extractAffectedFiles(diff);

    await runPatchLint(paths.engine, filesAffected, diff, config, options.skipLint);

    // Check how many existing patches would be superseded
    const shouldProceed = await confirmSupersedePatches(
      paths.patches,
      filesAffected,
      options.supersede,
      isInteractive,
      s
    );
    if (!shouldProceed) return;

    // Overlap gate — see the matching comment in `export.ts`. The same
    // cross-patch ownership problem applies to `export-all` because a
    // mixed aggregate diff often touches shared files like manifest
    // fragments that other patches already claim.
    const willSupersede = await findAllPatchesForFiles(paths.patches, filesAffected);
    const supersedingFilenames = new Set(willSupersede.map((p) => p.filename));
    const shouldProceedPastOverlap = await guardOwnershipOverlap({
      patchesDir: paths.patches,
      filesAffected,
      supersedingFilenames,
      allowOverlap: options.allowOverlap === true,
      isInteractive,
      s,
    });
    if (!shouldProceedPastOverlap) return;

    // Get Firefox version for metadata
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
      info(`Files affected: ${filesAffected.length}`);
    }

    outro('Export complete');
  } catch (error: unknown) {
    s.error('Export failed');
    throw error;
  }
}

/** Registers the export-all command on the CLI program. */
export function registerExportAll(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  program
    .command('export-all')
    .description('Export all changes as a patch')
    .option('--name <name>', 'Name for the patch')
    .addOption(
      new Option('-c, --category <category>', 'Patch category').choices([...PATCH_CATEGORIES])
    )
    .option('-d, --description <desc>', 'Description of the patch')
    .option('--supersede', 'Allow superseding multiple existing patches')
    .option('--skip-lint', 'Skip patch lint checks (downgrade errors to warnings)')
    .option(
      '--exclude-furnace',
      'Export the non-Furnace subset of the aggregate diff instead of refusing when Furnace-managed files are modified. Furnace-managed files are still deployed by "fireforge furnace apply"; this flag only changes whether export-all aborts or filters in their presence.'
    )
    .option(
      '--allow-overlap',
      'Acknowledge cross-patch ownership overlap with non-superseded patches (the resulting queue fails verify)'
    )
    .action(
      withErrorHandling(
        async (options: {
          name?: string;
          category?: string;
          description?: string;
          supersede?: boolean;
          skipLint?: boolean;
          excludeFurnace?: boolean;
          allowOverlap?: boolean;
        }) => {
          const { category, ...rest } = options;
          await exportAllCommand(getProjectRoot(), {
            ...pickDefined(rest),
            ...(category !== undefined ? { category: category as PatchCategory } : {}),
          });
        }
      )
    );
}
