// SPDX-License-Identifier: EUPL-1.2
/**
 * Status classifier: partitions engine file changes into
 * patch-backed / unmanaged / branding / furnace / conflict buckets.
 *
 * Extracted from `src/commands/status.ts` so that command file stays
 * under the per-file line budget as the number of buckets grows.
 */

import { join } from 'node:path';

import { toError } from '../utils/errors.js';
import { readText } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';
import { isBrandingManagedPath } from './branding.js';
import { computePatchedContent } from './patch-apply.js';
import { loadPatchesManifest } from './patch-manifest.js';

/**
 * Classification buckets for engine file changes:
 * - `patch-backed`: content matches the expected post-patch state —
 *   normal after `fireforge import`.
 * - `patch-owned-drift`: the file is claimed by exactly one patch, but
 *   the live engine content no longer matches that patch's expected
 *   post-apply content. This includes furnace-prefixed paths: a path
 *   can be both Furnace-managed and patch-claimed (export a deployed
 *   component, then edit the workspace source and `furnace deploy`
 *   again — the deployed copy now has content the patch body lacks).
 *   Before 0.38.0 the furnace prefix check ran first and silently
 *   bucketed such files as `furnace`, so `status` reported the stale
 *   patch as owned.
 * - `unmanaged`: edits not explained by any patch or tool — local
 *   drift to export or discard.
 * - `branding`: files under tool-managed branding paths, written by
 *   FireForge's branding pipeline.
 * - `furnace`: files under Furnace-managed component prefixes. When
 *   exactly one patch also claims the path, this bucket asserts the
 *   live content matches that patch's expected post-apply content —
 *   a mismatch is reported as `patch-owned-drift` instead (see above).
 * - `conflict`: the file is claimed by two or more patches in
 *   `patches.json`. The human `--ownership` mode already surfaces
 *   this bucket as `CONFLICT`; the classification is carried through
 *   the JSON pipeline so machine consumers can detect the same
 *   ownership breakage the human output shows. Before 0.16.0,
 *   cross-patch conflicts silently rolled into the `unmanaged` bucket
 *   in `--json`, which misled scripts built on top of the JSON view
 *   into treating the file as routine local drift.
 */
export type FileClassification =
  'patch-backed' | 'patch-owned-drift' | 'unmanaged' | 'branding' | 'furnace' | 'conflict';

export interface StatusFile {
  status: string;
  file: string;
}

export interface ClassifiedFile extends StatusFile {
  classification: FileClassification;
  /**
   * Names of patch files that claim this path in `patches.json`.
   * Populated only when `classification === 'conflict'` — single-claim
   * patch-backed entries don't need to expose their owner because the
   * single claim is fully captured by the classification itself.
   */
  claimedBy?: string[];
  /**
   * Owning patch filename when exactly one patch claims this path
   * (patch-backed, patch-owned-drift, and single-owner furnace entries).
   * Unset for unowned, branding-generated, unowned-furnace, and conflict
   * entries — conflicts carry `claimedBy` instead. Exposed through
   * `status --json` as the `patch` field (FORGE G11).
   */
  owner?: string;
}

/**
 * Builds the file → owning-patch-filenames multimap from manifest rows.
 * Single source of truth for cross-patch claim detection — status
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
 * Single source of truth — status-output.ts renders from the same logic.
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
 * directory is NOT generated — it is a patch candidate and must stay
 * visible as unmanaged (the Assets.car precedent).
 */
export function isGeneratedBrandingPath(file: string, binaryName: string): boolean {
  const normalized = file.replace(/\\/g, '/');
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
 * clean match reports — `patch-backed` for ordinary patch-claimed paths,
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
  owner: string
): Promise<ClassifiedFile> {
  if (getPrimaryStatusCode(entry.status) === 'D') {
    // Deleted file: content matches only if the patch expects deletion
    const expected = await computePatchedContent(patchesDir, engineDir, entry.file);
    return {
      ...entry,
      classification: expected === null ? matchClassification : 'patch-owned-drift',
      owner,
    };
  }

  // File exists on disk — compare actual vs expected
  try {
    const [expected, actual] = await Promise.all([
      computePatchedContent(patchesDir, engineDir, entry.file),
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
 * Tracks patch ownership as a `Map<file, patchFilename[]>` rather than
 * a plain `Set<file>` so the classifier can surface cross-patch
 * ownership conflicts the same way the human `--ownership` mode does.
 * The 2026-04-21 eval's `status --json` run reported
 * `classification: "unmanaged"` on two files (`browser/base/jar.mn`,
 * `browser/themes/shared/jar.inc.mn`) that `--ownership` correctly
 * flagged as `CONFLICT`; the JSON output was effectively lying to
 * machine consumers about the nature of the drift.
 */
export async function classifyFiles(
  files: StatusFile[],
  engineDir: string,
  patchesDir: string,
  binaryName: string,
  furnacePrefixes: Set<string>
): Promise<ClassifiedFile[]> {
  const manifest = await loadPatchesManifest(patchesDir);

  // Build a multimap from file path → list of claiming patch
  // filenames so we can detect cross-patch ownership conflicts. The
  // previous `Set<string>` captured only whether a path was claimed,
  // not by whom, and collapsed multi-owner files into the single-owner
  // branch where the expected-vs-actual content comparison then routed
  // them into `unmanaged` when the content didn't match either owner's
  // expectation.
  const patchClaims = manifest ? buildPatchClaims(manifest.patches) : new Map<string, string[]>();

  const results: ClassifiedFile[] = [];

  for (const entry of files) {
    const owners = patchClaims.get(entry.file);
    const primaryCode = getPrimaryStatusCode(entry.status);

    // Branding paths are tool-managed for generated edits, but a brand-new
    // unowned branding asset must not disappear from `status --unmanaged`.
    // The Hominis Firefox 152 side-grade added Assets.car under the active
    // branding tree; classifying every branding path before checking
    // ownership hid that new patch candidate as "branding" even though no
    // patch claimed it yet.
    const isUnownedNewFile = owners === undefined && (primaryCode === '?' || primaryCode === 'A');
    if (
      isBrandingManagedPath(entry.file, binaryName) &&
      (!isUnownedNewFile || isGeneratedBrandingPath(entry.file, binaryName))
    ) {
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
        // A furnace path claimed by exactly one patch gets the same
        // expected-vs-actual comparison as any other single-owner path:
        // after a `furnace deploy` of an edited component the deployed
        // copy has content the owning patch's body lacks, and the old
        // unconditional short-circuit silently bucketed that drift as
        // `furnace`. Multi-owner and unowned furnace paths keep the
        // short-circuit — the ownership table independently flags
        // filesAffected conflicts.
        if (owners && owners.length === 1 && owners[0] !== undefined) {
          results.push(
            await classifySingleOwnerFile(entry, engineDir, patchesDir, 'furnace', owners[0])
          );
        } else {
          results.push({ ...entry, classification: 'furnace' });
        }
        continue;
      }
    }

    // Multiple patches claim this file — surface the cross-patch
    // ownership conflict regardless of whether the current content
    // matches any single claim. `--ownership` reports the same state
    // as `CONFLICT`; `--json` must agree so machine consumers of the
    // two views see the same truth.
    if (owners && owners.length >= 2) {
      results.push({
        ...entry,
        classification: 'conflict',
        claimedBy: [...owners],
      });
      continue;
    }

    // Not in any patch → unmanaged
    if (!owners) {
      results.push({ ...entry, classification: 'unmanaged' });
      continue;
    }

    // File is claimed by exactly one patch — compare content.
    const owner = owners[0];
    if (owner === undefined) {
      results.push({ ...entry, classification: 'unmanaged' });
      continue;
    }
    results.push(
      await classifySingleOwnerFile(entry, engineDir, patchesDir, 'patch-backed', owner)
    );
  }

  return results;
}
