// SPDX-License-Identifier: EUPL-1.2
/**
 * Patch-aware restore planning for `fireforge discard` (FORGE F1, P0).
 *
 * The engine convention is: HEAD = pristine upstream Firefox, and the
 * applied patch queue lives as UNCOMMITTED worktree changes on top of it
 * (`git apply` without `--index` → patch-edited tracked files are unstaged
 * modifications, patch-created files are untracked). The pre-0.39.0
 * `discard` was purely git-mechanical — it restored to HEAD and deleted
 * untracked files, silently reverting patch-backed files PAST their owning
 * patch and deleting patch-created files outright.
 *
 * This module classifies each status entry against the patch manifest's
 * ownership claims and plans the correct restore target: the PATCH-APPLIED
 * baseline (HEAD content folded through every affecting patch in order) for
 * claimed files, and the legacy git mechanics for unmanaged ones.
 */

import { join } from 'node:path';

import { GeneralError } from '../errors/base.js';
import { toError } from '../utils/errors.js';
import { readText, removeFile, writeText } from '../utils/fs.js';
import type { GitStatusEntry } from './git-base.js';
import {
  discardStatusEntry,
  fileExistsInHead,
  listTrackedInHead,
  restoreTrackedPath,
  unstageFiles,
} from './git-file-ops.js';
import { createPatchedContentContext } from './patch-apply.js';
import { loadPatchesManifestState } from './patch-manifest-io.js';
import { type DiffSection, parseDiffSections } from './patch-parse.js';
import { buildPatchClaims } from './status-classify.js';

/** How one status entry's canonical path will be restored. */
export type DiscardKind =
  | 'unmanaged' // no patch claims either path → legacy git mechanics
  | 'patch-backed' // tracked in HEAD, claimed → rewrite to patched content
  | 'patch-created' // not in HEAD, claimed, baseline exists → re-materialize
  | 'patch-deleted'; // claimed, baseline is absence → remove

/** Restore plan for one git status entry. */
export interface DiscardBaselinePlan {
  entry: GitStatusEntry;
  kind: DiscardKind;
  /** Claiming patch filenames for `entry.file` ∪ `entry.originalPath`. */
  owners: string[];
  /** True when more than one patch claims the path (ownership conflict). */
  conflicted: boolean;
  /** Baseline content for `entry.file`; null = absent at baseline. Unset for 'unmanaged'. */
  expectedContent?: string | null;
  /** Rename/copy only: baseline content for `originalPath` when that side is claimed. */
  expectedOriginalContent?: string | null;
}

/** Builds an all-unmanaged plan set — the `--to-upstream` (legacy) shape. */
export function planUpstreamDiscards(entries: readonly GitStatusEntry[]): DiscardBaselinePlan[] {
  return entries.map((entry) => ({ entry, kind: 'unmanaged', owners: [], conflicted: false }));
}

/**
 * Plans the restore target for each status entry. Entries claimed by the
 * patch manifest restore to the patch-applied baseline; unclaimed entries
 * keep the legacy git mechanics. A missing patches dir or empty manifest
 * degrades every plan to `unmanaged` (identical to pre-0.39.0 behavior).
 *
 * A corrupt manifest or an unreconstructible patch baseline REFUSES with a
 * GeneralError naming `--to-upstream` — silently falling back to pristine
 * HEAD is exactly the data-loss path this module exists to close.
 */
export async function planDiscardBaselines(
  patchesDir: string,
  engineDir: string,
  entries: readonly GitStatusEntry[]
): Promise<DiscardBaselinePlan[]> {
  const state = await loadPatchesManifestState(patchesDir);
  if (state.exists && state.parseError) {
    throw new GeneralError(
      'patches/patches.json is unreadable — refusing to discard while patch ownership cannot be ' +
        'determined. Fix the manifest, or pass --to-upstream to explicitly revert to pristine ' +
        'upstream (HEAD).'
    );
  }
  const claims = state.manifest
    ? buildPatchClaims(state.manifest.patches)
    : new Map<string, string[]>();

  const plans: DiscardBaselinePlan[] = [];
  const claimedEntries = entries.filter(
    (entry) =>
      claims.has(entry.file) || (entry.originalPath !== undefined && claims.has(entry.originalPath))
  );
  if (claimedEntries.length === 0) {
    return planUpstreamDiscards(entries);
  }

  const { computePatched } = await createPatchedContentContext(patchesDir, engineDir);
  const claimedFiles = [
    ...new Set(
      claimedEntries.flatMap((entry) =>
        entry.originalPath !== undefined ? [entry.file, entry.originalPath] : [entry.file]
      )
    ),
  ];
  const trackedInHead = await listTrackedInHead(engineDir, claimedFiles);

  const computeExpected = async (path: string): Promise<string | null> => {
    try {
      return await computePatched(path);
    } catch (error: unknown) {
      throw new GeneralError(
        `Cannot reconstruct the patch baseline for ${path} (${toError(error).message}). ` +
          'Fix the owning patch, or pass --to-upstream to explicitly revert to pristine ' +
          'upstream (HEAD).'
      );
    }
  };

  // `computePatchedContent` folds a deletion into an empty string (an
  // apply-to-content limitation), which is indistinguishable from a
  // legitimately empty file. Consult the owning patches' diff sections
  // directly: the LAST section (highest-ordered owner) naming the path
  // decides whether the baseline is "absent".
  const sectionCache = new Map<string, DiffSection[]>();
  const isDeletedAtBaseline = async (path: string, owners: string[]): Promise<boolean> => {
    for (let i = owners.length - 1; i >= 0; i--) {
      const owner = owners[i];
      if (owner === undefined) continue;
      let sections = sectionCache.get(owner);
      if (!sections) {
        try {
          sections = parseDiffSections(await readText(join(patchesDir, owner)));
        } catch (error: unknown) {
          // Fail closed. Swallowing this yielded no sections, which falls
          // through to `return false` — "not deleted at baseline" — so a path
          // the owning patch DELETES would be restored as present, i.e.
          // rewritten instead of removed: silent data loss on the command
          // whose header promises a refusal for exactly this class of failure.
          //
          // In the current flow `computeExpected` above reads the same patch
          // first and refuses, so this is defence-in-depth against a TOCTOU
          // (the patch file removed or made unreadable mid-plan) rather than a
          // reachable branch today. It refuses with the same remediation as
          // its sibling so the two cannot drift into disagreeing.
          throw new GeneralError(
            `Cannot read the owning patch ${owner} to determine the baseline for ${path} ` +
              `(${toError(error).message}). ` +
              'Fix the owning patch, or pass --to-upstream to explicitly revert to pristine ' +
              'upstream (HEAD).'
          );
        }
        sectionCache.set(owner, sections);
      }
      for (const section of sections) {
        if (section.targetPath === path || section.sourcePath === path) {
          return section.isDeletedFile;
        }
      }
    }
    return false;
  };

  for (const entry of entries) {
    const owners = [
      ...new Set([
        ...(claims.get(entry.file) ?? []),
        ...(entry.originalPath !== undefined ? (claims.get(entry.originalPath) ?? []) : []),
      ]),
    ];
    if (owners.length === 0) {
      plans.push({ entry, kind: 'unmanaged', owners, conflicted: false });
      continue;
    }

    let expectedContent = claims.has(entry.file) ? await computeExpected(entry.file) : null;
    if (
      expectedContent !== null &&
      (await isDeletedAtBaseline(entry.file, claims.get(entry.file) ?? []))
    ) {
      expectedContent = null;
    }
    const expectedOriginalContent =
      entry.originalPath !== undefined && claims.has(entry.originalPath)
        ? await computeExpected(entry.originalPath)
        : undefined;

    const kind: DiscardKind =
      expectedContent === null
        ? 'patch-deleted'
        : trackedInHead.has(entry.file)
          ? 'patch-backed'
          : 'patch-created';

    plans.push({
      entry,
      kind,
      owners,
      conflicted: owners.length > 1,
      expectedContent,
      ...(expectedOriginalContent !== undefined ? { expectedOriginalContent } : {}),
    });
  }
  return plans;
}

/**
 * Applies one restore plan. Patch-claimed paths end up exactly as `import`
 * leaves them: patched content as an unstaged worktree state (tracked files
 * read ` M`, created files `??`), nothing staged. Unmanaged plans delegate
 * to the legacy {@link discardStatusEntry} mechanics.
 */
export async function applyDiscardBaseline(
  engineDir: string,
  plan: DiscardBaselinePlan
): Promise<void> {
  if (plan.kind === 'unmanaged') {
    await discardStatusEntry(engineDir, plan.entry);
    return;
  }

  const { entry } = plan;
  // Drop any staged edits/adds/renames first so the rewritten content is a
  // plain worktree state (harmless when nothing is staged; skipped for
  // purely-untracked entries which have no index footprint).
  if (!entry.isUntracked) {
    const indexPaths =
      entry.originalPath !== undefined ? [entry.file, entry.originalPath] : [entry.file];
    await unstageFiles(engineDir, indexPaths);
  }

  if (plan.expectedContent === null || plan.expectedContent === undefined) {
    await removeFile(join(engineDir, entry.file));
  } else {
    await writeText(join(engineDir, entry.file), plan.expectedContent);
  }

  // A rename/copy's original side restores to ITS baseline too: the patch
  // baseline when claimed, else the legacy HEAD restore (matching what
  // discardStatusEntry does for that side).
  if (entry.originalPath !== undefined) {
    if (plan.expectedOriginalContent !== undefined) {
      if (plan.expectedOriginalContent === null) {
        await removeFile(join(engineDir, entry.originalPath));
      } else {
        await writeText(join(engineDir, entry.originalPath), plan.expectedOriginalContent);
      }
    } else if (await fileExistsInHead(engineDir, entry.originalPath)) {
      await restoreTrackedPath(engineDir, entry.originalPath);
    }
  }
}

/** One-line annotation for dry-run listings and confirmation summaries. */
export function describeDiscardBaseline(plan: DiscardBaselinePlan): string {
  const owners = plan.owners.join(' + ');
  switch (plan.kind) {
    case 'unmanaged':
      return plan.entry.isUntracked ? 'unmanaged — delete' : 'unmanaged — revert to upstream';
    case 'patch-backed':
      return `patch baseline: ${owners}${plan.conflicted ? ' (conflict)' : ''}`;
    case 'patch-created':
      return `re-materialize from ${owners}${plan.conflicted ? ' (conflict)' : ''}`;
    case 'patch-deleted':
      return `delete — ${owners} removes it`;
  }
}

/** Single-file outro naming the baseline that was restored. */
export function describeDiscardOutcome(plan: DiscardBaselinePlan, toUpstream: boolean): string {
  if (toUpstream) return 'File restored to pristine upstream (HEAD)';
  const owners = plan.owners.join(' + ');
  switch (plan.kind) {
    case 'unmanaged':
      return 'File restored to original state';
    case 'patch-backed':
      return `File restored to patch baseline (${owners})`;
    case 'patch-created':
      return `File re-materialized from patch baseline (${owners})`;
    case 'patch-deleted':
      return `File removed to match patch baseline (${owners} deletes it)`;
  }
}

/** Batch outro summarising how many files restored to which baseline. */
export function summarizeDiscardBaselines(
  plans: readonly DiscardBaselinePlan[],
  succeeded: number
): string {
  const patchBacked = plans.filter((p) => p.kind === 'patch-backed').length;
  const created = plans.filter((p) => p.kind === 'patch-created').length;
  const deleted = plans.filter((p) => p.kind === 'patch-deleted').length;
  const unmanaged = plans.filter((p) => p.kind === 'unmanaged').length;
  if (patchBacked + created + deleted === 0) {
    return `${String(succeeded)} file(s) restored to upstream state`;
  }
  const parts: string[] = [];
  if (patchBacked > 0) parts.push(`${String(patchBacked)} to patch baseline`);
  if (created > 0) parts.push(`${String(created)} re-materialized`);
  if (deleted > 0) parts.push(`${String(deleted)} removed per patch baseline`);
  if (unmanaged > 0) parts.push(`${String(unmanaged)} to upstream state`);
  return `${String(succeeded)} file(s) restored: ${parts.join(', ')}`;
}

/** Warn text for a multi-owner (conflicted) restore. */
export function describeConflictWarning(plan: DiscardBaselinePlan): string {
  return (
    `${plan.entry.file} is claimed by ${String(plan.owners.length)} patches ` +
    `(${plan.owners.join(', ')}). Restored the cumulative baseline; run ` +
    '"fireforge status --ownership" to resolve ownership.'
  );
}
