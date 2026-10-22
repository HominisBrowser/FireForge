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
 * an entry with the same file, matcher, creates and owner exists. A
 * matching entry whose `reason` differs from the addition's takes
 * the new reason in place, keeping its position in the list; an addition
 * without a reason leaves the existing one alone.
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

  if (addition === undefined) return [...existing];
  const key = dependencyKey(target);
  const index = existing.findIndex((entry) => dependencyKey(toView(entry)) === key);
  if (index === -1) return [...existing, addition];
  const current = existing[index] as T;
  if (target.reason === undefined || toView(current).reason === target.reason) {
    return [...existing];
  }
  const next = [...existing];
  next[index] = addition;
  return next;
}

/**
 * Number of declarations in `after` whose key matches one in `before` but
 * whose `reason` differs: the in-place reason updates of an `--add`.
 */
export function countReasonUpdates(
  before: PatchStagedDependencies | undefined,
  after: PatchStagedDependencies | undefined
): number {
  const updates = <T>(
    left: readonly T[] | undefined,
    right: readonly T[] | undefined,
    toView: (entry: T) => StagedEntryView
  ): number => {
    const reasons = new Map(
      (left ?? []).map((entry) => [dependencyKey(toView(entry)), toView(entry).reason])
    );
    return (right ?? []).filter((entry) => {
      const view = toView(entry);
      const key = dependencyKey(view);
      return reasons.has(key) && reasons.get(key) !== view.reason;
    }).length;
  };
  return (
    updates(before?.forwardImports, after?.forwardImports, importView) +
    updates(before?.registrations, after?.registrations, registrationView)
  );
}

/** Number of declarations of both kinds. */
export function countStagedEntries(staged: PatchStagedDependencies | undefined): number {
  return (staged?.forwardImports?.length ?? 0) + (staged?.registrations?.length ?? 0);
}
