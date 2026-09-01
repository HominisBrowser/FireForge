// SPDX-License-Identifier: EUPL-1.2
/**
 * Scan-less re-export adjacency advisory.
 *
 * A plain `re-export` keeps the manifest's filesAffected unchanged, so a
 * brand-new file an author just created beside a patch's owned files is
 * silently left out of the refreshed body. This module detects such adjacent
 * files, filters out tool-managed paths (branding, furnace) so the notice
 * names only genuinely unmanaged candidates, and — under
 * `--refuse-adjacent-unmanaged` — lets the caller turn the notice into a
 * non-zero refusal.
 *
 * Split out of re-export.ts to keep that file inside the max-lines budget;
 * exports helpers consumed by re-export.ts, no registrar.
 */
import { dirname, join } from 'node:path';

import { isBrandingManagedPath } from '../core/branding.js';
import type { getProjectPaths } from '../core/config.js';
import { getModifiedFilesInDir, getUntrackedFilesInDir } from '../core/git-status.js';
import { getClaimedFiles } from '../core/patch-manifest.js';
import { isGeneratedBrandingPath } from '../core/status-classify.js';
import type { PatchesManifest, PatchMetadata } from '../types/commands/index.js';
import { mapWithConcurrency } from '../utils/concurrency.js';
import { pathExists } from '../utils/fs.js';
import { info, warn } from '../utils/logger.js';

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
  refusals: { patchFilename: string; files: string[] }[];
}

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
  // outright; a brand-new unowned file under the branding root is still a
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

async function findAdjacentUnmanagedFiles(args: {
  currentFilesAffected: readonly string[];
  engineDir: string;
  manifest: PatchesManifest;
  patchFilename: string;
  ctx: AdjacentUnmanagedContext;
}): Promise<string[]> {
  const { currentFilesAffected, engineDir, manifest, patchFilename, ctx } = args;
  const parentDirs = [...new Set(currentFilesAffected.map((file) => dirname(file)))];
  const currentSet = new Set(currentFilesAffected);
  const claimedByOthers = getClaimedFiles(manifest, patchFilename);
  const candidates = new Set<string>();

  for (const dir of parentDirs) {
    const [modifiedFiles, untrackedFiles] = await Promise.all([
      getModifiedFilesInDir(engineDir, dir),
      getUntrackedFilesInDir(engineDir, dir),
    ]);
    const untrackedSet = new Set(untrackedFiles);
    for (const file of [...modifiedFiles, ...untrackedFiles]) {
      if (currentSet.has(file) || claimedByOthers.has(file)) continue;
      if (isToolManagedPath(file, untrackedSet.has(file), ctx)) continue;
      candidates.add(file);
    }
  }

  return [...candidates].sort();
}

/**
 * Splits the candidates into the ones that refuse and the ones a
 * `--expect-unmanaged` carve-out admits. Approved paths are recorded as seen
 * so an unused carve-out can be reported, and are RETURNED rather than
 * dropped: an exception nobody can see is how a carve-out quietly widens.
 */
function partitionApproved(
  files: readonly string[],
  ctx: AdjacentUnmanagedContext
): { refusing: string[]; approved: string[] } {
  const refusing: string[] = [];
  const approved: string[] = [];
  for (const file of files) {
    if (ctx.approvedUnmanaged.has(file)) {
      ctx.approvedSeen.add(file);
      approved.push(file);
    } else {
      refusing.push(file);
    }
  }
  return { refusing, approved };
}

/**
 * Emits the scan-less advisory for one patch: missing manifest files and
 * unmanaged files adjacent to the patch's ownership. When
 * `--refuse-adjacent-unmanaged` is set and any unmanaged adjacent file
 * exists, records the patch into `ctx.refusals` and returns true — the
 * caller then skips the write for this patch and converts the collection
 * into one run-level non-zero refusal after the loop.
 */
export async function reportAdjacentUnmanagedFiles(args: {
  patch: PatchMetadata;
  paths: ReturnType<typeof getProjectPaths>;
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
  const { refusing: unmanagedFiles, approved } = partitionApproved(allUnmanaged, ctx);

  if (approved.length > 0) {
    info(
      `${patch.filename}: ${String(approved.length)} adjacent unmanaged file(s) admitted by ` +
        `--expect-unmanaged (${approved.join(', ')}) — reported, not refused.`
    );
  }
  if (unmanagedFiles.length === 0) return false;

  const firstFew = unmanagedFiles.slice(0, 3).join(', ');
  const more = unmanagedFiles.length > 3 ? `, +${String(unmanagedFiles.length - 3)} more` : '';
  warn(
    `${patch.filename}: found ${String(unmanagedFiles.length)} unmanaged file(s) adjacent to this patch's ownership (${firstFew}${more}); plain re-export keeps filesAffected unchanged — use --scan-file to include reviewed files.`
  );
  for (const file of unmanagedFiles) {
    info(`  ${file} — fireforge re-export ${patch.filename} --scan --scan-file ${file}`);
  }

  if (ctx.refuseAdjacentUnmanaged) {
    ctx.refusals.push({ patchFilename: patch.filename, files: unmanagedFiles });
    return true;
  }
  return false;
}
