// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { Command } from 'commander';

import { isBrandingManagedPath } from '../core/branding.js';
import { getProjectPaths, loadConfig } from '../core/config.js';
import { getStatusWithCodes, isGitRepository } from '../core/git.js';
import { getUntrackedFilesInDir } from '../core/git-status.js';
import { isFileRegistered, matchesRegistrablePattern } from '../core/manifest-rules.js';
import { computePatchedContent } from '../core/patch-apply.js';
import { loadPatchesManifest } from '../core/patch-manifest.js';
import { GeneralError } from '../errors/base.js';
import type { CommandContext } from '../types/cli.js';
import type { StatusOptions } from '../types/commands/index.js';
import { toError } from '../utils/errors.js';
import { pathExists, readText } from '../utils/fs.js';
import { info, intro, outro, verbose, warn } from '../utils/logger.js';

/**
 * Status code descriptions for git status.
 */
const STATUS_DESCRIPTIONS: Record<string, string> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  U: 'unmerged',
  '?': 'untracked',
  '!': 'ignored',
};

/**
 * Gets a human-readable description for a git status code.
 */
function getStatusDescription(code: string): string {
  return STATUS_DESCRIPTIONS[code] ?? 'changed';
}

interface StatusFile {
  status: string;
  file: string;
}

/**
 * Classification buckets for engine file changes:
 * - `patch-backed`: content matches the expected post-patch state — normal after `fireforge import`.
 * - `unmanaged`: edits not explained by any patch or tool — local drift to export or discard.
 * - `branding`: files under tool-managed branding paths, written by FireForge's branding pipeline.
 *
 * Empty buckets are omitted from output. A file touched by a patch that also
 * has additional local edits lands in `unmanaged` because its content diverges
 * from the expected patch result.
 */
type FileClassification = 'patch-backed' | 'unmanaged' | 'branding';

interface ClassifiedFile extends StatusFile {
  classification: FileClassification;
}

function getPrimaryStatusCode(status: string): string {
  if (status.includes('?')) return '?';
  if (status.includes('!')) return '!';

  for (const code of status) {
    if (code !== ' ') {
      return code;
    }
  }

  return status;
}

function isNewFileStatus(status: string): boolean {
  const code = getPrimaryStatusCode(status);
  return code === '?' || code === 'A';
}

function groupFilesByStatus(files: StatusFile[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();

  for (const { status, file } of files) {
    const code = getPrimaryStatusCode(status);
    const existing = grouped.get(code) ?? [];
    existing.push(file);
    grouped.set(code, existing);
  }

  return grouped;
}

function printStatusGroups(files: StatusFile[]): void {
  const grouped = groupFilesByStatus(files);

  for (const [status, fileList] of grouped) {
    const description = getStatusDescription(status);
    warn(`${description}:`);
    for (const file of fileList) {
      info(`  ${file}`);
    }
  }
}

async function printUnregisteredWarnings(
  files: StatusFile[],
  projectRoot: string,
  binaryName: string
): Promise<void> {
  const newFiles = files.filter((f) => isNewFileStatus(f.status));
  if (newFiles.length === 0) return;

  const registrableFiles = newFiles.filter((f) => matchesRegistrablePattern(f.file, binaryName));
  const registrationChecks = await Promise.all(
    registrableFiles.map(async (f) => ({
      file: f.file,
      registered: await isFileRegistered(projectRoot, f.file),
    }))
  );
  const unregistered = registrationChecks.filter((f) => !f.registered);

  if (unregistered.length > 0) {
    info('');
    warn('Potentially unregistered files:');
    for (const f of unregistered) {
      info(`  ${f.file} — run 'fireforge register ${f.file}'`);
    }
  }
}

/**
 * Renders raw worktree status as machine-parseable porcelain-style output.
 * Each line is: STATUS<tab>FILE
 */
function renderRawStatus(files: StatusFile[]): void {
  for (const { status, file } of files) {
    process.stdout.write(`${status.trim()}\t${file}\n`);
  }
}

/**
 * Expands collapsed untracked directory entries into individual file entries.
 * Git status may report an entire untracked directory as a single entry (e.g. "?? dir/").
 * This function expands those into individual file entries so each file can be classified.
 */
async function expandDirectoryEntries(
  files: StatusFile[],
  engineDir: string
): Promise<StatusFile[]> {
  const expanded: StatusFile[] = [];
  for (const entry of files) {
    if (entry.file.endsWith('/') && entry.status.includes('?')) {
      const individualFiles = await getUntrackedFilesInDir(engineDir, entry.file);
      for (const f of individualFiles) {
        expanded.push({ status: '??', file: f });
      }
    } else {
      expanded.push(entry);
    }
  }
  return expanded;
}

/**
 * Classifies files into patch-backed, unmanaged, or branding buckets.
 */
async function classifyFiles(
  files: StatusFile[],
  engineDir: string,
  patchesDir: string,
  binaryName: string
): Promise<ClassifiedFile[]> {
  const manifest = await loadPatchesManifest(patchesDir);

  // Build set of all patch-claimed file paths
  const patchClaimedFiles = new Set<string>();
  if (manifest) {
    for (const patch of manifest.patches) {
      for (const f of patch.filesAffected) {
        patchClaimedFiles.add(f);
      }
    }
  }

  const results: ClassifiedFile[] = [];

  for (const entry of files) {
    // Branding check first
    if (isBrandingManagedPath(entry.file, binaryName)) {
      results.push({ ...entry, classification: 'branding' });
      continue;
    }

    // Not in any patch → unmanaged
    if (!patchClaimedFiles.has(entry.file)) {
      results.push({ ...entry, classification: 'unmanaged' });
      continue;
    }

    // File is claimed by a patch — compare content
    const primaryCode = getPrimaryStatusCode(entry.status);

    if (primaryCode === 'D') {
      // Deleted file: patch-backed only if patch expects deletion
      const expected = await computePatchedContent(patchesDir, engineDir, entry.file);
      results.push({
        ...entry,
        classification: expected === null ? 'patch-backed' : 'unmanaged',
      });
      continue;
    }

    // File exists on disk — compare actual vs expected
    try {
      const [expected, actual] = await Promise.all([
        computePatchedContent(patchesDir, engineDir, entry.file),
        readText(join(engineDir, entry.file)),
      ]);

      results.push({
        ...entry,
        classification: actual === expected ? 'patch-backed' : 'unmanaged',
      });
    } catch (error: unknown) {
      verbose(
        `Treating ${entry.file} as unmanaged because patch-backed classification failed: ${toError(error).message}`
      );
      // If we can't read the file, treat as unmanaged
      results.push({ ...entry, classification: 'unmanaged' });
    }
  }

  return results;
}

/**
 * Runs the status command to show modified files.
 * @param projectRoot - Root directory of the project
 * @param options - Status display options
 */
export async function statusCommand(
  projectRoot: string,
  options: StatusOptions = {}
): Promise<void> {
  if (options.raw && options.unmanaged) {
    throw new GeneralError('Cannot use --raw and --unmanaged together.');
  }

  if (!options.raw) {
    intro('FireForge Status');
  }

  const paths = getProjectPaths(projectRoot);
  const config = await loadConfig(projectRoot);

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

  const rawFiles = await getStatusWithCodes(paths.engine);
  const files = await expandDirectoryEntries(rawFiles, paths.engine);

  if (files.length === 0) {
    info('No modified files');
    outro('Working tree clean');
    return;
  }

  // Raw mode: existing behavior
  if (options.raw) {
    renderRawStatus(files);
    return;
  }

  // Patch-aware classification
  const classified = await classifyFiles(files, paths.engine, paths.patches, config.binaryName);

  const unmanagedFiles = classified.filter((f) => f.classification === 'unmanaged');
  const patchBackedFiles = classified.filter((f) => f.classification === 'patch-backed');
  const brandingFiles = classified.filter((f) => f.classification === 'branding');

  // --unmanaged mode: only show unmanaged
  if (options.unmanaged) {
    info(
      `${unmanagedFiles.length} unmanaged file${unmanagedFiles.length === 1 ? '' : 's'} (${files.length} total modified):\n`
    );
    if (unmanagedFiles.length > 0) {
      printStatusGroups(unmanagedFiles);
      await printUnregisteredWarnings(unmanagedFiles, projectRoot, config.binaryName);
    } else {
      info('No unmanaged changes');
    }
    outro(
      unmanagedFiles.length === 0
        ? 'No unmanaged changes'
        : `${unmanagedFiles.length} unmanaged change${unmanagedFiles.length === 1 ? '' : 's'}`
    );
    return;
  }

  // Default mode: three-bucket display
  info(`${files.length} modified file${files.length === 1 ? '' : 's'}:\n`);

  if (unmanagedFiles.length > 0) {
    warn('Unmanaged changes:');
    printStatusGroups(unmanagedFiles);
    await printUnregisteredWarnings(unmanagedFiles, projectRoot, config.binaryName);
  }

  if (patchBackedFiles.length > 0) {
    if (unmanagedFiles.length > 0) info('');
    warn('Patch-backed materialized changes:');
    printStatusGroups(patchBackedFiles);
  }

  if (brandingFiles.length > 0) {
    if (unmanagedFiles.length > 0 || patchBackedFiles.length > 0) info('');
    warn('Tool-managed branding changes:');
    printStatusGroups(brandingFiles);
  }

  if (unmanagedFiles.length === 0 && patchBackedFiles.length === 0 && brandingFiles.length === 0) {
    info('No changes');
  }

  const parts: string[] = [];
  if (unmanagedFiles.length > 0) parts.push(`${unmanagedFiles.length} unmanaged`);
  if (patchBackedFiles.length > 0) parts.push(`${patchBackedFiles.length} patch-backed`);
  if (brandingFiles.length > 0) parts.push(`${brandingFiles.length} branding`);
  outro(parts.join(', '));
}

/** Registers the status command on the CLI program. */
export function registerStatus(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  program
    .command('status')
    .description('Show modified files in engine/')
    .option('--raw', 'Show raw worktree status without patch classification')
    .option('--unmanaged', 'Show only unmanaged changes (not covered by patches or tools)')
    .action(
      withErrorHandling(async (options: { raw?: boolean; unmanaged?: boolean }) => {
        await statusCommand(getProjectRoot(), options);
      })
    );
}
