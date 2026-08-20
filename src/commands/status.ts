// SPDX-License-Identifier: EUPL-1.2
import { Command } from 'commander';

import { readBuildBaseline } from '../core/build-baseline.js';
import { getProjectPaths, loadConfig } from '../core/config.js';
import {
  formatEngineSessionLockStatus,
  readEngineSessionLockStatus,
} from '../core/engine-session-lock.js';
import { collectFurnaceManagedPrefixes } from '../core/furnace-config.js';
import { getHead, getStatusWithCodes, isGitRepository, isMissingHeadError } from '../core/git.js';
import { getUntrackedFilesInDir, resolveMaxUntrackedFilesPerDir } from '../core/git-status.js';
import { renderOwnershipTable } from '../core/ownership-table.js';
import { loadPatchesManifest } from '../core/patch-manifest.js';
import { type ClassifiedFile, classifyFiles, type StatusFile } from '../core/status-classify.js';
import { CommandError, GeneralError, InvalidArgumentError } from '../errors/base.js';
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
import { resolveStatusCheckPolicy, runStatusCheck } from './status-check.js';
import { renderJsonStatus, renderJsonSummaryStatus } from './status-json.js';
import {
  type ClassifiedBuckets,
  renderDefaultStatus,
  renderTestCoverageStatus,
  renderUnmanagedOnly,
} from './status-output.js';
import {
  buildOwnershipJsonBlock,
  collectOwnershipRows,
  summarizeOwnership,
} from './status-ownership.js';

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
async function classifyStatusFiles(
  files: StatusFile[],
  paths: ReturnType<typeof getProjectPaths>,
  projectRoot: string,
  binaryName: string
): Promise<ClassifiedFile[]> {
  const furnacePrefixes = await collectFurnaceManagedPrefixes(projectRoot);
  return classifyFiles(files, paths.engine, paths.patches, binaryName, furnacePrefixes);
}

/**
 * The one worktree scan every classifying mode shares: porcelain status,
 * collapsed-directory expansion, atomic-temp-file filtering, and the
 * truncation banner. `--ownership` used to carry its own copy of this
 * block; a non-git engine degrades to an empty list there,
 * which is why the git probe is a parameter rather than a hard guard.
 * @param engineDir - Path to the engine directory
 * @param requireGitRepository - When false, a non-git engine yields `[]`
 *   instead of being probed (the historical `--ownership` behavior)
 */
async function scanEngineStatusFiles(
  engineDir: string,
  requireGitRepository: boolean
): Promise<StatusFile[]> {
  if (!requireGitRepository && !(await isGitRepository(engineDir))) {
    return [];
  }
  const { entries, truncations } = await expandDirectoryEntries(
    await getStatusWithCodes(engineDir),
    engineDir
  );
  renderTruncationBanner(truncations);
  return filterFireForgeTempFiles(entries);
}

/**
 * Emits the `--json` payload (full or `--summary`) and applies the
 * `--check` policy, which stays the SOLE exit driver on this path.
 *
 * `--include-ownership` is a MODIFIER, not a mode: it appends an
 * ownership block without touching exit semantics, so an ownership conflict
 * still fails only the human `--ownership` mode.
 * @param classified - Classified worktree entries
 * @param files - The same entries pre-classification, for ownership rows
 * @param paths - Resolved project paths
 * @param options - Status display options
 * @param checkPolicy - Resolved `--check`/`--fail-on` policy
 */
async function renderJsonMode(
  classified: ClassifiedFile[],
  files: StatusFile[],
  paths: ReturnType<typeof getProjectPaths>,
  options: StatusOptions,
  checkPolicy: ReturnType<typeof resolveStatusCheckPolicy>
): Promise<void> {
  const ownership =
    options.includeOwnership === true
      ? buildOwnershipJsonBlock(
          await collectOwnershipRows(
            paths.patches,
            (await loadPatchesManifest(paths.patches))?.patches ?? [],
            files,
            classified
          )
        )
      : undefined;
  if (options.summary === true) {
    renderJsonSummaryStatus(classified, checkPolicy, ownership);
  } else {
    renderJsonStatus(classified, ownership);
  }
  runStatusCheck(classified, checkPolicy);
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

  // On a throw, machine mode deliberately stays ENGAGED: withErrorHandling
  // routes the styled error to stderr while the mode is on and resets it
  // centrally (a mid-throw restore here put the refusal on stdout after the
  // JSON payload, breaking the 0.40.0 stderr promise).
  await runStatusCommandBody(projectRoot, options);

  if (isMachineOutputMode() !== previousMachineOutputMode) {
    setMachineOutputMode(previousMachineOutputMode);
  }
}

/** The status body proper; the machine-mode lifecycle lives in {@link statusCommand}. */
async function runStatusCommandBody(projectRoot: string, options: StatusOptions): Promise<void> {
  const modeCount = [
    options.raw,
    options.unmanaged,
    options.ownership,
    options.testCoverage,
    options.json,
    options.lock,
  ].filter((v) => v === true).length;
  if (modeCount > 1) {
    throw new GeneralError(
      'Cannot use --raw, --unmanaged, --ownership, --test-coverage, --lock, and --json together. Pick at most one.'
    );
  }

  // --summary elides the files[] payload for gate consumers;
  // it only makes sense on the JSON shape.
  if (options.summary === true && options.json !== true) {
    throw new InvalidArgumentError('--summary requires --json.', '--summary');
  }

  // --include-ownership adds a block to the JSON payload; it is meaningless
  // on the human views, where --ownership is the mode that renders the
  // table.
  if (options.includeOwnership === true && options.json !== true) {
    throw new InvalidArgumentError(
      '--include-ownership requires --json. Use --ownership for the human table.',
      '--include-ownership'
    );
  }

  // --check / --fail-on enforcement policy. Applies only
  // where classification runs (the default view and --json).
  const checkPolicy = resolveStatusCheckPolicy(options);

  if (!options.raw && !options.json) {
    intro('FireForge Status');
  }

  // Lock visibility. Placed before every engine/git guard: the
  // whole point is to answer "who is holding this?" on a checkout that a
  // concurrent command is busy with, and that answer must not depend on
  // engine/ being readable.
  if (options.lock === true) {
    for (const line of formatEngineSessionLockStatus(
      await readEngineSessionLockStatus(projectRoot)
    )) {
      info(line);
    }
    outro('Lock status');
    return;
  }

  // Test-coverage mode needs only the project root (the baseline lives
  // in .fireforge/), so it short-circuits before any engine/git guards.
  if (options.testCoverage) {
    renderTestCoverageStatus(await readBuildBaseline(projectRoot));
    return;
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
    // Same scan and the SAME classification pass as every other mode
    //. This branch keeps its historical guard shape on purpose:
    // no baseline-commit assertion, and a non-git engine degrades to an
    // empty table rather than the recovery banner.
    const rawFilesOwnership = await scanEngineStatusFiles(paths.engine, false);
    const rows = await collectOwnershipRows(
      paths.patches,
      manifest?.patches ?? [],
      rawFilesOwnership,
      await classifyStatusFiles(rawFilesOwnership, paths, projectRoot, config.binaryName)
    );
    renderOwnershipTable(rows);

    const { managed, unmanaged, conflicts } = summarizeOwnership(rows);
    const parts: string[] = [`${managed} managed`];
    if (conflicts > 0) parts.push(`${conflicts} conflict${conflicts === 1 ? '' : 's'}`);
    if (unmanaged > 0) parts.push(`${unmanaged} unmanaged`);
    outro(parts.join(', '));

    if (conflicts > 0) {
      throw new GeneralError(
        `${conflicts} path(s) are claimed by more than one patch. ` +
          'Run "fireforge verify" for full details, then use "re-export --files" or ' +
          '"patch delete" to resolve.'
      );
    }
    return;
  }

  // Check if engine exists
  if (!(await pathExists(paths.engine))) {
    if (options.json) {
      emitJsonError('engine-missing', 'Firefox source not found. Run "fireforge download" first.');
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

  const files = await scanEngineStatusFiles(paths.engine, true);

  // `--json` callers expect machine-parseable output on every invocation,
  // including the clean-tree case. Before this ordering fix a clean tree
  // printed "No modified files" / "Working tree clean" via the human
  // branch below and `--json` was silently ignored, so scripts that piped
  // the output through a JSON parser broke precisely when there was
  // nothing to report. Emit `[]` here and return before the human fallback.
  if (options.json) {
    const classified = await classifyStatusFiles(files, paths, projectRoot, config.binaryName);
    await renderJsonMode(classified, files, paths, options, checkPolicy);
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
  const classified = await classifyStatusFiles(files, paths, projectRoot, config.binaryName);

  const buckets: ClassifiedBuckets = {
    conflict: classified.filter((f) => f.classification === 'conflict'),
    unmanaged: classified.filter((f) => f.classification === 'unmanaged'),
    patchOwnedDrift: classified.filter((f) => f.classification === 'patch-owned-drift'),
    patchBacked: classified.filter((f) => f.classification === 'patch-backed'),
    branding: classified.filter((f) => f.classification === 'branding'),
    furnace: classified.filter((f) => f.classification === 'furnace'),
    binaryUnsupported: classified.filter((f) => f.classification === 'binary-unsupported'),
  };

  // --unmanaged mode: only show unmanaged
  if (options.unmanaged) {
    await renderUnmanagedOnly(buckets.unmanaged, files.length, projectRoot, config.binaryName);
    return;
  }

  await renderDefaultStatus(files.length, buckets, projectRoot, config.binaryName);
  runStatusCheck(classified, checkPolicy);
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
    .option(
      '--lock',
      'Report the engine session lock instead of file status: holder pid, its command, how long it has held the lock, and how many waiters are queued behind it (read-only; never acquires it)'
    )
    .option('--unmanaged', 'Show only unmanaged changes (not covered by patches or tools)')
    .option(
      '--ownership',
      'Show a flat path → owning patch table (flags files claimed by multiple patches)'
    )
    .option(
      '--test-coverage',
      'Show what the last recorded build covers for test packaging (full or scoped paths)'
    )
    .option('--json', 'Output classified file status as JSON')
    .option(
      '--summary',
      'With --json: emit only summary counts (plus offending files when --check/--fail-on is active), omitting the per-file files[] payload'
    )
    .option(
      '--include-ownership',
      'With --json (composes with --summary): append an ownership block (path->owning-patch rows plus managed/unmanaged/conflict counts) to the payload, so one scan serves the classification, ownership, and check views. Does not change exit semantics.'
    )
    .option(
      '--check',
      'Exit non-zero when any unmanaged, patch-owned-drift, or conflict file exists (composes with --json; combine with --fail-on for finer policy)'
    )
    .option(
      '--fail-on <classifications>',
      'Comma-separated classification list that fails --check, replacing the default set (implies --check). Valid: patch-backed, patch-owned-drift, unmanaged, branding, furnace, conflict, binary-unsupported'
    )
    .action(
      withErrorHandling(
        async (options: {
          raw?: boolean;
          lock?: boolean;
          unmanaged?: boolean;
          ownership?: boolean;
          testCoverage?: boolean;
          json?: boolean;
          summary?: boolean;
          includeOwnership?: boolean;
          check?: boolean;
          failOn?: string;
        }) => {
          await statusCommand(getProjectRoot(), options);
        }
      )
    );
}
