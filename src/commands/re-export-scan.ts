// SPDX-License-Identifier: EUPL-1.2
import { dirname, join } from 'node:path';

import { confirm } from '@clack/prompts';

import { getDiffForFilesAgainstHead } from '../core/git-diff.js';
import { listTrackedInHead } from '../core/git-file-ops.js';
import { getModifiedFilesInDir, getUntrackedFilesInDir } from '../core/git-status.js';
import { extractAffectedFiles } from '../core/patch-apply.js';
import {
  buildModifiedFileAdditionsFromDiff,
  buildPatchQueueContext,
  detectNewFilesInDiff,
  lintPatchQueue,
} from '../core/patch-lint.js';
import { computeProjectedLintRegressions } from '../core/patch-lint-projection.js';
import { getClaimedFiles } from '../core/patch-manifest.js';
import { extractNewFileContentFromDiff } from '../core/patch-transform.js';
import { GeneralError, InvalidArgumentError } from '../errors/base.js';
import type { PatchesManifest } from '../types/commands/index.js';
import { mapWithConcurrency } from '../utils/concurrency.js';
import { pathExists } from '../utils/fs.js';
import { cancel, info, isCancel, warn } from '../utils/logger.js';
import {
  isContainedRelativePath,
  normalizePathSlashes,
  stripEnginePrefix,
} from '../utils/paths.js';

const SCAN_ADD_COUNT_THRESHOLD = 3;

/** Concurrency bound for existence probes (matches the classify/lint pools). */
const PATH_PROBE_CONCURRENCY = 8;
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

  // Phase-split for bounded concurrency: the sync claimed-by-others check
  // first (first offender in argument order, as before), then pooled
  // existence probes with the refusal chosen by ordered iteration so the
  // FIRST missing file in argument order is named deterministically.
  for (const file of scanFiles) {
    if (claimedByOthers.has(file)) {
      throw new InvalidArgumentError(
        `--scan-file path is already claimed by another patch: ${file}`,
        '--scan-file'
      );
    }
  }
  const exists = await mapWithConcurrency(scanFiles, PATH_PROBE_CONCURRENCY, (file) =>
    pathExists(join(engineDir, file))
  );
  for (const [index, file] of scanFiles.entries()) {
    if (exists[index] !== true) {
      throw new InvalidArgumentError(
        `--scan-file path not found in engine/: ${file}. ` +
          '--scan-file brings a path INTO patch ownership, which needs content to diff. ' +
          'If the path was deleted and the patch already owns it, a plain re-export now ' +
          'captures the deletion — no scan flag is needed.',
        '--scan-file'
      );
    }
    if (!currentSet.has(file)) added.push(file);
  }

  const removed = await findRemovedFiles(currentFilesAffected, engineDir);
  return reportScanResult(currentFilesAffected, patchFilename, isDryRun, added.sort(), removed);
}

/**
 * Paths that have genuinely left the patch's ownership: absent from disk AND
 * untracked in engine HEAD.
 *
 * An absent path that IS tracked in HEAD is a DELETION, not a de-ownership.
 * The diff carries it as a `deleted file mode` section, so it must stay in
 * `filesAffected` — pruning it desynchronises the manifest from the patch
 * body in the direction that hurts: the body says "delete this file", the
 * file list says the patch has nothing to do with it.
 */
async function findRemovedFiles(files: readonly string[], engineDir: string): Promise<string[]> {
  const exists = await mapWithConcurrency(files, PATH_PROBE_CONCURRENCY, (file) =>
    pathExists(join(engineDir, file))
  );
  const absent = files.filter((_, index) => exists[index] !== true);
  const trackedAbsent = await listTrackedInHead(engineDir, absent);
  return absent.filter((file) => !trackedAbsent.has(file)).sort();
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

/**
 * Refuses scan adoptions whose candidate files import modules created by
 * LATER patches. Modeled on the `re-export --files` cross-patch
 * projection: the candidates' diffs are projected into the adopting
 * patch's queue entry, the queue lint runs baseline vs projection, and
 * only forward-import regressions attributable to the candidates block.
 * Staged-dependency declarations and inline lint-ignore markers are
 * honored automatically because the real lint rule evaluates them.
 * Covers broad `--scan`, `--scan-file`, and the `--scan-files` bulk flow
 * (all adopt through the same scan result), including dry-run.
 */
export async function assertScanAdoptionsHaveNoForwardImports(args: {
  patchesDir: string;
  engineDir: string;
  patchFilename: string;
  added: readonly string[];
}): Promise<void> {
  const { patchesDir, engineDir, patchFilename, added } = args;
  if (added.length === 0) return;

  const candidateDiff = await getDiffForFilesAgainstHead(engineDir, [...added]);
  if (!candidateDiff.trim()) return;

  const candidateNewFiles = new Map<string, string>();
  for (const path of detectNewFilesInDiff(candidateDiff)) {
    candidateNewFiles.set(path, extractNewFileContentFromDiff(candidateDiff, path));
  }
  const candidateAdditions = buildModifiedFileAdditionsFromDiff(candidateDiff);

  const baseCtx = await buildPatchQueueContext(patchesDir);
  const projectedEntries = baseCtx.entries.map((entry) => {
    if (entry.filename !== patchFilename) return entry;
    return {
      ...entry,
      diff: `${entry.diff}\n${candidateDiff}`,
      newFiles: new Map([...entry.newFiles, ...candidateNewFiles]),
      modifiedFileAdditions: new Map([...entry.modifiedFileAdditions, ...candidateAdditions]),
    };
  });

  const baselineIssues = lintPatchQueue(baseCtx).filter((i) => i.severity === 'error');
  const projectedIssues = lintPatchQueue({ entries: projectedEntries }).filter(
    (i) => i.severity === 'error'
  );
  const addedSet = new Set(added);
  const offending = computeProjectedLintRegressions(baselineIssues, projectedIssues).filter(
    (issue) => issue.check === 'forward-import' && addedSet.has(issue.file)
  );
  if (offending.length === 0) return;

  const details = offending.map((issue) => `  - ${issue.file}: ${issue.message}`).join('\n');
  throw new GeneralError(
    `Refusing to adopt ${offending.length} scanned file${offending.length === 1 ? '' : 's'} into ${patchFilename} ` +
      `because they import modules created by later patches:\n${details}\n` +
      'Export those files as their own later patch ("fireforge export --order <n>" / ' +
      '"fireforge patch split --order <n>") or declare the intentional dependency with ' +
      '"fireforge patch staged-dependency --add" before re-running the scan.'
  );
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
