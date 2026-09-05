// SPDX-License-Identifier: EUPL-1.2
/**
 * Validation of `--kind registration` staged-dependency declarations.
 *
 * Split out of `patch-lint-cross.ts` to keep that file inside the per-file
 * line budget, and because the forward-registration rule needs the same
 * apply-order predicate: two spellings of "later in the queue" would let the
 * rule that flags an undeclared registration and the rule that validates a
 * declared one disagree about the very same pair of patches.
 *
 * Exports helpers consumed by `patch-lint-cross.ts` and
 * `patch-lint-forward-registration.ts`, with no registrar or rule of its own.
 */
import { basename } from 'node:path';

import type { PatchStagedRegistration } from '../types/commands/index.js';

/** A patch that creates a given path, with its position in the queue. */
export interface NewFileOwner {
  filename: string;
  order: number;
  fullPath: string;
}

/** The ordering fields `isLaterOwner` compares an owner against. */
export interface QueuePosition {
  filename: string;
  order: number;
}

/**
 * Later-in-apply-order predicate shared by the forward-import scan, the
 * forward-registration rule and the registration validation: strictly
 * higher ordinal, or same ordinal with a lexicographically later filename
 * (the apply loop's tiebreak).
 *
 * @param owner - The creating patch
 * @param entry - The referencing patch
 * @returns True when `owner` applies after `entry`
 */
export function isLaterOwner(owner: QueuePosition, entry: QueuePosition): boolean {
  return (
    owner.order > entry.order || (owner.order === entry.order && owner.filename > entry.filename)
  );
}

/** The slice of a queue entry the registration validation reads. */
export interface StagedRegistrationEntry extends QueuePosition {
  newFiles: ReadonlyMap<string, string>;
  modifiedFileAdditions: ReadonlyMap<string, string>;
}

/** Why a staged registration declaration failed validation. */
export type StagedRegistrationFailure =
  | { kind: 'line-absent' }
  | { kind: 'creates-unresolved' }
  | { kind: 'owner-mismatch'; creators: readonly NewFileOwner[] };

/**
 * Validates one registration-kind declaration against the patch content
 * and the queue, mirroring {@link findMatchingStagedDependency}: the
 * declared line must be added by this patch, `creates` must exactly match
 * a file a later-ordered patch creates (an earlier-only creator means the
 * dependency is already satisfied and the declaration is stale), and
 * `owner`, when set, must name one of those creating patches. Returns
 * undefined when valid.
 */
export function findStagedRegistrationFailure(
  entry: StagedRegistrationEntry,
  registration: PatchStagedRegistration,
  createdFileIndex: Map<string, NewFileOwner[]>
): StagedRegistrationFailure | undefined {
  if (!isRegistrationLinePresent(entry, registration)) return { kind: 'line-absent' };
  const creators = (createdFileIndex.get(basename(registration.creates)) ?? []).filter(
    (owner) => owner.fullPath === registration.creates && isLaterOwner(owner, entry)
  );
  if (creators.length === 0) return { kind: 'creates-unresolved' };
  if (
    registration.owner !== undefined &&
    !creators.some((owner) => owner.filename === registration.owner)
  ) {
    return { kind: 'owner-mismatch', creators };
  }
  return undefined;
}

/** Message tail for each {@link StagedRegistrationFailure} shape. */
export function describeRegistrationFailure(failure: StagedRegistrationFailure): string {
  switch (failure.kind) {
    case 'line-absent':
      return 'the patch does not add that line.';
    case 'creates-unresolved':
      return (
        'no later-ordered patch creates that file — the declaration is stale, ' +
        'or the queue order no longer stages it.'
      );
    case 'owner-mismatch':
      return `that file is created by ${failure.creators.map((o) => o.filename).join(', ')}, not the declared owner.`;
  }
}

/**
 * True when the declared registration/packaging line appears (trimmed)
 * among the lines the patch introduces in the declaring file, either as a
 * newly-created file's content or as added lines to an existing file
 * (where jar.mn / customElements.js / actor-registration edits land).
 */
function isRegistrationLinePresent(
  entry: StagedRegistrationEntry,
  registration: PatchStagedRegistration
): boolean {
  const declared = registration.line.trim();
  if (declared.length === 0) return false;
  const introduced = [
    entry.newFiles.get(registration.file),
    entry.modifiedFileAdditions.get(registration.file),
  ];
  return introduced.some(
    (content) =>
      content !== undefined && content.split('\n').some((line) => line.trim() === declared)
  );
}

/**
 * Renders `line` for the `--line "…"` argument of a paste-and-run
 * `patch staged-dependency` command.
 *
 * A registration line is quoted for the shell in the messages that print
 * the command, and a `support-files` element carries its own quotes
 * (`"file_tiles_find.html",` is what a multi-line TOML array adds). Without
 * escaping, the shell would eat them and the declaration would be written
 * with a line the patch never adds, the exact mismatch that made the
 * forward-registration remedy leave the declaring patch red.
 */
export function quoteRegistrationLine(line: string): string {
  return line.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
