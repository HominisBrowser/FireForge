// SPDX-License-Identifier: EUPL-1.2
/**
 * Kind-neutral views and list operations over staged-dependency
 * declarations, shared by `patch staged-dependency` and its `--from` batch
 * path. Split out of `staged-dependency.ts` for the per-file line budget.
 */

import type {
  PatchStagedDependencies,
  PatchStagedForwardImport,
  PatchStagedRegistration,
} from '../../types/commands/index.js';

/** The command's mutation mode. */
export type StagedDependencyMode = 'add' | 'remove' | 'clear';
/** The declaration shape (`--kind`). */
export type StagedDependencyKind = 'import' | 'registration';

/**
 * One staged-dependency entry of either kind. The `matcher` field is the
 * kind-specific middle term: the import specifier for import entries, the
 * registration line for registration entries. Key/removal/label logic is
 * shared across kinds through this shape.
 */
export interface StagedEntryView {
  file: string;
  matcher: string;
  creates: string;
  owner?: string;
  reason?: string;
}

/** View of an import declaration. */
export function importView(dependency: PatchStagedForwardImport): StagedEntryView {
  return { ...dependency, matcher: dependency.specifier };
}

/** View of a registration declaration. */
export function registrationView(dependency: PatchStagedRegistration): StagedEntryView {
  return { ...dependency, matcher: dependency.line };
}

function dependencyKey(view: StagedEntryView): string {
  return [view.file, view.matcher, view.creates, view.owner ?? ''].join('\0');
}

/** One-line operator label for a declaration. */
export function dependencyLabel(kind: StagedDependencyKind, view: StagedEntryView): string {
  const owner = view.owner ? ` owner=${view.owner}` : '';
  const reason = view.reason ? ` reason="${view.reason}"` : '';
  if (kind === 'import') {
    return `${view.file} imports "${view.matcher}" from ${view.creates}${owner}${reason}`;
  }
  return `${view.file} registers "${view.matcher}" for ${view.creates}${owner}${reason}`;
}

function matchesTarget(view: StagedEntryView, target: StagedEntryView): boolean {
  return (
    view.file === target.file &&
    view.matcher === target.matcher &&
    view.creates === target.creates &&
    (target.owner === undefined || view.owner === target.owner)
  );
}

/**
 * Applies one add/remove/clear to a declaration list: `add` appends unless
 * an entry with the same file, matcher, creates and owner exists.
 */
export function applyMode<T>(
  existing: readonly T[],
  mode: StagedDependencyMode,
  target: StagedEntryView | undefined,
  toView: (entry: T) => StagedEntryView,
  addition: T | undefined
): T[] {
  if (mode === 'clear') return [];
  if (!target) return [...existing];
  if (mode === 'remove') return existing.filter((entry) => !matchesTarget(toView(entry), target));

  const seen = new Set(existing.map((entry) => dependencyKey(toView(entry))));
  if (seen.has(dependencyKey(target)) || addition === undefined) return [...existing];
  return [...existing, addition];
}

/** Number of declarations of both kinds. */
export function countStagedEntries(staged: PatchStagedDependencies | undefined): number {
  return (staged?.forwardImports?.length ?? 0) + (staged?.registrations?.length ?? 0);
}
