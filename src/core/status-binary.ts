// SPDX-License-Identifier: EUPL-1.2
/**
 * Binary-aware drift classification for patch-owned files.
 *
 * The text classifier compares utf-8 decoded content against
 * `computePatchedContent`, which cannot apply `GIT binary patch` bodies — so
 * a binary file exported into a patch classifies as `patch-owned-drift`
 * forever, keeping the engine-clean gate permanently red with nothing
 * actually un-durable. A `GIT binary patch` section DOES carry the ground
 * truth: `git diff --binary` always records full blob hashes on the section's
 * `index <old>..<new>` line. Comparing the live file's `git hash-object`
 * against the last owning section's new-side hash settles the classification
 * exactly. Bodies without a usable hash (hand-written diffs) classify as
 * `binary-unsupported` — an honest "cannot compare" instead of a false "not
 * durable".
 *
 * That hash is trusted ONLY when the section carries a replayable payload
 * (`hasBinaryDelta`). A `Binary files … differ` stub carries a correct index
 * line too, so hashing against it reports `patch-backed` for a body that
 * cannot rebuild the file at all — precisely the dishonesty this module
 * exists to avoid. Such a body is `binary-unsupported` here, and an error
 * from the `binary-body-not-reconstructable` queue lint.
 *
 * Lives in its own module (not `status-classify.ts`) so the classifier stays
 * within the per-file line budget and this module never has to import it
 * back: the dependency edge points one way, which keeps dpdm clean.
 */

import { join } from 'node:path';

import { toError } from '../utils/errors.js';
import { readText } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';
import { hashObjectBatch, isBinaryFile } from './git-file-ops.js';
import type { PatchedContentContext } from './patch-apply.js';
import { findPatchesAffectingFile } from './patch-manifest.js';
import type { DiffSection } from './patch-parse.js';
import { parseDiffSections } from './patch-parse.js';

/** Batched patch lookup, injected by callers that classify many files. */
export type AffectingPatchLookup = Pick<
  PatchedContentContext,
  'getAffectingPatches' | 'readPatchBody'
>;

/**
 * Classification result for a binary comparison. Structurally assignable
 * to `ClassifiedFile` without importing it (which would create a cycle
 * with `status-classify.ts`).
 */
export interface BinaryClassifiedFile {
  status: string;
  file: string;
  classification: 'patch-backed' | 'furnace' | 'patch-owned-drift' | 'binary-unsupported';
  owner: string;
}

/** Finds the LAST diff section affecting `file` across the owning patches, in queue order. */
async function findLastAffectingSection(
  patchesDir: string,
  file: string,
  lookup?: AffectingPatchLookup
): Promise<DiffSection | undefined> {
  // The lookup shares one manifest load + memoized body reads across the
  // whole classification batch; the fallback keeps single-file callers
  // (and existing direct tests) working without a context.
  const patches =
    lookup !== undefined
      ? lookup.getAffectingPatches(file)
      : (await findPatchesAffectingFile(patchesDir, file)).map(({ patch }) => patch);
  let last: DiffSection | undefined;
  for (const patch of patches) {
    const body =
      lookup !== undefined ? await lookup.readPatchBody(patch) : await readText(patch.path);
    for (const section of parseDiffSections(body)) {
      if (section.targetPath === file || section.sourcePath === file) {
        last = section;
      }
    }
  }
  return last;
}

/**
 * Classifies a single-owner file whose comparison is binary. Returns
 * `null` when the comparison is NOT binary — the live file is text and
 * (for deletions) the owning section is text — so the caller falls
 * through to the existing utf-8 content comparison unchanged.
 *
 * @param args.fileMissing - True when the porcelain status reports the
 *   file deleted (there are no live bytes to probe or hash).
 */
export async function classifyBinaryOwnedFile(args: {
  entry: { status: string; file: string };
  engineDir: string;
  patchesDir: string;
  matchClassification: 'patch-backed' | 'furnace';
  owner: string;
  fileMissing?: boolean;
  /** Batched lookup; when absent, falls back to per-file manifest queries. */
  lookup?: AffectingPatchLookup;
}): Promise<BinaryClassifiedFile | null> {
  const { entry, engineDir, patchesDir, matchClassification, owner } = args;
  const fileMissing = args.fileMissing === true;
  const unsupported = (): BinaryClassifiedFile => ({
    ...entry,
    classification: 'binary-unsupported',
    owner,
  });

  // Until the comparison is KNOWN to be binary, every failure defers to
  // the existing text path (`return null`) — classifying a text file as
  // `binary-unsupported` because a probe failed would hide real drift.
  let section: DiffSection | undefined;
  try {
    if (!fileMissing) {
      const liveBinary = await isBinaryFile(engineDir, entry.file);
      if (!liveBinary) return null;
    }
    section = await findLastAffectingSection(patchesDir, entry.file, args.lookup);
  } catch (error: unknown) {
    if (fileMissing) return null;
    verbose(
      `Classifying ${entry.file} as binary-unsupported because the binary probe failed: ${toError(error).message}`
    );
    return unsupported();
  }

  try {
    if (section === undefined) {
      // Claimed in filesAffected but no diff section touches the file.
      // A missing file keeps the existing deletion logic; a live binary
      // has nothing recorded to compare against.
      return fileMissing ? null : unsupported();
    }

    if (!section.isBinary) {
      // Text section: deletions settle fine through the text path; a
      // live binary against a text body has no comparable recording.
      return fileMissing ? null : unsupported();
    }

    if (section.isDeletedFile) {
      return {
        ...entry,
        classification: fileMissing ? matchClassification : 'patch-owned-drift',
        owner,
      };
    }

    if (fileMissing) {
      // The last binary section expects the file to exist.
      return { ...entry, classification: 'patch-owned-drift', owner };
    }

    if (section.hasBinaryDelta && section.indexNewHash !== undefined) {
      const fullPath = join(engineDir, entry.file);
      const live = (await hashObjectBatch(engineDir, [fullPath])).get(fullPath);
      if (live !== undefined) {
        // Prefix-compare: recorded hashes may be abbreviated (≥7 chars).
        const matches =
          live.startsWith(section.indexNewHash) || section.indexNewHash.startsWith(live);
        return {
          ...entry,
          classification: matches ? matchClassification : 'patch-owned-drift',
          owner,
        };
      }
    }

    return unsupported();
  } catch (error: unknown) {
    verbose(
      `Classifying ${entry.file} as binary-unsupported because the binary comparison failed: ${toError(error).message}`
    );
    return unsupported();
  }
}
