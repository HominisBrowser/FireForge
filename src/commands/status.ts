// SPDX-License-Identifier: EUPL-1.2
import { Command } from 'commander';

import { getProjectPaths, loadConfig } from '../core/config.js';
import { collectFurnaceManagedPrefixes } from '../core/furnace-config.js';
import { getHead, getStatusWithCodes, isGitRepository, isMissingHeadError } from '../core/git.js';
import { getUntrackedFilesInDir } from '../core/git-status.js';
import { isFileRegistered, matchesRegistrablePattern } from '../core/manifest-rules.js';
import { buildOwnershipTable, renderOwnershipTable } from '../core/ownership-table.js';
import { buildPatchQueueContext, collectNewFileCreatorsByPath } from '../core/patch-lint.js';
import { loadPatchesManifest } from '../core/patch-manifest.js';
import {
  type ClassifiedFile,
  classifyFiles,
  type FileClassification,
  type StatusFile,
} from '../core/status-classify.js';
import { GeneralError } from '../errors/base.js';
import type { CommandContext } from '../types/cli.js';
import type { StatusOptions } from '../types/commands/index.js';
import { FIREFORGE_TMP_PATH_PATTERN, pathExists } from '../utils/fs.js';
import { info, intro, outro, warn } from '../utils/logger.js';

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
  // `isFileRegistered` throws `GeneralError("Manifest not found: ...")` when a
  // rule sees a file whose parent manifest does not yet exist on disk — e.g.
  // a brand-new `browser/modules/<binary>/` directory with no `moz.build`.
  // `status` is a read-only reporter; before 0.18.1 the rejected promise
  // bubbled through `Promise.all` and exited status with code 1, breaking the
  // "use status --unmanaged to discover new files before running register"
  // workflow. We now bucket missing-manifest cases into a distinct warning
  // list while still surfacing the same actionable signal. Other error
  // shapes continue to propagate (permission denied, corrupt file, etc.) so
  // we do not silently hide anything surprising.
  const registrationChecks = await Promise.all(
    registrableFiles.map(async (f) => {
      try {
        return {
          file: f.file,
          registered: await isFileRegistered(projectRoot, f.file),
          manifestMissing: false as const,
          manifestMissingMessage: undefined as string | undefined,
        };
      } catch (err: unknown) {
        if (err instanceof GeneralError && /^Manifest not found:/i.test(err.message)) {
          return {
            file: f.file,
            registered: false,
            manifestMissing: true as const,
            manifestMissingMessage: err.message,
          };
        }
        throw err;
      }
    })
  );
  const unregistered = registrationChecks.filter((f) => !f.registered && !f.manifestMissing);
  const manifestMissing = registrationChecks.filter((f) => f.manifestMissing);

  if (unregistered.length > 0) {
    info('');
    warn('Potentially unregistered files:');
    for (const f of unregistered) {
      info(`  ${f.file} — run 'fireforge register ${f.file}'`);
    }
  }

  if (manifestMissing.length > 0) {
    info('');
    warn('Files whose registration manifest does not exist yet:');
    for (const f of manifestMissing) {
      // `manifestMissingMessage` is always the specific
      // "Manifest not found: <path>" string when manifestMissing is
      // true (see the catch branch above that sets them together).
      info(`  ${f.file} — ${f.manifestMissingMessage}`);
      info(`    Create the parent manifest, then run 'fireforge register ${f.file}'.`);
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
  const output = classified.map((f) => {
    const entry: {
      file: string;
      status: string;
      classification: FileClassification;
      claimedBy?: string[];
    } = {
      file: f.file,
      status: f.status.trim(),
      classification: f.classification,
    };
    // `claimedBy` is an optional field present only on conflict
    // entries, so non-conflict output stays byte-identical to the
    // pre-0.16.0 shape (no unconditional schema change for the
    // 99% of entries that are not cross-patch conflicts).
    if (f.classification === 'conflict' && f.claimedBy && f.claimedBy.length > 0) {
      entry.claimedBy = [...f.claimedBy];
    }
    return entry;
  });
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

/**
 * Detects the "unborn HEAD" aftermath of an interrupted `fireforge download`
 * — git init succeeded but the initial Firefox source commit was never
 * created, so every file in engine/ reads as untracked. On a ~600 MB
 * Firefox tree this would flood the output with hundreds of thousands of
 * entries and a truncation warning, which is technically correct but not
 * actionable. Throws a `GeneralError` with a single recovery banner
 * pointing at `fireforge download --force`. `raw` / `json` modes skip the
 * banner so their consumers see the structural failure in error form
 * only.
 */
async function assertEngineHasBaselineCommit(
  engineDir: string,
  options: StatusOptions
): Promise<void> {
  try {
    await getHead(engineDir);
  } catch (err: unknown) {
    if (!isMissingHeadError(err)) throw err;
    const guidance =
      'Engine repository has no baseline commit yet — a previous "fireforge download" was interrupted before git created the initial Firefox source commit. Re-run "fireforge download --force" to recreate the baseline repository cleanly.';
    if (!options.raw && !options.json) {
      warn(guidance);
      outro('Engine baseline missing — re-run download --force');
    }
    throw new GeneralError(guidance);
  }
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

  await assertEngineHasBaselineCommit(paths.engine, options);

  const rawFiles = await getStatusWithCodes(paths.engine);
  const { entries: expanded, truncations } = await expandDirectoryEntries(rawFiles, paths.engine);
  // Strip atomic-write temp files (Finding #18) before every mode
  // branch so raw / unmanaged / default / json all agree.
  const files = filterFireForgeTempFiles(expanded);
  renderTruncationBanner(truncations);

  // `--json` callers expect machine-parseable output on every invocation,
  // including the clean-tree case. Before this ordering fix a clean tree
  // printed "No modified files" / "Working tree clean" via the human
  // branch below and `--json` was silently ignored, so scripts that piped
  // the output through a JSON parser broke precisely when there was
  // nothing to report. Emit `[]` here and return before the human fallback.
  if (options.json) {
    await renderJsonStatus(files, paths, projectRoot, config.binaryName);
    return;
  }

  // `--raw` consumers parse the native `git status --porcelain` output
  // directly. On a clean tree the raw mode should produce nothing on
  // stdout — the human "Working tree clean" banner would contaminate the
  // pipe. Short-circuit before the human clean-tree branch below.
  if (options.raw && files.length === 0) {
    return;
  }

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
  const furnacePrefixes = await collectFurnaceManagedPrefixes(projectRoot);
  const classified = await classifyFiles(
    files,
    paths.engine,
    paths.patches,
    config.binaryName,
    furnacePrefixes
  );

  const buckets: ClassifiedBuckets = {
    conflict: classified.filter((f) => f.classification === 'conflict'),
    unmanaged: classified.filter((f) => f.classification === 'unmanaged'),
    patchBacked: classified.filter((f) => f.classification === 'patch-backed'),
    branding: classified.filter((f) => f.classification === 'branding'),
    furnace: classified.filter((f) => f.classification === 'furnace'),
  };

  // --unmanaged mode: only show unmanaged
  if (options.unmanaged) {
    await renderUnmanagedOnly(buckets.unmanaged, files.length, projectRoot, config.binaryName);
    return;
  }

  await renderDefaultStatus(files.length, buckets, projectRoot, config.binaryName);
}

interface ClassifiedBuckets {
  conflict: ClassifiedFile[];
  unmanaged: ClassifiedFile[];
  patchBacked: ClassifiedFile[];
  branding: ClassifiedFile[];
  furnace: ClassifiedFile[];
}

async function renderUnmanagedOnly(
  unmanagedFiles: ClassifiedFile[],
  totalModified: number,
  projectRoot: string,
  binaryName: string
): Promise<void> {
  info(
    `${unmanagedFiles.length} unmanaged file${unmanagedFiles.length === 1 ? '' : 's'} (${totalModified} total modified):\n`
  );
  if (unmanagedFiles.length > 0) {
    printStatusGroups(unmanagedFiles);
    await printUnregisteredWarnings(unmanagedFiles, projectRoot, binaryName);
  } else {
    info('No unmanaged changes');
  }
  outro(
    unmanagedFiles.length === 0
      ? 'No unmanaged changes'
      : `${unmanagedFiles.length} unmanaged change${unmanagedFiles.length === 1 ? '' : 's'}`
  );
}

/**
 * Renders the default five-bucket status display: conflicts first
 * (they block export/import/rebase), then unmanaged, patch-backed,
 * branding, and furnace-managed sections. Cross-bucket separators
 * ensure the sections are visually distinct without trailing empty
 * groups. Empty buckets are omitted — the very-empty case surfaces a
 * single `No changes` line.
 */
async function renderDefaultStatus(
  totalModified: number,
  buckets: ClassifiedBuckets,
  projectRoot: string,
  binaryName: string
): Promise<void> {
  const { conflict, unmanaged, patchBacked, branding, furnace } = buckets;

  info(`${totalModified} modified file${totalModified === 1 ? '' : 's'}:\n`);

  if (conflict.length > 0) {
    // Surface cross-patch ownership conflicts at the top of the default
    // output — they block export/import/rebase and want immediate
    // attention. The `--ownership` view already renders the full table;
    // here we just name the files and point the operator at the
    // canonical recovery path.
    warn('Cross-patch ownership conflicts (same file claimed by multiple patches):');
    printStatusGroups(conflict);
    for (const entry of conflict) {
      if (entry.claimedBy && entry.claimedBy.length > 0) {
        info(`  ${entry.file} — claimed by ${entry.claimedBy.join(', ')}`);
      }
    }
    info(
      'Run "fireforge status --ownership" for the full conflict table, then repartition with "fireforge re-export --files <paths> <patch>".'
    );
  }

  if (unmanaged.length > 0) {
    if (conflict.length > 0) info('');
    warn('Unmanaged changes:');
    printStatusGroups(unmanaged);
    await printUnregisteredWarnings(unmanaged, projectRoot, binaryName);
  }

  if (patchBacked.length > 0) {
    if (conflict.length > 0 || unmanaged.length > 0) info('');
    warn('Patch-backed materialized changes:');
    printStatusGroups(patchBacked);
  }

  if (branding.length > 0) {
    if (conflict.length > 0 || unmanaged.length > 0 || patchBacked.length > 0) {
      info('');
    }
    warn('Tool-managed branding changes:');
    printStatusGroups(branding);
  }

  if (furnace.length > 0) {
    if (
      conflict.length > 0 ||
      unmanaged.length > 0 ||
      patchBacked.length > 0 ||
      branding.length > 0
    ) {
      info('');
    }
    warn('Furnace-managed component changes:');
    printStatusGroups(furnace);
  }

  if (
    conflict.length === 0 &&
    unmanaged.length === 0 &&
    patchBacked.length === 0 &&
    branding.length === 0 &&
    furnace.length === 0
  ) {
    info('No changes');
  }

  const parts: string[] = [];
  if (conflict.length > 0) parts.push(`${conflict.length} conflict`);
  if (unmanaged.length > 0) parts.push(`${unmanaged.length} unmanaged`);
  if (patchBacked.length > 0) parts.push(`${patchBacked.length} patch-backed`);
  if (branding.length > 0) parts.push(`${branding.length} branding`);
  if (furnace.length > 0) parts.push(`${furnace.length} furnace`);
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
