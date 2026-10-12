// SPDX-License-Identifier: EUPL-1.2
/**
 * `verify --patches <list>`: judges only the named patches' findings. Split
 * out of verify.ts so the per-group attribution rules sit in one place.
 *
 * A finding is in scope when it names a scoped patch: a manifest or policy
 * issue by its filename, a cross-patch claim or lint issue by any patch it
 * implicates, a drifted file by its owning patch, a dangling registration
 * by the patch that registers it. Findings about the queue as a whole (a
 * manifest that does not parse) are kept, because no patch can be judged
 * past them. Unowned worktree changes belong to no patch and drop out.
 */
import { loadPatchesManifest } from '../core/patch-manifest.js';
import { selectPatchSubset } from '../core/patch-subset.js';
import { GeneralError } from '../errors/base.js';
import type { PatchLintIssue, PatchMetadata } from '../types/commands/index.js';

/** The resolved scope: manifest filenames, and every path they claim. */
export interface VerifyScope {
  patches: ReadonlySet<string>;
  files: ReadonlySet<string>;
}

/**
 * Resolves raw `--patches` values against the manifest. Returns undefined
 * when the flag was not given and refuses a name that matches no patch.
 *
 * @param patchesDir - Absolute path to the patches directory
 * @param requested - Raw `--patches` values (each may be a comma list)
 */
export async function resolveVerifyScope(
  patchesDir: string,
  requested: readonly string[] | undefined
): Promise<VerifyScope | undefined> {
  if (requested === undefined || requested.length === 0) return undefined;
  const manifest = await loadPatchesManifest(patchesDir);
  if (!manifest || manifest.patches.length === 0) {
    throw new GeneralError('--patches needs a patch queue, but patches.json lists no patches.');
  }
  const subset = selectPatchSubset(
    manifest,
    requested,
    '--patches selects patches (filename, stem, order number, manifest name, or slug).'
  );
  return {
    patches: new Set(subset.map((patch) => patch.filename)),
    files: new Set(subset.flatMap((patch) => patch.filesAffected)),
  };
}

/**
 * True when a filename-keyed finding (manifest consistency, policy) is in
 * scope: it names a scoped patch, or it names no patch at all.
 */
export function isFilenameInScope(scope: VerifyScope | undefined, filename: string): boolean {
  if (scope === undefined) return true;
  return scope.patches.has(filename) || !filename.endsWith('.patch');
}

/** True when any of the implicated patches is in scope. */
export function anyPatchInScope(
  scope: VerifyScope | undefined,
  filenames: readonly string[]
): boolean {
  if (scope === undefined) return true;
  return filenames.some((filename) => scope.patches.has(filename));
}

/**
 * Keeps the lint issues that implicate a scoped patch. An issue without a
 * `patches` list is attributed through its file instead.
 */
export function scopeLintIssues(
  issues: PatchLintIssue[],
  scope: VerifyScope | undefined
): PatchLintIssue[] {
  if (scope === undefined) return issues;
  return issues.filter((issue) =>
    issue.patches !== undefined && issue.patches.length > 0
      ? anyPatchInScope(scope, issue.patches)
      : scope.files.has(issue.file)
  );
}

/** Keeps the manifest rows in scope. No scope keeps all. */
export function scopePatches<T extends Pick<PatchMetadata, 'filename'>>(
  patches: readonly T[],
  scope: VerifyScope | undefined
): T[] {
  if (scope === undefined) return [...patches];
  return patches.filter((patch) => scope.patches.has(patch.filename));
}
