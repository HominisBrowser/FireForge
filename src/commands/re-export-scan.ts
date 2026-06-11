// SPDX-License-Identifier: EUPL-1.2
import { dirname, join } from 'node:path';

import { confirm } from '@clack/prompts';

import { getModifiedFilesInDir, getUntrackedFilesInDir } from '../core/git-status.js';
import { extractAffectedFiles } from '../core/patch-apply.js';
import { getClaimedFiles } from '../core/patch-manifest.js';
import { GeneralError, InvalidArgumentError } from '../errors/base.js';
import type { PatchesManifest } from '../types/commands/index.js';
import { pathExists } from '../utils/fs.js';
import { cancel, info, isCancel, warn } from '../utils/logger.js';
import {
  isContainedRelativePath,
  normalizePathSlashes,
  stripEnginePrefix,
} from '../utils/paths.js';

const SCAN_ADD_COUNT_THRESHOLD = 3;
const SCAN_DIR_COUNT_THRESHOLD = 2;

export interface ScanResult {
  updated: string[];
  added: string[];
  removed: string[];
}

/** Normalizes repeatable `--scan-file` inputs into safe engine-relative paths. */
export function normalizeScanFiles(scanFiles: readonly string[] | undefined): string[] | undefined {
  const normalized = [...new Set(scanFiles ?? [])]
    .map((file) => normalizeEngineRelativeInput(file, '--scan-file'))
    .sort();
  return normalized.length > 0 ? normalized : undefined;
}

/** Normalizes one CLI-provided path into a safe engine-relative path. */
export function normalizeEngineRelativeInput(rawPath: string, flagName: string): string {
  const normalized = normalizePathSlashes(stripEnginePrefix(rawPath).trim());
  if (normalized.length === 0) {
    throw new InvalidArgumentError(
      `${flagName} requires a non-empty engine-relative path.`,
      flagName
    );
  }
  if (!isContainedRelativePath(normalized)) {
    throw new InvalidArgumentError(
      `${flagName} path must stay within engine/: ${rawPath}`,
      flagName
    );
  }
  return normalized;
}

/** Scans either broad sibling directories or explicit `--scan-file` paths for re-export. */
export async function scanPatchFilesForReExport(args: {
  currentFilesAffected: string[];
  engineDir: string;
  manifest: PatchesManifest;
  patchFilename: string;
  isDryRun: boolean;
  scanFiles?: readonly string[];
}): Promise<ScanResult> {
  const { scanFiles } = args;
  if (scanFiles !== undefined) {
    return scanPatchFilesTargeted({ ...args, scanFiles });
  }
  return scanPatchFiles(args);
}

async function scanPatchFiles(args: {
  currentFilesAffected: string[];
  engineDir: string;
  manifest: PatchesManifest;
  patchFilename: string;
  isDryRun: boolean;
}): Promise<ScanResult> {
  const { currentFilesAffected, engineDir, manifest, patchFilename, isDryRun } = args;
  const parentDirs = [...new Set(currentFilesAffected.map((f) => dirname(f)))];
  const claimedByOthers = getClaimedFiles(manifest, patchFilename);

  const discoveredFiles = new Set<string>();
  for (const dir of parentDirs) {
    const modifiedFiles = await getModifiedFilesInDir(engineDir, dir);
    const untrackedFiles = await getUntrackedFilesInDir(engineDir, dir);
    for (const f of [...modifiedFiles, ...untrackedFiles]) discoveredFiles.add(f);
  }

  // Git pathspecs recurse, so a claimed file in a shallow directory would
  // sweep entire subtrees into the candidate set — with several patches
  // sharing a parent directory, every unmanaged file in the tree gets
  // offered to whichever patch is scanned first. Constrain the broad scan
  // to the patch's exact directory footprint; deeper paths need an
  // explicit --scan-file / --scan-files assignment.
  const parentDirSet = new Set(parentDirs);
  const currentSet = new Set(currentFilesAffected);
  const added = [...discoveredFiles]
    .filter((f) => parentDirSet.has(dirname(f)) && !currentSet.has(f) && !claimedByOthers.has(f))
    .sort();
  const removed = await findRemovedFiles(currentFilesAffected, engineDir);
  return reportScanResult(currentFilesAffected, patchFilename, isDryRun, added, removed);
}

async function scanPatchFilesTargeted(args: {
  currentFilesAffected: string[];
  engineDir: string;
  manifest: PatchesManifest;
  patchFilename: string;
  isDryRun: boolean;
  scanFiles: readonly string[];
}): Promise<ScanResult> {
  const { currentFilesAffected, engineDir, manifest, patchFilename, isDryRun, scanFiles } = args;
  const currentSet = new Set(currentFilesAffected);
  const claimedByOthers = getClaimedFiles(manifest, patchFilename);
  const added: string[] = [];

  for (const file of scanFiles) {
    if (claimedByOthers.has(file)) {
      throw new InvalidArgumentError(
        `--scan-file path is already claimed by another patch: ${file}`,
        '--scan-file'
      );
    }
    if (!(await pathExists(join(engineDir, file)))) {
      throw new InvalidArgumentError(
        `--scan-file path not found in engine/: ${file}`,
        '--scan-file'
      );
    }
    if (!currentSet.has(file)) added.push(file);
  }

  const removed = await findRemovedFiles(currentFilesAffected, engineDir);
  return reportScanResult(currentFilesAffected, patchFilename, isDryRun, added.sort(), removed);
}

async function findRemovedFiles(files: readonly string[], engineDir: string): Promise<string[]> {
  const removed: string[] = [];
  for (const file of files) {
    if (!(await pathExists(join(engineDir, file)))) removed.push(file);
  }
  return removed.sort();
}

function reportScanResult(
  currentFilesAffected: string[],
  patchFilename: string,
  isDryRun: boolean,
  added: string[],
  removed: string[]
): ScanResult {
  for (const f of added) info(`  + ${f}`);
  for (const f of removed) info(`  - ${f}`);

  if (added.length === 0 && removed.length === 0) {
    return { updated: currentFilesAffected, added: [], removed: [] };
  }

  const removedSet = new Set(removed);
  const updated = [...currentFilesAffected.filter((f) => !removedSet.has(f)), ...added].sort();
  info(
    `  ${isDryRun ? 'Would update' : 'Updated'} ${patchFilename}: +${added.length} / -${removed.length} files`
  );
  return { updated, added, removed };
}

/**
 * Confirms broad directory-scan additions before a mutating re-export writes
 * them into patch ownership.
 */
export async function confirmBroadScanAdditions(args: {
  patchFilename: string;
  added: readonly string[];
  isDryRun: boolean;
  yes: boolean;
  isInteractive: boolean;
}): Promise<boolean> {
  const { patchFilename, added, isDryRun, yes, isInteractive } = args;
  if (isDryRun || yes || !scanAdditionsNeedConfirmation(added)) return true;

  const dirCount = new Set(added.map((f) => dirname(f))).size;
  warn(
    `${patchFilename}: --scan would add ${String(added.length)} file(s) that span ${String(dirCount)} director${dirCount === 1 ? 'y' : 'ies'}. ` +
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

function scanAdditionsNeedConfirmation(added: readonly string[]): boolean {
  if (added.length === 0) return false;
  if (added.length > SCAN_ADD_COUNT_THRESHOLD) return true;
  return new Set(added.map((f) => dirname(f))).size >= SCAN_DIR_COUNT_THRESHOLD;
}

/** Refuses explicit `--scan-file` additions that did not produce patch hunks. */
export function assertScanFileAdditionsHaveDiffHunks(args: {
  diffContent: string;
  patchFilename: string;
  previousFilesAffected: readonly string[];
  scanFiles: readonly string[] | undefined;
}): void {
  const { diffContent, patchFilename, previousFilesAffected, scanFiles } = args;
  if (scanFiles === undefined) return;

  const previous = new Set(previousFilesAffected);
  const diffFiles = new Set(extractAffectedFiles(diffContent));
  const noDiffScanFiles = scanFiles.filter((file) => !previous.has(file) && !diffFiles.has(file));
  if (noDiffScanFiles.length === 0) return;

  throw new InvalidArgumentError(
    `Refusing to re-export ${patchFilename} with --scan-file because ${noDiffScanFiles.length} explicit added path${noDiffScanFiles.length === 1 ? '' : 's'} produced no diff hunks (${noDiffScanFiles.join(', ')}). Remove unchanged paths or modify them before retrying.`,
    '--scan-file'
  );
}
