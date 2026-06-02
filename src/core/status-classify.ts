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
 *   post-apply content.
 * - `unmanaged`: edits not explained by any patch or tool — local
 *   drift to export or discard.
 * - `branding`: files under tool-managed branding paths, written by
 *   FireForge's branding pipeline.
 * - `furnace`: files under Furnace-managed component prefixes.
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
  | 'patch-backed'
  | 'patch-owned-drift'
  | 'unmanaged'
  | 'branding'
  | 'furnace'
  | 'conflict';

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

function isGeneratedBrandingPath(file: string, binaryName: string): boolean {
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
  const patchClaims = new Map<string, string[]>();
  if (manifest) {
    for (const patch of manifest.patches) {
      for (const f of patch.filesAffected) {
        const owners = patchClaims.get(f);
        if (owners) {
          owners.push(patch.filename);
        } else {
          patchClaims.set(f, [patch.filename]);
        }
      }
    }
  }

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
        results.push({ ...entry, classification: 'furnace' });
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
    if (primaryCode === 'D') {
      // Deleted file: patch-backed only if patch expects deletion
      const expected = await computePatchedContent(patchesDir, engineDir, entry.file);
      results.push({
        ...entry,
        classification: expected === null ? 'patch-backed' : 'patch-owned-drift',
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
        classification: actual === expected ? 'patch-backed' : 'patch-owned-drift',
      });
    } catch (error: unknown) {
      verbose(
        `Treating ${entry.file} as patch-owned drift because patch-backed classification failed: ${toError(error).message}`
      );
      results.push({ ...entry, classification: 'patch-owned-drift' });
    }
  }

  return results;
}
