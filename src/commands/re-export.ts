// SPDX-License-Identifier: EUPL-1.2
import { dirname, join } from 'node:path';

import { confirm, multiselect } from '@clack/prompts';
import { Command } from 'commander';

import { getProjectPaths, loadConfig } from '../core/config.js';
import { isGitRepository } from '../core/git.js';
import { getDiffForFilesAgainstHead } from '../core/git-diff.js';
import { getModifiedFilesInDir, getUntrackedFilesInDir } from '../core/git-status.js';
import { updatePatchAndMetadata } from '../core/patch-export.js';
import {
  getClaimedFiles,
  loadPatchesManifest,
  resolvePatchIdentifier,
  stampPatchVersions,
} from '../core/patch-manifest.js';
import { GeneralError, InvalidArgumentError } from '../errors/base.js';
import type { CommandContext } from '../types/cli.js';
import type { PatchesManifest, PatchMetadata, ReExportOptions } from '../types/commands/index.js';
import type { FireForgeConfig } from '../types/config.js';
import { toError } from '../utils/errors.js';
import { pathExists } from '../utils/fs.js';
import { cancel, info, intro, isCancel, outro, spinner, success, warn } from '../utils/logger.js';

/**
 * Threshold above which `--scan` must be explicitly confirmed. Values were
 * picked so the common "refresh after one-or-two-file tweak" case stays
 * frictionless while catching the eval finding #13 scenario where `--scan`
 * silently pulled in an entire sibling feature (xhtml + tests + theme CSS).
 */
const SCAN_ADD_COUNT_THRESHOLD = 3;
const SCAN_DIR_COUNT_THRESHOLD = 2;
import { pickDefined } from '../utils/options.js';
import { runPatchLint } from './export-shared.js';
import { reExportFilesInPlace } from './re-export-files.js';

interface ScanResult {
  updated: string[];
  added: string[];
  removed: string[];
}

async function scanPatchFiles(
  currentFilesAffected: string[],
  engineDir: string,
  manifest: PatchesManifest,
  patchFilename: string,
  isDryRun: boolean
): Promise<ScanResult> {
  const parentDirs = [...new Set(currentFilesAffected.map((f) => dirname(f)))];
  const claimedByOthers = getClaimedFiles(manifest, patchFilename);

  const discoveredFiles = new Set<string>();
  for (const dir of parentDirs) {
    const modifiedFiles = await getModifiedFilesInDir(engineDir, dir);
    const untrackedFiles = await getUntrackedFilesInDir(engineDir, dir);
    for (const f of [...modifiedFiles, ...untrackedFiles]) {
      discoveredFiles.add(f);
    }
  }

  const currentSet = new Set(currentFilesAffected);
  const added: string[] = [];
  for (const f of discoveredFiles) {
    if (!currentSet.has(f) && !claimedByOthers.has(f)) {
      added.push(f);
    }
  }

  const removed: string[] = [];
  for (const f of currentFilesAffected) {
    const filePath = join(engineDir, f);
    if (!(await pathExists(filePath))) {
      removed.push(f);
    }
  }

  const sortedAdded = [...added].sort();
  const sortedRemoved = [...removed].sort();

  for (const f of sortedAdded) {
    info(`  + ${f}`);
  }
  for (const f of sortedRemoved) {
    info(`  - ${f}`);
  }

  if (added.length > 0 || removed.length > 0) {
    const removedSet = new Set(removed);
    const updated = [...currentFilesAffected.filter((f) => !removedSet.has(f)), ...added].sort();

    info(
      `  ${isDryRun ? 'Would update' : 'Updated'} ${patchFilename}: +${added.length} / -${removed.length} files`
    );
    return { updated, added: sortedAdded, removed: sortedRemoved };
  }

  return { updated: currentFilesAffected, added: [], removed: [] };
}

/**
 * Returns true when the caller-confirmed threshold is exceeded for this
 * scan's additions. The heuristic treats "small, same-directory" additions
 * as friction-free (the common refresh case) and flags larger or
 * multi-directory expansions so operators see them before they land.
 *
 * Pre-0.16.0 `--scan` silently broadened patches to include any modified or
 * untracked file that shared a parent directory with the existing
 * filesAffected — in practice, pulling adjacent feature code into a patch
 * that had nothing to do with it. The gate below turns the broadening into
 * an explicit opt-in.
 */
function scanAdditionsNeedConfirmation(added: readonly string[]): boolean {
  if (added.length === 0) return false;
  if (added.length > SCAN_ADD_COUNT_THRESHOLD) return true;
  const dirs = new Set(added.map((f) => dirname(f)));
  return dirs.size >= SCAN_DIR_COUNT_THRESHOLD;
}

/**
 * Gate for broad `--scan` additions. Enforces explicit acknowledgement when
 * the scan would pull in more files than a narrow refresh. Dry-run always
 * proceeds (the preview is the whole point).
 *
 * @returns true if the caller should proceed; false if the user cancelled.
 */
async function confirmBroadScanAdditions(args: {
  patchFilename: string;
  added: readonly string[];
  isDryRun: boolean;
  yes: boolean;
  isInteractive: boolean;
}): Promise<boolean> {
  const { patchFilename, added, isDryRun, yes, isInteractive } = args;
  if (isDryRun) return true;
  if (!scanAdditionsNeedConfirmation(added)) return true;
  if (yes) return true;

  warn(
    `${patchFilename}: --scan would add ${String(added.length)} file(s) that span ${String(new Set(added.map((f) => dirname(f))).size)} director${new Set(added.map((f) => dirname(f))).size === 1 ? 'y' : 'ies'}. ` +
      'Broad scans can silently pull adjacent features into a patch — review the diff before continuing.'
  );

  if (!isInteractive) {
    throw new GeneralError(
      `Refusing to broaden "${patchFilename}" via --scan in non-interactive mode. ` +
        'Pass --yes to acknowledge the expansion, or run with --dry-run first to review.'
    );
  }

  const confirmed = await confirm({
    message: `Proceed and broaden ${patchFilename} with ${String(added.length)} newly discovered file(s)?`,
    initialValue: false,
  });

  if (isCancel(confirmed) || !confirmed) {
    cancel(`Skipped ${patchFilename}`);
    return false;
  }
  return true;
}

async function reExportSinglePatch(
  patch: PatchMetadata,
  paths: ReturnType<typeof getProjectPaths>,
  manifest: PatchesManifest,
  options: ReExportOptions,
  isDryRun: boolean,
  config: FireForgeConfig
): Promise<boolean> {
  let currentFilesAffected = [...patch.filesAffected];

  // --- Scan for new/removed files ---
  if (options.scan) {
    const scanResult = await scanPatchFiles(
      currentFilesAffected,
      paths.engine,
      manifest,
      patch.filename,
      isDryRun
    );
    const isInteractive = process.stdin.isTTY && process.stdout.isTTY;
    const proceed = await confirmBroadScanAdditions({
      patchFilename: patch.filename,
      added: scanResult.added,
      isDryRun,
      yes: options.yes === true,
      isInteractive,
    });
    if (!proceed) {
      return false;
    }
    currentFilesAffected = scanResult.updated;
  } else if (options.files === undefined) {
    // Finding #16: when neither `--scan` nor `--files` is set and some
    // of the manifest's claimed files no longer exist on disk, the
    // re-export silently writes a refreshed body whose filesAffected
    // still names the vanished paths. That is the documented contract,
    // but it is also a footgun — a later `verify` then fails on
    // manifest-consistency with no obvious trigger. Emit one advisory
    // warning up-front when we can detect the drift cheaply, so the
    // operator has a chance to re-run with `--scan` or `--files`
    // before the stale filesAffected lands in patches.json.
    const missingFiles: string[] = [];
    for (const file of currentFilesAffected) {
      if (!(await pathExists(join(paths.engine, file)))) {
        missingFiles.push(file);
      }
    }
    if (missingFiles.length > 0) {
      warn(
        `${patch.filename}: some files in patches.json no longer exist on disk ` +
          `(${missingFiles.join(', ')}). Without --scan, re-export keeps the manifest's ` +
          `filesAffected unchanged and the missing entries will be preserved — ` +
          `\`fireforge verify\` may flag manifest inconsistency after this run.\n` +
          `  Re-run with --scan to reconcile filesAffected with the current worktree, ` +
          `or pass --files <paths> to set the list explicitly.`
      );
    }
  }

  // --- Explicit file-subset path ---
  // When --files is given, the target filesAffected is authoritative — drop
  // anything not in the list, add anything new. This is the surgical repair
  // primitive that replaces hand-editing patches.json; the user has already
  // acknowledged via confirmDestructive (done in the caller) that any drop
  // is intentional.
  if (options.files !== undefined) {
    const requested = [...new Set(options.files)].sort();
    currentFilesAffected = requested;
    const removed = patch.filesAffected.filter((f) => !requested.includes(f));
    const added = requested.filter((f) => !patch.filesAffected.includes(f));
    for (const f of added) info(`  + ${f}`);
    for (const f of removed) info(`  - ${f}`);
  }

  const missingFiles: string[] = [];
  for (const file of currentFilesAffected) {
    const filePath = join(paths.engine, file);
    if (!(await pathExists(filePath))) {
      missingFiles.push(file);
    }
  }

  if (missingFiles.length === currentFilesAffected.length) {
    warn(`Skipped ${patch.filename}: all affected files missing`);
    warn(`Missing files: ${missingFiles.join(', ')}`);
    return false;
  }

  if (missingFiles.length > 0) {
    warn(`${patch.filename}: missing files will be skipped: ${missingFiles.join(', ')}`);
  }

  const missingSet = new Set(missingFiles);
  const existingFiles = currentFilesAffected.filter((f) => !missingSet.has(f));

  const diffContent = await getDiffForFilesAgainstHead(paths.engine, existingFiles);

  if (!diffContent.trim()) {
    warn(`Skipped ${patch.filename}: no changes (files unchanged from HEAD)`);
    return false;
  }

  // Thread the patch's own `lintIgnore` list through so the per-patch
  // suppression honoured by export/export-all is also honoured here.
  // Without this, `re-export` could not refresh an advisory-noisy but
  // intentional patch (a cohesive branding bundle, a localised-resource
  // pack) without either `--skip-lint` (too blunt) or falling through to
  // the full `rebase` flow (which internally skips the lint pipeline).
  const ignoreChecks = patch.lintIgnore?.length ? new Set<string>(patch.lintIgnore) : undefined;

  await runPatchLint(
    paths.engine,
    existingFiles,
    diffContent,
    config,
    options.skipLint,
    undefined,
    ignoreChecks
  );

  if (isDryRun) {
    info(`[dry-run] ${patch.filename}: ${existingFiles.length} file(s)`);
  } else {
    // Atomic body + manifest update under a single patch-directory lock.
    // A split `updatePatch` (lock-free) + `updatePatchMetadata` (lock-guarded)
    // sequence allows a concurrent `resolve` / `rebase --continue` / `patch
    // compact` / `patch reorder` to rewrite the manifest between the two
    // writes and leave patch body and `filesAffected` disagreeing.
    await updatePatchAndMetadata(paths.patches, patch.filename, diffContent, {
      filesAffected: currentFilesAffected,
    });

    // Keep the in-memory manifest in sync so subsequent iterations (notably
    // `--all --scan`, where `getClaimedFiles` reads from this manifest) see
    // the just-written `filesAffected`. The on-disk write above is the
    // authority; this is a cache update.
    const patchIndex = manifest.patches.findIndex((pm) => pm.filename === patch.filename);
    if (patchIndex !== -1) {
      const existingEntry = manifest.patches[patchIndex];
      if (existingEntry) {
        manifest.patches[patchIndex] = {
          ...existingEntry,
          filesAffected: currentFilesAffected,
        };
      }
    }

    success(`Re-exported ${patch.filename}`);
  }
  return true;
}

async function resolveSelectedPatches(
  patches: string[],
  options: ReExportOptions,
  manifest: PatchesManifest
): Promise<PatchMetadata[] | null> {
  if (options.all) {
    return [...manifest.patches];
  }

  if (patches.length > 0) {
    const selectedPatches: PatchMetadata[] = [];
    for (const identifier of patches) {
      const match = resolvePatchIdentifier(identifier, manifest.patches);
      if (!match) {
        const available = manifest.patches.map((p) => p.filename).join(', ');
        throw new InvalidArgumentError(
          `Patch "${identifier}" not found in manifest.\n\nAvailable patches: ${available}`,
          identifier
        );
      }
      selectedPatches.push(match);
    }
    return selectedPatches;
  }

  // No patches specified — prompt or error
  const isInteractive = process.stdin.isTTY && process.stdout.isTTY;

  if (!isInteractive) {
    throw new InvalidArgumentError(
      'Specify patch identifiers or use --all in non-interactive mode.\n\n' +
        'Usage: fireforge re-export [patches...] or fireforge re-export --all',
      'patches'
    );
  }

  const selected = await multiselect({
    message: 'Select patches to re-export:',
    options: manifest.patches.map((patch) => ({
      value: patch.filename,
      label: `${patch.filename} — ${patch.description || patch.name}`,
    })),
  });

  if (isCancel(selected)) {
    cancel('Re-export cancelled');
    return null;
  }

  const selectedFilenames = selected as string[];
  return manifest.patches.filter((p) => selectedFilenames.includes(p.filename));
}

/**
 * Runs the re-export command to regenerate existing patches from current engine state.
 * @param projectRoot - Root directory of the project
 * @param patches - Patch identifiers (numbers or filenames)
 * @param options - Re-export options
 */
export async function reExportCommand(
  projectRoot: string,
  patches: string[],
  options: ReExportOptions
): Promise<void> {
  const isDryRun = options.dryRun === true;
  intro(isDryRun ? 'FireForge Re-export (dry run)' : 'FireForge Re-export');

  // --files is mutually exclusive with --scan and --all: they select
  // different scope contracts.
  if (options.files !== undefined) {
    if (options.all || options.scan) {
      throw new InvalidArgumentError('--files cannot be combined with --scan or --all.', '--files');
    }
    if (patches.length !== 1) {
      throw new InvalidArgumentError(
        '--files operates on exactly one target patch. Pass a single patch identifier.',
        '--files'
      );
    }
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

  // Load the manifest
  const manifest = await loadPatchesManifest(paths.patches);
  if (!manifest || manifest.patches.length === 0) {
    throw new GeneralError(
      'No patches found in manifest. Run "fireforge export" to create patches first.'
    );
  }

  // Resolve which patches to re-export
  const selectedPatches = await resolveSelectedPatches(patches, options, manifest);
  if (!selectedPatches) return;

  if (selectedPatches.length === 0) {
    warn('No patches selected');
    outro('Nothing to re-export');
    return;
  }

  // --files path: handled end-to-end here so we can lint the *projected*
  // shrunken state (not the current queue) and skip the generic re-export
  // loop. The projection substitutes the target patch's diff and newFiles
  // with the freshly computed content, then runs lintPatchQueue so any
  // forward-import introduced or uncovered by the shrink is caught before
  // we write anything.
  if (options.files !== undefined) {
    const filesConfig = await loadConfig(projectRoot);
    await reExportFilesInPlace(paths, selectedPatches, options, filesConfig);
    return;
  }

  const config = await loadConfig(projectRoot);

  let reExported = 0;
  const reExportedFilenames: string[] = [];
  const progress = spinner('Preparing re-export...');

  for (const patch of selectedPatches) {
    progress.message(`Re-exporting ${patch.filename}...`);
    try {
      const exported = await reExportSinglePatch(patch, paths, manifest, options, isDryRun, config);
      if (exported) {
        reExported++;
        reExportedFilenames.push(patch.filename);
      }
    } catch (error: unknown) {
      warn(`Failed to re-export ${patch.filename}`);
      warn(toError(error).message);
    }
  }

  if (reExported === 0 && selectedPatches.length > 0) {
    progress.error('Re-export failed');
    throw new GeneralError('All selected patches failed to re-export. Check the errors above.');
  }

  // `--stamp` only fires on a run where every selected patch refreshed
  // cleanly. A partial success would leave some patches with a stale body
  // but a new version — the opposite of the "what I tested, what the
  // manifest says" invariant `sourceEsrVersion` exists to record. A
  // non-empty `reExportedFilenames` with fewer entries than `selectedPatches`
  // means a lint failure or missing-file skip landed somewhere in the loop,
  // which we refuse to version-stamp through.
  const shouldStamp =
    options.stamp === true && !isDryRun && reExported > 0 && reExported === selectedPatches.length;

  if (shouldStamp) {
    await stampPatchVersions(paths.patches, reExportedFilenames, config.firefox.version);
  }

  if (isDryRun) {
    progress.stop('Dry run complete');
    success(`[dry-run] Would re-export ${reExported} of ${selectedPatches.length} patch(es)`);
    if (options.stamp === true) {
      info(
        `[dry-run] Would stamp sourceEsrVersion=${config.firefox.version} on ${reExported} patch(es)`
      );
    }
    outro('Dry run complete');
  } else {
    progress.stop('Re-export complete');
    success(`Re-exported ${reExported} of ${selectedPatches.length} patch(es)`);
    if (shouldStamp) {
      success(
        `Stamped sourceEsrVersion=${config.firefox.version} on ${reExportedFilenames.length} patch(es)`
      );
    } else if (options.stamp === true && reExported !== selectedPatches.length) {
      warn(
        '--stamp was requested but some patches failed or were skipped; refusing to stamp a partial set.'
      );
    }
    outro('Re-export complete');
  }
}

/** Registers the re-export command on the CLI program. */
export function registerReExport(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  program
    .command('re-export [patches...]')
    .description(
      'Refresh existing patch bodies (and filesAffected with --scan) from the current engine ' +
        'state. Does NOT change sourceEsrVersion by default — use --stamp or run rebase for ' +
        'version stamping.'
    )
    .option('-a, --all', 'Re-export all patches')
    .option('-s, --scan', 'Scan directories for new/removed files and update filesAffected')
    .option(
      '--files <paths>',
      'Restrict the re-exported filesAffected to this comma-separated list (single target patch only)',
      (value: string) =>
        value
          .split(',')
          .map((v) => v.trim())
          .filter((v) => v.length > 0)
    )
    .option('--dry-run', 'Show what would change without writing')
    .option('--skip-lint', 'Skip patch lint checks (downgrade errors to warnings)')
    .option('-y, --yes', 'Skip confirmation when --files shrinks a patch (required for non-TTY)')
    .option('--force-unsafe', 'Bypass cross-patch lint refusal when --files shrinks a patch')
    .option(
      '--stamp',
      "After every selected patch refreshes cleanly, stamp each re-exported patch's sourceEsrVersion in patches.json to firefox.version from fireforge.json. No effect on a partial run."
    )
    .action(
      withErrorHandling(
        async (
          patches: string[],
          options: {
            all?: boolean;
            scan?: boolean;
            files?: string[];
            dryRun?: boolean;
            skipLint?: boolean;
            yes?: boolean;
            forceUnsafe?: boolean;
            stamp?: boolean;
          }
        ) => {
          await reExportCommand(getProjectRoot(), patches, pickDefined(options));
        }
      )
    );
}
