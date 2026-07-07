// SPDX-License-Identifier: EUPL-1.2
import { Command } from 'commander';

import { getProjectPaths, loadConfig } from '../core/config.js';
import { collectFurnaceManagedPrefixes } from '../core/furnace-config.js';
import { getHead, getStatusWithCodes, isGitRepository, isMissingHeadError } from '../core/git.js';
import { getUntrackedFilesInDir, resolveMaxUntrackedFilesPerDir } from '../core/git-status.js';
import { buildOwnershipTable, renderOwnershipTable } from '../core/ownership-table.js';
import { buildPatchQueueContext, collectNewFileCreatorsByPath } from '../core/patch-lint.js';
import { loadPatchesManifest } from '../core/patch-manifest.js';
import {
  classifyFiles,
  type FileClassification,
  type StatusFile,
} from '../core/status-classify.js';
import { CommandError, GeneralError } from '../errors/base.js';
import { ExitCode } from '../errors/codes.js';
import type { CommandContext } from '../types/cli.js';
import type { StatusOptions } from '../types/commands/index.js';
import { FIREFORGE_TMP_PATH_PATTERN, pathExists } from '../utils/fs.js';
import {
  info,
  intro,
  isMachineOutputMode,
  outro,
  setMachineOutputMode,
  warn,
} from '../utils/logger.js';
import {
  type ClassifiedBuckets,
  renderDefaultStatus,
  renderUnmanagedOnly,
} from './status-output.js';

/**
 * Renders raw worktree status as machine-parseable porcelain-style output.
 * Each line is: STATUS<tab>FILE
 */
function renderRawStatus(files: StatusFile[]): void {
  for (const { status, file } of files) {
    process.stdout.write(`${status.trim()}\t${file}\n`);
  }
}

// Resolved lazily at first use (shared with core/git-status): this module
// is imported by the command manifest for EVERY command, so a
// module-load-time parse printed the status-specific env warning during
// `fireforge build` etc.
let maxUntrackedFilesPerDir: number | undefined;

function getMaxUntrackedFilesPerDir(): number {
  maxUntrackedFilesPerDir ??= resolveMaxUntrackedFilesPerDir();
  return maxUntrackedFilesPerDir;
}

/**
 * Expands collapsed untracked directory entries into individual file entries.
 * Git status may report an entire untracked directory as a single entry (e.g. "?? dir/").
 * This function expands those into individual file entries so each file can be classified.
 *
 * Per-directory expansion is capped at FIREFORGE_MAX_UNTRACKED_FILES (default 5000)
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
      const cap = getMaxUntrackedFilesPerDir();
      if (individualFiles.length > cap) {
        // Recorded once here, reported once by renderTruncationBanner —
        // the previous per-directory warn duplicated the banner's content.
        truncations.push({
          dir: entry.file,
          total: individualFiles.length,
          shown: cap,
        });
      }
      const limited = individualFiles.slice(0, cap);
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
  const outputFiles = classified.map((f) => {
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
    if (f.classification === 'conflict' && f.claimedBy && f.claimedBy.length > 0) {
      entry.claimedBy = [...f.claimedBy];
    }
    return entry;
  });
  const byClassification: Record<FileClassification, number> = {
    unmanaged: 0,
    'patch-owned-drift': 0,
    'patch-backed': 0,
    branding: 0,
    furnace: 0,
    conflict: 0,
  };
  for (const file of outputFiles) {
    byClassification[file.classification]++;
  }
  const output = {
    schemaVersion: 1,
    summary: {
      total: outputFiles.length,
      byClassification,
    },
    files: outputFiles,
  };
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
    if (options.json) {
      // Mirror `--json`'s contract: errors must be machine-parseable too.
      // Without this branch the human guidance above is suppressed but the
      // throw still falls through to the styled error renderer in
      // withErrorHandling, leaving JSON consumers with non-JSON output on
      // exactly the failure mode they care about catching.
      process.stdout.write(
        JSON.stringify({ schemaVersion: 1, error: guidance, code: 'engine-baseline-missing' }) +
          '\n'
      );
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
  const previousMachineOutputMode = isMachineOutputMode();
  const shouldUseMachineOutput = options.json === true || options.raw === true;
  // Machine modes own stdout exclusively: every diagnostic (clack warnings,
  // withErrorHandling's styled errors, spinner steps) routes to stderr so
  // `status --json | jq .` and `--raw` pipes always parse.
  if (shouldUseMachineOutput) {
    setMachineOutputMode(true);
  }

  try {
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

    const emitJsonError = (code: string, message: string): never => {
      process.stdout.write(JSON.stringify({ schemaVersion: 1, error: message, code }) + '\n');
      throw new CommandError(ExitCode.GENERAL_ERROR);
    };

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
        newFileCreatorsByPath,
        new Map(
          (
            await classifyFiles(
              rawFilesOwnership,
              paths.engine,
              paths.patches,
              config.binaryName,
              await collectFurnaceManagedPrefixes(projectRoot)
            )
          ).map((entry) => [entry.file, entry.classification])
        )
      );
      renderOwnershipTable(rows);

      const conflictCount = rows.filter((r) => r.conflict).length;
      const unmanagedCount = rows.filter((r) => r.unmanaged).length;
      const managedCount = rows.filter((r) => !r.unmanaged).length;

      const parts: string[] = [`${managedCount} managed`];
      if (conflictCount > 0)
        parts.push(`${conflictCount} conflict${conflictCount === 1 ? '' : 's'}`);
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
      if (options.json) {
        emitJsonError(
          'engine-missing',
          'Firefox source not found. Run "fireforge download" first.'
        );
      }
      throw new GeneralError('Firefox source not found. Run "fireforge download" first.');
    }

    // Check if it's a git repository
    if (!(await isGitRepository(paths.engine))) {
      if (options.json) {
        emitJsonError(
          'engine-not-git',
          'Engine directory is not a git repository. Run "fireforge download" to initialize.'
        );
      }
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
      patchOwnedDrift: classified.filter((f) => f.classification === 'patch-owned-drift'),
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
  } finally {
    if (isMachineOutputMode() !== previousMachineOutputMode) {
      setMachineOutputMode(previousMachineOutputMode);
    }
  }
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
