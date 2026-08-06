// SPDX-License-Identifier: EUPL-1.2
/* eslint-disable max-lines -- Re-export is at the guardrail; splitting register plumbing is unrelated to this fix. */
import { multiselect } from '@clack/prompts';
import { Command, Option } from 'commander';

import { getProjectPaths, loadConfig } from '../core/config.js';
import { withEngineSessionLock } from '../core/engine-session-lock.js';
import { collectFurnaceManagedPrefixes } from '../core/furnace-config.js';
import { enforceFreshFurnaceSources } from '../core/furnace-stale-export.js';
import { isGitRepository } from '../core/git.js';
import { getDiffForFilesAgainstHead } from '../core/git-diff.js';
import { updatePatchAndMetadata } from '../core/patch-export.js';
import { buildPatchQueueContext } from '../core/patch-lint.js';
import {
  loadPatchesManifest,
  resolvePatchIdentifier,
  stampPatchVersions,
} from '../core/patch-manifest.js';
import { buildProjectedManifest, enforcePatchPolicy } from '../core/patch-policy.js';
import { GeneralError, InvalidArgumentError } from '../errors/base.js';
import { isGitIndexLockConflict } from '../errors/git.js';
import type { CommandContext } from '../types/cli.js';
import type { PatchesManifest, PatchMetadata, ReExportOptions } from '../types/commands/index.js';
import type { FireForgeConfig } from '../types/config.js';
import { elapsedSince } from '../utils/elapsed.js';
import { toError } from '../utils/errors.js';
import { pathExists } from '../utils/fs.js';
import { cancel, info, intro, isCancel, outro, spinner, success, warn } from '../utils/logger.js';
import { addWaitLockOption, pickDefined, resolveWaitLockSeconds } from '../utils/options.js';
import { runPatchLint } from './export-shared.js';
import type { AdjacentUnmanagedContext } from './re-export-adjacent.js';
import { findMissingFiles, reportAdjacentUnmanagedFiles } from './re-export-adjacent.js';
import { loadScanFilesAssignments, withDryRunReExportLock } from './re-export-bulk-scan.js';
import { reExportFilesInPlace } from './re-export-files.js';
import {
  applyReExportFilesPositionalFolding,
  validateReExportOptionCombinations,
} from './re-export-options.js';
import {
  assertScanAdoptionsHaveNoForwardImports,
  assertScanFileAdditionsHaveDiffHunks,
  confirmBroadScanAdditions,
  normalizeScanFiles,
  scanPatchFilesForReExport,
} from './re-export-scan.js';

const GIT_INDEX_LOCK_RETRY_MS = 300;

/**
 * Retries a single patch re-export exactly once when the failure is
 * transient git `index.lock` contention (an external git process holding
 * the engine repo's index). The retry re-enters `reExportSinglePatch`
 * from the top, so it re-reads clean state; a second lock failure
 * propagates to the loop's honest "N of M" accounting.
 */
async function reExportSinglePatchWithIndexLockRetry(
  patch: PatchMetadata,
  paths: ReturnType<typeof getProjectPaths>,
  manifest: PatchesManifest,
  options: ReExportOptions,
  isDryRun: boolean,
  config: FireForgeConfig,
  adjacentCtx: AdjacentUnmanagedContext
): Promise<boolean> {
  try {
    return await reExportSinglePatch(
      patch,
      paths,
      manifest,
      options,
      isDryRun,
      config,
      adjacentCtx
    );
  } catch (error: unknown) {
    if (!isGitIndexLockConflict(error)) {
      throw error;
    }
    warn(
      `${patch.filename}: git index.lock contention detected — retrying once after ${String(GIT_INDEX_LOCK_RETRY_MS)} ms...`
    );
    await new Promise((resolve) => setTimeout(resolve, GIT_INDEX_LOCK_RETRY_MS));
    return await reExportSinglePatch(
      patch,
      paths,
      manifest,
      options,
      isDryRun,
      config,
      adjacentCtx
    );
  }
}

async function reExportSinglePatch(
  patch: PatchMetadata,
  paths: ReturnType<typeof getProjectPaths>,
  manifest: PatchesManifest,
  options: ReExportOptions,
  isDryRun: boolean,
  config: FireForgeConfig,
  adjacentCtx: AdjacentUnmanagedContext
): Promise<boolean> {
  let currentFilesAffected = [...patch.filesAffected];

  // --- Scan for new/removed files ---
  if (options.scan) {
    const scanResult = await scanPatchFilesForReExport({
      currentFilesAffected,
      engineDir: paths.engine,
      manifest,
      patchFilename: patch.filename,
      isDryRun,
      ...(options.scanFiles !== undefined ? { scanFiles: options.scanFiles } : {}),
    });

    // Forward-import gate at adoption time (runs in dry-run too): refuse
    // to adopt unmanaged files that import modules created by LATER
    // patches — the after-the-fact lint failure this leaves behind is the
    // field-reported footgun. Applies to broad --scan, --scan-file, and
    // the --scan-files bulk assignments alike.
    await assertScanAdoptionsHaveNoForwardImports({
      patchesDir: paths.patches,
      engineDir: paths.engine,
      patchFilename: patch.filename,
      added: scanResult.added,
    });

    if (options.scanFiles === undefined) {
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
    const args = { patch, paths, manifest, currentFilesAffected, ctx: adjacentCtx };
    if (await reportAdjacentUnmanagedFiles(args)) return false;
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

  // Stale-furnace-source gate (0.37.0 item 4): re-export captures deployed
  // engine copies, so a component source edited after the last furnace
  // apply would land in the patch as its OLD deployed content. Refuse (or
  // warn under --allow-stale-furnace) before diffing. Runs in dry-run too
  // so the failure surfaces early.
  await enforceFreshFurnaceSources(
    paths.root,
    currentFilesAffected,
    options.allowStaleFurnace === true,
    're-export'
  );

  const missingFiles = await findMissingFiles(paths.engine, currentFilesAffected);

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
  assertScanFileAdditionsHaveDiffHunks({
    diffContent,
    patchFilename: patch.filename,
    previousFilesAffected: patch.filesAffected,
    scanFiles: options.scanFiles,
  });

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
  // The paired `patch.tier` threads the explicit branding-threshold
  // opt-in the same way, for the branding patch that also touches a
  // non-allowlisted registration sibling.
  //
  // The CLI flags `--tier` and `--lint-ignore` participate too, with
  // append/union semantics on the lint-ignore list (the operator's
  // intuition for "I want this patch to also suppress X" — explicit
  // removal lives on the `fireforge patch lint-ignore` subcommand).
  // Computed before the lint pass so the new intent takes effect on
  // this invocation, not the next one.
  const existingIgnoreSet = new Set<string>(patch.lintIgnore ?? []);
  const flagIgnoreSet = new Set<string>(options.lintIgnore ?? []);
  const mergedIgnoreSet = new Set<string>([...existingIgnoreSet, ...flagIgnoreSet]);
  const effectiveLintIgnore = mergedIgnoreSet.size > 0 ? [...mergedIgnoreSet] : undefined;
  const ignoreChecks = effectiveLintIgnore ? new Set<string>(effectiveLintIgnore) : undefined;
  const effectiveTier = options.tier ?? patch.tier;
  const updates: Partial<PatchMetadata> = {
    filesAffected: currentFilesAffected,
  };
  if (options.tier !== undefined) {
    updates.tier = options.tier;
  }
  if (effectiveLintIgnore !== undefined && flagIgnoreSet.size > 0) {
    updates.lintIgnore = effectiveLintIgnore;
  }

  enforcePatchPolicy({
    config,
    manifest: buildProjectedManifest(
      manifest,
      manifest.patches.map((entry) =>
        entry.filename === patch.filename ? { ...entry, ...updates } : entry
      )
    ),
    command: 're-export',
    forceUnsafe: options.forceUnsafe === true,
  });

  // Pass the whole-queue context so checkJs resolves cross-patch
  // `resource:///` imports against the real owning sources (report scope
  // stays this patch — see runPatchLint).
  const patchQueueCtx = (await pathExists(paths.patches))
    ? await buildPatchQueueContext(paths.patches)
    : undefined;
  await runPatchLint(
    paths.engine,
    existingFiles,
    diffContent,
    config,
    options.skipLint,
    patchQueueCtx,
    ignoreChecks,
    effectiveTier
  );

  if (isDryRun) {
    info(`[dry-run] ${patch.filename}: ${existingFiles.length} file(s)`);
    if (effectiveTier !== undefined && effectiveTier !== patch.tier) {
      info(`[dry-run] ${patch.filename}: tier would become ${effectiveTier}`);
    }
    const addedIgnores = [...flagIgnoreSet].filter((id) => !existingIgnoreSet.has(id));
    if (addedIgnores.length > 0) {
      info(`[dry-run] ${patch.filename}: lintIgnore would gain ${addedIgnores.join(', ')}`);
    }
  } else {
    // Atomic body + manifest update under a single patch-directory lock.
    // A split `updatePatch` (lock-free) + `updatePatchMetadata` (lock-guarded)
    // sequence allows a concurrent `resolve` / `rebase --continue` / `patch
    // compact` / `patch reorder` to rewrite the manifest between the two
    // writes and leave patch body and `filesAffected` disagreeing.
    await updatePatchAndMetadata(paths.patches, patch.filename, diffContent, updates, undefined, {
      config,
      command: 're-export',
      forceUnsafe: options.forceUnsafe === true,
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
          ...updates,
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
  const normalizedScanFiles = normalizeScanFiles(options.scanFiles);
  if (normalizedScanFiles !== undefined) {
    options = { ...options, scanFiles: normalizedScanFiles };
  } else if (options.scanFiles !== undefined) {
    const cleanedOptions: ReExportOptions = { ...options };
    delete cleanedOptions.scanFiles;
    options = cleanedOptions;
  }

  const isDryRun = options.dryRun === true;
  intro(isDryRun ? 'FireForge Re-export (dry run)' : 'FireForge Re-export');

  // Accept export-style space-separated paths after --files by folding
  // path-shaped extra positionals into the file list (0.34.0 field report).
  ({ patches, options } = applyReExportFilesPositionalFolding(patches, options));

  validateReExportOptionCombinations(patches, options);

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

  const scanFilesByPatch =
    options.scanFilesManifest !== undefined
      ? await loadScanFilesAssignments(options.scanFilesManifest, manifest)
      : undefined;

  // Resolve which patches to re-export
  const selectedPatches =
    scanFilesByPatch !== undefined
      ? manifest.patches.filter((patch) => scanFilesByPatch.has(patch.filename))
      : await resolveSelectedPatches(patches, options, manifest);
  if (!selectedPatches) return;

  if (selectedPatches.length === 0) {
    warn('No patches selected');
    outro('Nothing to re-export');
    return;
  }

  if (scanFilesByPatch !== undefined) {
    info(`Bulk scan assignments from ${options.scanFilesManifest}`);
    for (const patch of selectedPatches) {
      const files = scanFilesByPatch.get(patch.filename) ?? [];
      info(`  ${patch.filename} <= ${files.length} file(s)`);
      for (const file of files) info(`    + ${file}`);
    }
  }

  // --files path: handled end-to-end here so we can lint the *projected*
  // shrunken state (not the current queue) and skip the generic re-export
  // loop. The projection substitutes the target patch's diff and newFiles
  // with the freshly computed content, then runs lintPatchQueue so any
  // forward-import introduced or uncovered by the shrink is caught before
  // we write anything.
  if (options.files !== undefined) {
    const filesConfig = await loadConfig(projectRoot);
    await withDryRunReExportLock(paths.fireforgeDir, isDryRun, () =>
      reExportFilesInPlace(paths, selectedPatches, options, filesConfig)
    );
    return;
  }

  const config = await loadConfig(projectRoot);

  // Classification inputs for the scan-less adjacency advisory, computed
  // once for the whole run (FORGE G2).
  const adjacentCtx: AdjacentUnmanagedContext = {
    binaryName: config.binaryName,
    furnacePrefixes: await collectFurnaceManagedPrefixes(paths.root),
    refuseAdjacentUnmanaged: options.refuseAdjacentUnmanaged === true,
    refusals: [],
  };

  let reExported = 0;
  const reExportedFilenames: string[] = [];
  const progress = spinner('Preparing re-export...');
  const startedAt = Date.now();

  await withDryRunReExportLock(paths.fireforgeDir, isDryRun, async () => {
    for (const [index, patch] of selectedPatches.entries()) {
      const assignedScanFiles = scanFilesByPatch?.get(patch.filename);
      const patchOptions =
        assignedScanFiles !== undefined ? { ...options, scanFiles: assignedScanFiles } : options;
      progress.message(
        `Re-exporting ${index + 1}/${selectedPatches.length}: ${patch.filename} (${patch.filesAffected.length} file(s), ${elapsedSince(startedAt)} elapsed)...`
      );
      try {
        const exported = await reExportSinglePatchWithIndexLockRetry(
          patch,
          paths,
          manifest,
          patchOptions,
          isDryRun,
          config,
          adjacentCtx
        );
        if (exported) {
          reExported++;
          reExportedFilenames.push(patch.filename);
        }
      } catch (error: unknown) {
        warn(`Failed to re-export ${patch.filename}`);
        warn(toError(error).message);
      }
    }
  });

  if (adjacentCtx.refusals.length > 0) {
    progress.error('Re-export refused');
    const names = adjacentCtx.refusals.map((r) => r.patchFilename).join(', ');
    throw new GeneralError(
      `Refused ${String(adjacentCtx.refusals.length)} patch(es) with adjacent unmanaged files ` +
        `(--refuse-adjacent-unmanaged): ${names}. Adopt reviewed files with --scan --scan-file, ` +
        `or export them as a new patch.`
    );
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
    await stampPatchVersions(
      paths.patches,
      reExportedFilenames,
      config.firefox.version,
      config.firefox.product
    );
  }

  if (isDryRun) {
    progress.stop('Dry run complete');
    success(`[dry-run] Would re-export ${reExported} of ${selectedPatches.length} patch(es)`);
    if (options.stamp === true) {
      info(
        `[dry-run] Would stamp sourceVersion=${config.firefox.version} (${config.firefox.product}) on ${reExported} patch(es)`
      );
    }
    outro('Dry run complete');
  } else {
    progress.stop('Re-export complete');
    success(`Re-exported ${reExported} of ${selectedPatches.length} patch(es)`);
    if (shouldStamp) {
      success(
        `Stamped sourceVersion=${config.firefox.version} (${config.firefox.product}) on ${reExportedFilenames.length} patch(es)`
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
  const reExport = program
    .command('re-export [patches...]')
    .description(
      'Refresh existing patch bodies (and filesAffected with --scan) from the current engine ' +
        'state. Does NOT change sourceVersion/sourceProduct by default — use --stamp or run ' +
        'rebase for source metadata stamping.'
    )
    .option('-a, --all', 'Re-export all patches')
    .option('-s, --scan', 'Scan directories for new/removed files and update filesAffected')
    .option(
      '--scan-file <path>',
      'With --scan, add this explicit engine-relative file to one target patch without collecting adjacent files. Repeatable.',
      (value: string, prev: string[]) => [...prev, value],
      [] as string[]
    )
    .option(
      '--scan-files <manifest>',
      'With --scan, bulk-assign generated files from a JSON manifest: {"assignments":[{"patch":"002-name.patch","files":["path"]}]}. Selects patches from the manifest.'
    )
    .option(
      '--files <paths>',
      'Restrict the re-exported filesAffected to this comma-separated list (single target patch only)',
      (value: string) =>
        value
          .split(',')
          .map((v) => v.trim())
          .filter((v) => v.length > 0)
    )
    .option(
      '--refuse-adjacent-unmanaged',
      'Refuse a scan-less re-export (non-zero exit, patch not written) when unmanaged files exist adjacent to the patch ownership, instead of warning. Mutually exclusive with --scan and --files.'
    )
    .option('--dry-run', 'Show what would change without writing')
    .option('--skip-lint', 'Skip patch lint checks (downgrade errors to warnings)')
    .option(
      '--allow-stale-furnace',
      'Export the deployed engine copy even when the components/ source changed since the last furnace apply'
    )
    .option(
      '--allow-shrink',
      'Allow --files to remove paths currently owned by the patch. Required before --yes can bypass the shrink confirmation.'
    )
    .option('-y, --yes', 'Skip confirmation prompts (required for non-TTY destructive writes)')
    .option('--force-unsafe', 'Bypass cross-patch lint refusal when --files shrinks a patch')
    .option(
      '--stamp',
      "After every selected patch refreshes cleanly, stamp each re-exported patch's sourceVersion/sourceProduct in patches.json to firefox.version/firefox.product from fireforge.json. No effect on a partial run."
    )
    .addOption(
      new Option(
        '--tier <tier>',
        'Force a tier override on the selected patch (only "branding" recognised). Mutually exclusive with --all.'
      ).choices(['branding'])
    )
    .option(
      '--lint-ignore <check-id>',
      'Append a lint check ID to the patch\'s PatchMetadata.lintIgnore (union, de-duped, repeatable). Mutually exclusive with --all. Use "fireforge patch lint-ignore" for --remove / --clear.',
      (value: string, prev: string[]) => [...prev, value],
      [] as string[]
    );
  addWaitLockOption(reExport).action(
    withErrorHandling(
      async (
        patches: string[],
        options: {
          all?: boolean;
          scan?: boolean;
          scanFile?: string[];
          scanFiles?: string;
          files?: string[];
          refuseAdjacentUnmanaged?: boolean;
          dryRun?: boolean;
          skipLint?: boolean;
          yes?: boolean;
          allowShrink?: boolean;
          allowStaleFurnace?: boolean;
          forceUnsafe?: boolean;
          stamp?: boolean;
          tier?: string;
          lintIgnore?: string[];
          waitLock?: number | boolean;
        }
      ) => {
        const { tier, lintIgnore, scanFile, scanFiles, ...rest } = options;
        const projectRoot = getProjectRoot();
        await withEngineSessionLock(
          projectRoot,
          're-export',
          () =>
            reExportCommand(projectRoot, patches, {
              ...pickDefined(rest),
              ...(scanFile !== undefined && scanFile.length > 0 ? { scanFiles: scanFile } : {}),
              ...(scanFiles !== undefined ? { scanFilesManifest: scanFiles } : {}),
              ...(tier !== undefined ? { tier: tier as 'branding' } : {}),
              ...(lintIgnore !== undefined && lintIgnore.length > 0 ? { lintIgnore } : {}),
            }),
          { waitLockSeconds: resolveWaitLockSeconds(options.waitLock) }
        );
      }
    )
  );
}
