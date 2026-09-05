// SPDX-License-Identifier: EUPL-1.2
/**
 * Status classifier: partitions engine file changes into
 * patch-backed / unmanaged / branding / furnace / conflict buckets.
 *
 * Extracted from `src/commands/status.ts` so that command file stays
 * under the per-file line budget as the number of buckets grows.
 */

import { join } from 'node:path';

import { mapWithConcurrency } from '../utils/concurrency.js';
import { toError } from '../utils/errors.js';
import { readText } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';
import { normalizePathSlashes } from '../utils/paths.js';
import { isBrandingManagedPath } from './branding.js';
import type { PatchedContentContext } from './patch-apply.js';
import { createPatchedContentContext } from './patch-apply.js';
import { classifyBinaryOwnedFile } from './status-binary.js';

/**
 * Classification buckets for engine file changes:
 * - `patch-backed`: content matches the expected post-patch state. Normal
 *   after `fireforge import`.
 * - `patch-owned-drift`: the file is claimed by exactly one patch, but the
 *   live engine content no longer matches that patch's expected post-apply
 *   content. This includes furnace-prefixed paths: a path can be both
 *   Furnace-managed and patch-claimed (export a deployed component, then
 *   edit the workspace source and `furnace deploy` again, and the deployed
 *   copy now has content the patch body lacks). Checking the furnace
 *   prefix first would bucket such files as `furnace` and report the stale
 *   patch as owned.
 * - `unmanaged`: edits not explained by any patch or tool. Local drift to
 *   export or discard.
 * - `branding`: files under tool-managed branding paths, written by
 *   FireForge's branding pipeline.
 * - `furnace`: files under Furnace-managed component prefixes. When exactly
 *   one patch also claims the path, this bucket asserts the live content
 *   matches that patch's expected post-apply content. A mismatch is
 *   reported as `patch-owned-drift` instead (see above).
 * - `conflict`: the file is claimed by two or more patches in
 *   `patches.json`. The human `--ownership` mode surfaces this bucket as
 *   `CONFLICT`. Carrying the classification through the JSON pipeline lets
 *   machine consumers detect the same ownership breakage rather than seeing
 *   it rolled into `unmanaged` as routine local drift.
 * - `binary-unsupported`: the file's comparison is binary and the owning
 *   patch body records no usable blob hash to compare against. It reports an
 *   honest "binary, comparison unsupported" instead of a permanent false
 *   `patch-owned-drift`. Not in the default `--check` fail set. Opt in
 *   with `--fail-on binary-unsupported`.
 */
export type FileClassification =
  | 'patch-backed'
  | 'patch-owned-drift'
  | 'unmanaged'
  | 'branding'
  | 'furnace'
  | 'conflict'
  | 'binary-unsupported';

export interface StatusFile {
  status: string;
  file: string;
}

export interface ClassifiedFile extends StatusFile {
  classification: FileClassification;
  /**
   * Names of patch files that claim this path in `patches.json`.
   * Populated only when `classification === 'conflict'`. Single-claim
   * patch-backed entries don't need to expose their owner because the
   * single claim is fully captured by the classification itself.
   */
  claimedBy?: string[];
  /**
   * Owning patch filename when exactly one patch claims this path
   * (patch-backed, patch-owned-drift, and single-owner furnace entries).
   * Unset for unowned, branding-generated, unowned-furnace, and conflict
   * entries. Conflicts carry `claimedBy` instead. Exposed through
   * `status --json` as the `patch` field.
   */
  owner?: string;
}

/**
 * Builds the file → owning-patch-filenames multimap from manifest rows.
 * Single source of truth for cross-patch claim detection: status
 * classification, verify's cross-claim check, and the ownership table all
 * consume this builder (they used to each rebuild it, one drift away from
 * disagreeing about what "claimed" means).
 */
export function buildPatchClaims(
  manifestPatches: ReadonlyArray<{ filename: string; filesAffected: string[] }>
): Map<string, string[]> {
  const ownersByPath = new Map<string, string[]>();
  for (const patch of manifestPatches) {
    for (const file of patch.filesAffected) {
      const existing = ownersByPath.get(file) ?? [];
      existing.push(patch.filename);
      ownersByPath.set(file, existing);
    }
  }
  return ownersByPath;
}

/**
 * Reduces a two-character porcelain XY status to its primary code.
 * Single source of truth, and status-output.ts renders from the same logic.
 */
export function getPrimaryStatusCode(status: string): string {
  if (status.includes('?')) return '?';
  if (status.includes('!')) return '!';

  for (const code of status) {
    if (code !== ' ') {
      return code;
    }
  }

  return status;
}

/**
 * True for the branding paths whose content FireForge generates itself
 * (configure.sh, brand.properties/ftl, browser/moz.configure). Unlike the
 * broader branding-root test, a brand-new unowned file under the branding
 * directory is not generated: it is a patch candidate and must stay
 * visible as unmanaged (the Assets.car precedent).
 */
export function isGeneratedBrandingPath(file: string, binaryName: string): boolean {
  const normalized = normalizePathSlashes(file);
  const brandingRoot = `browser/branding/${binaryName}`;
  return (
    normalized === 'browser/moz.configure' ||
    normalized === `${brandingRoot}/configure.sh` ||
    normalized === `${brandingRoot}/locales/en-US/brand.properties` ||
    normalized === `${brandingRoot}/locales/en-US/brand.ftl`
  );
}

/**
 * Compares a single-owner file's live engine content against its owning
 * patch's expected post-apply content. `matchClassification` is what a
 * clean match reports: `patch-backed` for ordinary patch-claimed paths,
 * `furnace` for furnace-prefixed paths so healthy deployed components
 * keep landing in the pinned furnace bucket. Any mismatch (including a
 * deletion the patch does not expect, or a failed comparison) reports
 * `patch-owned-drift`.
 */
async function classifySingleOwnerFile(
  entry: StatusFile,
  engineDir: string,
  patchesDir: string,
  matchClassification: 'patch-backed' | 'furnace',
  owner: string,
  ctx: PatchedContentContext
): Promise<ClassifiedFile> {
  // Binary comparisons cannot go through the utf-8 content path below.
  // Binary patch bodies parse to zero hunks, so the patched-content
  // computation returned HEAD content unchanged and the comparison
  // reported `patch-owned-drift` forever. Settle by blob hash,
  // or classify explicitly as `binary-unsupported` when no hash exists.
  const binaryResult = await classifyBinaryOwnedFile({
    entry,
    engineDir,
    patchesDir,
    matchClassification,
    owner,
    fileMissing: getPrimaryStatusCode(entry.status) === 'D',
    lookup: ctx,
  });
  if (binaryResult !== null) {
    return binaryResult;
  }

  if (getPrimaryStatusCode(entry.status) === 'D') {
    // Deleted file: content matches only if the patch expects deletion
    const expected = await ctx.computePatched(entry.file);
    return {
      ...entry,
      classification: expected === null ? matchClassification : 'patch-owned-drift',
      owner,
    };
  }

  // File exists on disk: compare actual vs expected
  try {
    const [expected, actual] = await Promise.all([
      ctx.computePatched(entry.file),
      readText(join(engineDir, entry.file)),
    ]);

    return {
      ...entry,
      classification: actual === expected ? matchClassification : 'patch-owned-drift',
      owner,
    };
  } catch (error: unknown) {
    verbose(
      `Treating ${entry.file} as patch-owned drift because patch-backed classification failed: ${toError(error).message}`
    );
    return { ...entry, classification: 'patch-owned-drift', owner };
  }
}

/**
 * Classifies files into patch-backed, unmanaged, branding, furnace, or
 * conflict buckets.
 *
 * Tracks patch ownership as a `Map<file, patchFilename[]>` rather than a
 * plain `Set<file>` so the classifier can surface cross-patch ownership
 * conflicts the same way the human `--ownership` mode does. With only a Set,
 * `status --json` reports `classification: "unmanaged"` on files that
 * `--ownership` correctly flags as `CONFLICT`, which lies to machine
 * consumers about the nature of the drift.
 */
export async function classifyFiles(
  files: StatusFile[],
  engineDir: string,
  patchesDir: string,
  binaryName: string,
  furnacePrefixes: Set<string>
): Promise<ClassifiedFile[]> {
  // One manifest load + patch discovery + memoized body reads for the
  // whole batch. The previous per-file computation re-ran all three for
  // every dirty file (O(dirtyFiles × patches) redundant IO on a broad
  // engine edit session).
  const ctx = await createPatchedContentContext(patchesDir, engineDir);

  // Build a multimap from file path → list of claiming patch filenames so
  // cross-patch ownership conflicts are detectable. A plain `Set<string>`
  // captures only whether a path was claimed, not by whom, and collapses
  // multi-owner files into the single-owner branch where the
  // expected-vs-actual content comparison then routes them into `unmanaged`
  // when the content matches neither owner's expectation.
  const patchClaims = buildPatchClaims(ctx.manifestPatches);

  const deps: ClassifyEntryDeps = {
    engineDir,
    patchesDir,
    binaryName,
    furnacePrefixes,
    patchClaims,
    ctx,
  };
  // Bounded pool over per-file classification (each single-owner file
  // spawns git). Order preserved by the mapper. Per-file failures settle
  // inside classifySingleOwnerFile's catch, so one bad file never rejects
  // the batch.
  return mapWithConcurrency(files, CLASSIFY_CONCURRENCY, (entry) => classifyEntry(entry, deps));
}

/** Concurrency bound for per-file classification (matches import's guard). */
const CLASSIFY_CONCURRENCY = 8;

interface ClassifyEntryDeps {
  engineDir: string;
  patchesDir: string;
  binaryName: string;
  furnacePrefixes: Set<string>;
  patchClaims: Map<string, string[]>;
  ctx: PatchedContentContext;
}

/** Classifies one status entry. Extracted so the pool worker stays flat. */
async function classifyEntry(entry: StatusFile, deps: ClassifyEntryDeps): Promise<ClassifiedFile> {
  const { engineDir, patchesDir, binaryName, furnacePrefixes, patchClaims, ctx } = deps;
  const owners = patchClaims.get(entry.file);
  const primaryCode = getPrimaryStatusCode(entry.status);

  // Ownership is a structural invariant and takes precedence over the
  // content-management bucket. Otherwise a branding/Furnace prefix hides a
  // multi-patch claim from status --check/--json even though --ownership
  // reports the same path as CONFLICT.
  if (owners && owners.length >= 2) {
    return {
      ...entry,
      classification: 'conflict',
      claimedBy: [...owners],
    };
  }

  // Branding paths are tool-managed for generated edits, but a brand-new
  // unowned branding asset must not disappear from `status --unmanaged`:
  // classifying every branding path before checking ownership hides a new
  // patch candidate (an Assets.car appearing under the active branding tree,
  // for instance) as "branding" even though no patch claims it yet.
  const isUnownedNewFile = owners === undefined && (primaryCode === '?' || primaryCode === 'A');
  if (
    isBrandingManagedPath(entry.file, binaryName) &&
    (!isUnownedNewFile || isGeneratedBrandingPath(entry.file, binaryName))
  ) {
    return { ...entry, classification: 'branding' };
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
      // A furnace path claimed by exactly one patch gets the same
      // expected-vs-actual comparison as any other single-owner path: after
      // a `furnace deploy` of an edited component the deployed copy has
      // content the owning patch's body lacks, and an unconditional
      // short-circuit here would silently bucket that drift as `furnace`.
      // Multi-owner and unowned furnace paths keep the short-circuit.
      if (owners && owners.length === 1 && owners[0] !== undefined) {
        return classifySingleOwnerFile(entry, engineDir, patchesDir, 'furnace', owners[0], ctx);
      }
      return { ...entry, classification: 'furnace' };
    }
  }

  // Not in any patch → unmanaged
  if (!owners) {
    return { ...entry, classification: 'unmanaged' };
  }

  // File is claimed by exactly one patch: compare content.
  const owner = owners[0];
  if (owner === undefined) {
    return { ...entry, classification: 'unmanaged' };
  }
  return classifySingleOwnerFile(entry, engineDir, patchesDir, 'patch-backed', owner, ctx);
}
