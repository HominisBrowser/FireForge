// SPDX-License-Identifier: EUPL-1.2
/**
 * Scan-less re-export adjacency advisory.
 *
 * A plain `re-export` keeps the manifest's filesAffected unchanged, so a
 * brand-new file an author just created beside a patch's owned files is
 * silently left out of the refreshed body. This module detects such adjacent
 * files, filters out tool-managed paths (branding, furnace) so the notice
 * names only genuinely unmanaged candidates, and, under
 * `--refuse-adjacent-unmanaged`, lets the caller turn the notice into a
 * non-zero refusal.
 *
 * Split out of re-export.ts to keep that file inside the max-lines budget.
 * Exports helpers consumed by re-export.ts, no registrar.
 */
import { dirname, join } from 'node:path';

import { isBrandingManagedPath } from '../core/branding.js';
import { getModifiedFilesInDir, getUntrackedFilesInDir } from '../core/git-status.js';
import { getClaimedFiles } from '../core/patch-manifest.js';
import { isGeneratedBrandingPath } from '../core/status-classify.js';
import type { PatchesManifest, PatchMetadata, ReExportOptions } from '../types/commands/index.js';
import type { ProjectPaths } from '../types/config.js';
import { mapWithConcurrency } from '../utils/concurrency.js';
import { pathExists } from '../utils/fs.js';
import { info, warn } from '../utils/logger.js';
import { escapeRegex } from '../utils/regex.js';
import { findRegisteredChangedFiles } from './re-export-adjacent-registrations.js';
import { normalizeEngineRelativeInput } from './re-export-scan.js';

/**
 * Shared per-run context for the adjacency advisory: the classification
 * inputs computed once by `reExportCommand`, plus the collection of
 * patches refused under `--refuse-adjacent-unmanaged` (collected across
 * the loop so a multi-patch run reports every offender in one refusal).
 */
export interface AdjacentUnmanagedContext {
  binaryName: string;
  furnacePrefixes: ReadonlySet<string>;
  refuseAdjacentUnmanaged: boolean;
  /**
   * Engine-relative paths named by `--expect-unmanaged`: reviewed, recorded
   * exceptions that are reported but never refuse. Normalized once by the
   * caller so the comparison matches git's engine-relative output.
   */
  approvedUnmanaged: ReadonlySet<string>;
  /** Approved paths actually met this run, so unused ones can be surfaced. */
  approvedSeen: Set<string>;
  /**
   * Engine-relative paths named by `--expect-new`: files this session
   * created and will adopt with its next export (or `--scan-file`). They
   * pass the belt and are reported, while every other adjacent file still
   * refuses, so a peer's neighbour is not admitted with them.
   */
  expectedNew: ReadonlySet<string>;
  /** `--expect-new` paths actually met this run. */
  expectedNewSeen: Set<string>;
  /**
   * Reviewed `--adjacent-ignore` entries: an engine-relative path, or a
   * glob whose `*` stays within one path segment. Matches are reported in
   * one line and never refuse.
   */
  adjacentIgnore: readonly string[];
  /** `--adjacent-ignore` entries that matched a file this run. */
  adjacentIgnoreSeen: Set<string>;
  /**
   * Offenders collected across the loop. `files` stays the bare paths that
   * downstream consumers already read. `anchored` carries the same entries
   * with the owned directory that made each one adjacent, so the run-level
   * refusal can name the anchor without re-deriving it.
   */
  refusals: { patchFilename: string; files: string[]; anchored: string[] }[];
}

/**
 * Builds the run's adjacency context. The path flags are normalized once
 * here, so the per-file comparison matches git's engine-relative output.
 */
export function buildAdjacentUnmanagedContext(
  options: ReExportOptions,
  binaryName: string,
  furnacePrefixes: ReadonlySet<string>
): AdjacentUnmanagedContext {
  const normalized = (flag: string, values: readonly string[] | undefined): string[] =>
    (values ?? []).map((value) => normalizeEngineRelativeInput(value, flag));
  return {
    binaryName,
    furnacePrefixes,
    refuseAdjacentUnmanaged: options.refuseAdjacentUnmanaged === true,
    approvedUnmanaged: new Set(normalized('--expect-unmanaged', options.expectUnmanaged)),
    approvedSeen: new Set(),
    expectedNew: new Set(normalized('--expect-new', options.expectNew)),
    expectedNewSeen: new Set(),
    adjacentIgnore: normalized('--adjacent-ignore', options.adjacentIgnore),
    adjacentIgnoreSeen: new Set(),
    refusals: [],
  };
}

/**
 * The one definition of "adjacent", shared by the per-patch notice and the
 * run-level refusal so the two cannot drift apart.
 */
export const ADJACENT_MEANS =
  'Adjacent means the file sits in the same directory as a file this patch owns, ' +
  'or a registration line this patch adds (jar.mn, moz.build, test manifest) names it.';

/** Concurrency bound for existence probes (matches the classify/lint pools). */
const PATH_PROBE_CONCURRENCY = 8;

/** Returns the subset of `files` that no longer exist under `engineDir`. */
export async function findMissingFiles(
  engineDir: string,
  files: readonly string[]
): Promise<string[]> {
  const exists = await mapWithConcurrency(files, PATH_PROBE_CONCURRENCY, (file) =>
    pathExists(join(engineDir, file))
  );
  return files.filter((_, index) => exists[index] !== true);
}

function isToolManagedPath(
  file: string,
  isNewFile: boolean,
  ctx: Pick<AdjacentUnmanagedContext, 'binaryName' | 'furnacePrefixes'>
): boolean {
  // Mirrors status-classify: a generated branding path is tool-managed
  // outright. A brand-new unowned file under the branding root is still a
  // patch candidate (the Assets.car precedent) and must stay listed.
  if (
    isBrandingManagedPath(file, ctx.binaryName) &&
    (!isNewFile || isGeneratedBrandingPath(file, ctx.binaryName))
  ) {
    return true;
  }
  for (const prefix of ctx.furnacePrefixes) {
    if (file.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * One unmanaged file and the owned directory that made it adjacent.
 *
 * The anchor is what an unattended run could not previously recover: the
 * notice named the offending file and the patch, but not which of the
 * patch's owned locations the file sits beside, so triaging a refusal on a
 * patch that owns files in several directories meant re-deriving the
 * adjacency by hand from the manifest.
 */
export interface AdjacentUnmanagedFile {
  /** Engine-relative path of the unmanaged file. */
  file: string;
  /**
   * Directory holding at least one file this patch owns, or for a
   * registration-named file, the directory of the carrier naming it.
   */
  anchorDir: string;
  /** The owned carrier whose added registration line names the file. */
  registeredBy?: string;
}

/**
 * Matches an `--adjacent-ignore` entry. A `*` stays inside one path
 * segment, the same narrowness as `buildAudit.unpackaged`: a carve-out that
 * silently spans subtrees is how a reviewed exception becomes a blanket one.
 */
function matchesIgnoreEntry(entry: string, file: string): boolean {
  if (!entry.includes('*')) return entry === file;
  const pattern = entry
    .split('*')
    .map((part) => escapeRegex(part))
    .join('[^/]*');
  return new RegExp(`^${pattern}$`).test(file);
}

/**
 * Lists the unmanaged files a re-export of this patch would plausibly have
 * to capture: changed files directly in a directory the patch owns a file
 * in, and changed files a registration line the patch adds names. A file in
 * a sibling or nested directory is not adjacent. The directory listing
 * recurses (pathspecs do), so it is filtered back to the exact directories,
 * the same footprint the broad `--scan` adopts from.
 */
async function findAdjacentUnmanagedFiles(args: {
  currentFilesAffected: readonly string[];
  engineDir: string;
  manifest: PatchesManifest;
  patchFilename: string;
  ctx: AdjacentUnmanagedContext;
}): Promise<AdjacentUnmanagedFile[]> {
  const { currentFilesAffected, engineDir, manifest, patchFilename, ctx } = args;
  const parentDirs = [...new Set(currentFilesAffected.map((file) => dirname(file)))];
  const parentDirSet = new Set(parentDirs);
  const currentSet = new Set(currentFilesAffected);
  const claimedByOthers = getClaimedFiles(manifest, patchFilename);
  // First anchor wins: a file lives in exactly one directory, and a
  // directory anchor is the stronger statement than a registration one.
  const candidates = new Map<string, AdjacentUnmanagedFile>();
  const isCandidate = (file: string, isNewFile: boolean): boolean =>
    !currentSet.has(file) &&
    !claimedByOthers.has(file) &&
    !candidates.has(file) &&
    !isToolManagedPath(file, isNewFile, ctx);

  for (const dir of parentDirs) {
    const [modifiedFiles, untrackedFiles] = await Promise.all([
      getModifiedFilesInDir(engineDir, dir),
      getUntrackedFilesInDir(engineDir, dir),
    ]);
    const untrackedSet = new Set(untrackedFiles);
    for (const file of [...modifiedFiles, ...untrackedFiles]) {
      if (!parentDirSet.has(dirname(file))) continue;
      if (isCandidate(file, untrackedSet.has(file))) {
        candidates.set(file, { file, anchorDir: dirname(file) });
      }
    }
  }

  const registered = await findRegisteredChangedFiles(engineDir, currentFilesAffected);
  for (const { file, carrier } of registered) {
    // A registered path is a patch candidate whatever its tracking state,
    // so it is classified as new: only a generated path is tool-managed.
    if (isCandidate(file, true)) {
      candidates.set(file, { file, anchorDir: dirname(carrier), registeredBy: carrier });
    }
  }

  return [...candidates.values()].sort((a, b) => a.file.localeCompare(b.file));
}

/** Which carve-out admitted an adjacent file, or `refusing` for none. */
type AdjacentDisposition = 'refusing' | 'approved' | 'expected-new' | 'ignored';

function dispositionOf(file: string, ctx: AdjacentUnmanagedContext): AdjacentDisposition {
  if (ctx.approvedUnmanaged.has(file)) {
    ctx.approvedSeen.add(file);
    return 'approved';
  }
  if (ctx.expectedNew.has(file)) {
    ctx.expectedNewSeen.add(file);
    return 'expected-new';
  }
  const ignore = ctx.adjacentIgnore.find((entry) => matchesIgnoreEntry(entry, file));
  if (ignore !== undefined) {
    ctx.adjacentIgnoreSeen.add(ignore);
    return 'ignored';
  }
  return 'refusing';
}

/**
 * Splits the candidates into the ones that refuse and the ones a carve-out
 * (`--expect-unmanaged`, `--expect-new`, `--adjacent-ignore`) admits. Met
 * carve-outs are recorded so an unused one can be reported, and admitted
 * files are returned rather than dropped, so the exception stays visible
 * instead of quietly widening.
 */
function partitionApproved(
  files: readonly AdjacentUnmanagedFile[],
  ctx: AdjacentUnmanagedContext
): Record<AdjacentDisposition, AdjacentUnmanagedFile[]> {
  const groups: Record<AdjacentDisposition, AdjacentUnmanagedFile[]> = {
    refusing: [],
    approved: [],
    'expected-new': [],
    ignored: [],
  };
  for (const entry of files) groups[dispositionOf(entry.file, ctx)].push(entry);
  return groups;
}

/** How a notice names one file's anchor. */
function describeAnchor(entry: AdjacentUnmanagedFile): string {
  return entry.registeredBy !== undefined
    ? `registered by engine/${entry.registeredBy}`
    : `beside engine/${entry.anchorDir}`;
}

/** Renders `<file> (beside engine/<dir>)` or `<file> (registered by engine/<carrier>)`. */
function describeAnchored(entry: AdjacentUnmanagedFile): string {
  return `${entry.file} (${describeAnchor(entry)})`;
}

/** The admitted-file notice lines, one per carve-out that admitted anything. */
function reportAdmitted(
  patchFilename: string,
  groups: Record<AdjacentDisposition, AdjacentUnmanagedFile[]>
): void {
  const notices: [AdjacentUnmanagedFile[], string][] = [
    [groups.approved, 'admitted by --expect-unmanaged'],
    [groups['expected-new'], 'expected by --expect-new'],
    [groups.ignored, 'ignored by --adjacent-ignore'],
  ];
  for (const [entries, how] of notices) {
    if (entries.length === 0) continue;
    info(
      `${patchFilename}: ${entries.length} adjacent unmanaged file(s) ${how} ` +
        `(${entries.map(describeAnchored).join(', ')}) — reported, not refused.`
    );
  }
}

/**
 * Emits the scan-less advisory for one patch: missing manifest files and
 * unmanaged files adjacent to the patch's ownership. When
 * `--refuse-adjacent-unmanaged` is set and any unmanaged adjacent file
 * exists, records the patch into `ctx.refusals` and returns true. The
 * caller then skips the write for this patch and converts the collection
 * into one run-level non-zero refusal after the loop.
 */
export async function reportAdjacentUnmanagedFiles(args: {
  patch: PatchMetadata;
  paths: ProjectPaths;
  manifest: PatchesManifest;
  currentFilesAffected: readonly string[];
  ctx: AdjacentUnmanagedContext;
}): Promise<boolean> {
  const { patch, paths, manifest, currentFilesAffected, ctx } = args;
  const missingFiles = await findMissingFiles(paths.engine, currentFilesAffected);
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

  const allUnmanaged = await findAdjacentUnmanagedFiles({
    currentFilesAffected,
    engineDir: paths.engine,
    manifest,
    patchFilename: patch.filename,
    ctx,
  });
  const groups = partitionApproved(allUnmanaged, ctx);
  reportAdmitted(patch.filename, groups);
  const unmanagedFiles = groups.refusing;
  if (unmanagedFiles.length === 0) return false;

  const firstFew = unmanagedFiles.slice(0, 3).map(describeAnchored).join(', ');
  const more = unmanagedFiles.length > 3 ? `, +${unmanagedFiles.length - 3} more` : '';
  warn(
    `${patch.filename}: found ${unmanagedFiles.length} unmanaged file(s) adjacent to this patch's ownership (${firstFew}${more}). ` +
      `${ADJACENT_MEANS} ` +
      `Plain re-export keeps filesAffected unchanged — use --scan-file to include reviewed files, ` +
      `or --expect-new for a file your next export adopts.`
  );
  for (const entry of unmanagedFiles) {
    info(
      `  ${entry.file} — ${describeAnchor(entry)} — ` +
        `fireforge re-export ${patch.filename} --scan --scan-file ${entry.file}`
    );
  }

  if (ctx.refuseAdjacentUnmanaged) {
    ctx.refusals.push({
      patchFilename: patch.filename,
      files: unmanagedFiles.map((entry) => entry.file),
      anchored: unmanagedFiles.map(describeAnchored),
    });
    return true;
  }
  return false;
}

/**
 * End-of-run accounting for `--expect-new` and `--adjacent-ignore`.
 *
 * An `--expect-new` path is a promise that the next export adopts it, so a
 * met one is repeated as the export still owed, and an unmet one is a
 * warning: a typo there leaves the refusal armed for the file it meant to
 * admit. An unmatched `--adjacent-ignore` entry is only noted, because a
 * reviewed ignore list is reused across runs and patches, and "not met"
 * is its normal case.
 */
export function reportAdjacentCarveOutUsage(ctx: AdjacentUnmanagedContext): void {
  const unseenNew = [...ctx.expectedNew].filter((file) => !ctx.expectedNewSeen.has(file));
  if (unseenNew.length > 0) {
    warn(
      `--expect-new path(s) were not met as adjacent unmanaged files this run: ` +
        `${unseenNew.join(', ')}. Check the path for a typo, and that a selected patch owns a ` +
        'file in its directory or registers it. The refusal stayed armed for everything else.'
    );
  }
  if (ctx.expectedNewSeen.size > 0) {
    info(
      `--expect-new admitted ${[...ctx.expectedNewSeen].sort().join(', ')}, which no patch owns ` +
        'yet. Export them next so the queue does not register files it does not ship.'
    );
  }
  const unseenIgnore = ctx.adjacentIgnore.filter((entry) => !ctx.adjacentIgnoreSeen.has(entry));
  if (unseenIgnore.length > 0) {
    info(
      `--adjacent-ignore entries matched no adjacent file this run: ${unseenIgnore.join(', ')}.`
    );
  }
}
