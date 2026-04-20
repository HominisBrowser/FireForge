// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { Command } from 'commander';

import { isBrandingManagedPath } from '../core/branding.js';
import { getProjectPaths, loadConfig } from '../core/config.js';
import { collectFurnaceManagedPrefixes } from '../core/furnace-config.js';
import { getStatusWithCodes, isGitRepository } from '../core/git.js';
import { getUntrackedFilesInDir } from '../core/git-status.js';
import { isFileRegistered, matchesRegistrablePattern } from '../core/manifest-rules.js';
import { buildOwnershipTable, renderOwnershipTable } from '../core/ownership-table.js';
import { computePatchedContent } from '../core/patch-apply.js';
import { buildPatchQueueContext, collectNewFileCreatorsByPath } from '../core/patch-lint.js';
import { loadPatchesManifest } from '../core/patch-manifest.js';
import { GeneralError } from '../errors/base.js';
import type { CommandContext } from '../types/cli.js';
import type { StatusOptions } from '../types/commands/index.js';
import { toError } from '../utils/errors.js';
import { FIREFORGE_TMP_PATH_PATTERN, pathExists, readText } from '../utils/fs.js';
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
type FileClassification = 'patch-backed' | 'unmanaged' | 'branding' | 'furnace';

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
 * Default maximum number of files we will materialise from a single
 * untracked directory. Pathological inputs (an accidental dump of build
 * output, a symlink that resolves into a huge unrelated tree, etc.)
 * should not be able to balloon `status` into multi-gigabyte memory or
 * hang the CLI. Going over this cap surfaces a warning so the user knows
 * the listing has been truncated, and it bounds the JSON / default
 * rendering paths.
 *
 * Override via the `FIREFORGE_MAX_UNTRACKED_FILES` environment variable
 * for monorepos or fixture-heavy projects with legitimately large
 * untracked directories.
 */
const DEFAULT_MAX_UNTRACKED_FILES_PER_DIR = 5000;

function resolveMaxUntrackedFilesPerDir(): number {
  const raw = process.env['FIREFORGE_MAX_UNTRACKED_FILES'];
  if (raw === undefined || raw.length === 0) return DEFAULT_MAX_UNTRACKED_FILES_PER_DIR;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    warn(
      `Ignoring FIREFORGE_MAX_UNTRACKED_FILES="${raw}" — expected a positive integer. Falling back to ${DEFAULT_MAX_UNTRACKED_FILES_PER_DIR}.`
    );
    return DEFAULT_MAX_UNTRACKED_FILES_PER_DIR;
  }
  return parsed;
}

const MAX_UNTRACKED_FILES_PER_DIR = resolveMaxUntrackedFilesPerDir();

/**
 * Expands collapsed untracked directory entries into individual file entries.
 * Git status may report an entire untracked directory as a single entry (e.g. "?? dir/").
 * This function expands those into individual file entries so each file can be classified.
 *
 * Per-directory expansion is capped at {@link MAX_UNTRACKED_FILES_PER_DIR}
 * entries; any overflow is dropped with a warning. Git ls-files itself
 * does not infinite-recurse on symlink loops, but a directory full of
 * generated artefacts can still produce an arbitrarily large list, and
 * truncating gives the user a recoverable signal instead of an OOM.
 */
interface TruncationRecord {
  dir: string;
  total: number;
  shown: number;
}

/**
 * Emits a prominent top-of-output warning when one or more untracked
 * directories were truncated during expansion. Individual per-dir warnings
 * already fired inside expandDirectoryEntries but are easily lost in
 * scrollback for large status outputs; this banner summarises the total
 * hidden count so the user doesn't miss that an export based on this
 * status would be incomplete.
 */
function renderTruncationBanner(truncations: TruncationRecord[]): void {
  if (truncations.length === 0) return;
  const hidden = truncations.reduce((sum, rec) => sum + (rec.total - rec.shown), 0);
  const dirList = truncations.map((r) => `${r.dir} (${r.total - r.shown} hidden)`).join(', ');
  warn(
    `⚠ Status output is truncated: ${hidden.toLocaleString()} untracked file(s) across ${truncations.length} director(y/ies) are not shown. ` +
      `Truncated: ${dirList}. ` +
      `Add a .gitignore entry or clean the directory before exporting, otherwise the export will omit these files.`
  );
}

async function expandDirectoryEntries(
  files: StatusFile[],
  engineDir: string
): Promise<{ entries: StatusFile[]; truncations: TruncationRecord[] }> {
  const expanded: StatusFile[] = [];
  const truncations: TruncationRecord[] = [];
  for (const entry of files) {
    if (entry.file.endsWith('/') && entry.status.includes('?')) {
      const individualFiles = await getUntrackedFilesInDir(engineDir, entry.file);
      if (individualFiles.length > MAX_UNTRACKED_FILES_PER_DIR) {
        warn(
          `Untracked directory ${entry.file} contains ${individualFiles.length} files — only the first ${MAX_UNTRACKED_FILES_PER_DIR} will be classified. Consider adding a .gitignore entry.`
        );
        truncations.push({
          dir: entry.file,
          total: individualFiles.length,
          shown: MAX_UNTRACKED_FILES_PER_DIR,
        });
      }
      const limited = individualFiles.slice(0, MAX_UNTRACKED_FILES_PER_DIR);
      for (const f of limited) {
        expanded.push({ status: '??', file: f });
      }
    } else {
      expanded.push(entry);
    }
  }
  return { entries: expanded, truncations };
}

/**
 * Strips entries whose path matches the atomic-temp-file shape
 * FireForge's own `writeText` produces (see
 * {@link import('../utils/fs.js').FIREFORGE_TMP_PATH_PATTERN}). Those
 * files only exist for the duration of a write + rename and should
 * never appear in `status` output; filtering them here keeps every
 * status mode (default, raw, unmanaged, ownership, json) symmetric so
 * the operator never sees a `.mozconfig.fireforge-tmp-<pid>-<uuid>`
 * entry mid-write. Files named for unrelated reasons (e.g. a user's
 * `.bashrc.fireforge-tmp-backup` without the PID+UUID tail) do not
 * match the pattern and pass through unfiltered.
 */
function filterFireForgeTempFiles(files: StatusFile[]): StatusFile[] {
  return files.filter((entry) => !FIREFORGE_TMP_PATH_PATTERN.test(entry.file));
}

/**
 * Classifies files into patch-backed, unmanaged, or branding buckets.
 */
async function classifyFiles(
  files: StatusFile[],
  engineDir: string,
  patchesDir: string,
  binaryName: string,
  furnacePrefixes: Set<string>
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

    // Furnace-managed component paths
    if (furnacePrefixes.size > 0) {
      let isFurnace = false;
      for (const prefix of furnacePrefixes) {
        if (entry.file.startsWith(prefix)) {
          isFurnace = true;
          break;
        }
      }
      if (isFurnace) {
        results.push({ ...entry, classification: 'furnace' });
        continue;
      }
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
 * Renders classified file status as machine-readable JSON to stdout.
 */
async function renderJsonStatus(
  files: StatusFile[],
  paths: ReturnType<typeof getProjectPaths>,
  projectRoot: string,
  binaryName: string
): Promise<void> {
  const furnacePrefixes = await collectFurnaceManagedPrefixes(projectRoot);
  const classified = await classifyFiles(
    files,
    paths.engine,
    paths.patches,
    binaryName,
    furnacePrefixes
  );
  const output = classified.map((f) => ({
    file: f.file,
    status: f.status.trim(),
    classification: f.classification,
  }));
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
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
  const modeCount = [options.raw, options.unmanaged, options.ownership, options.json].filter(
    (v) => v === true
  ).length;
  if (modeCount > 1) {
    throw new GeneralError(
      'Cannot use --raw, --unmanaged, --ownership, and --json together. Pick at most one.'
    );
  }

  if (!options.raw && !options.json) {
    intro('FireForge Status');
  }

  const paths = getProjectPaths(projectRoot);
  const config = await loadConfig(projectRoot);

  // Ownership mode is a flat file→patch table; sources are the manifest's
  // filesAffected, any worktree drift, and the cross-patch
  // duplicate-new-file-creation map produced by walking each patch
  // body. The latter is the alignment fix between `status --ownership`
  // and `fireforge verify` — see buildOwnershipTable's header comment.
  // Runs before the default classify path so we can short-circuit
  // without computing patch-backed state.
  if (options.ownership) {
    if (!(await pathExists(paths.engine))) {
      throw new GeneralError('Firefox source not found. Run "fireforge download" first.');
    }
    const manifest = await loadPatchesManifest(paths.patches);
    const ownershipExpansion = (await isGitRepository(paths.engine))
      ? await expandDirectoryEntries(await getStatusWithCodes(paths.engine), paths.engine)
      : { entries: [], truncations: [] };
    // Filter atomic-write temp files (Finding #18) so a mid-flight
    // `.fireforge-tmp-<pid>-<uuid>` artefact never shows up in any
    // status mode. The pattern is tight enough to let legitimately
    // similar names through.
    const rawFilesOwnership = filterFireForgeTempFiles(ownershipExpansion.entries);
    renderTruncationBanner(ownershipExpansion.truncations);

    // Only walk the patch bodies when the directory actually exists.
    // Fresh projects with no patch queue yet pass through with an empty
    // creators map, which degrades to the old filesAffected-only
    // behavior for the empty case.
    const newFileCreatorsByPath = (await pathExists(paths.patches))
      ? collectNewFileCreatorsByPath(await buildPatchQueueContext(paths.patches))
      : new Map<string, string[]>();

    const rows = buildOwnershipTable(
      manifest?.patches ?? [],
      rawFilesOwnership,
      newFileCreatorsByPath
    );
    renderOwnershipTable(rows);

    const conflictCount = rows.filter((r) => r.conflict).length;
    const unmanagedCount = rows.filter((r) => r.unmanaged).length;
    const managedCount = rows.filter((r) => !r.unmanaged).length;

    const parts: string[] = [`${managedCount} managed`];
    if (conflictCount > 0) parts.push(`${conflictCount} conflict${conflictCount === 1 ? '' : 's'}`);
    if (unmanagedCount > 0) parts.push(`${unmanagedCount} unmanaged`);
    outro(parts.join(', '));

    if (conflictCount > 0) {
      throw new GeneralError(
        `${conflictCount} path(s) are claimed by more than one patch. ` +
          'Run "fireforge verify" for full details, then use "re-export --files" or ' +
          '"patch delete" to resolve.'
      );
    }
    return;
  }

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
  const { entries: expanded, truncations } = await expandDirectoryEntries(rawFiles, paths.engine);
  // Strip atomic-write temp files (Finding #18) before every mode
  // branch so raw / unmanaged / default / json all agree.
  const files = filterFireForgeTempFiles(expanded);
  renderTruncationBanner(truncations);

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

  // JSON mode and default mode both need classification
  if (options.json) {
    await renderJsonStatus(files, paths, projectRoot, config.binaryName);
    return;
  }

  // Patch-aware classification
  const furnacePrefixes = await collectFurnaceManagedPrefixes(projectRoot);
  const classified = await classifyFiles(
    files,
    paths.engine,
    paths.patches,
    config.binaryName,
    furnacePrefixes
  );

  const unmanagedFiles = classified.filter((f) => f.classification === 'unmanaged');
  const patchBackedFiles = classified.filter((f) => f.classification === 'patch-backed');
  const brandingFiles = classified.filter((f) => f.classification === 'branding');
  const furnaceFiles = classified.filter((f) => f.classification === 'furnace');

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

  if (furnaceFiles.length > 0) {
    if (unmanagedFiles.length > 0 || patchBackedFiles.length > 0 || brandingFiles.length > 0)
      info('');
    warn('Furnace-managed component changes:');
    printStatusGroups(furnaceFiles);
  }

  if (
    unmanagedFiles.length === 0 &&
    patchBackedFiles.length === 0 &&
    brandingFiles.length === 0 &&
    furnaceFiles.length === 0
  ) {
    info('No changes');
  }

  const parts: string[] = [];
  if (unmanagedFiles.length > 0) parts.push(`${unmanagedFiles.length} unmanaged`);
  if (patchBackedFiles.length > 0) parts.push(`${patchBackedFiles.length} patch-backed`);
  if (brandingFiles.length > 0) parts.push(`${brandingFiles.length} branding`);
  if (furnaceFiles.length > 0) parts.push(`${furnaceFiles.length} furnace`);
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
    .option(
      '--ownership',
      'Show a flat path → owning patch table (flags files claimed by multiple patches)'
    )
    .option('--json', 'Output classified file status as JSON')
    .action(
      withErrorHandling(
        async (options: {
          raw?: boolean;
          unmanaged?: boolean;
          ownership?: boolean;
          json?: boolean;
        }) => {
          await statusCommand(getProjectRoot(), options);
        }
      )
    );
}
