// SPDX-License-Identifier: EUPL-1.2
/**
 * Staged-dependency upkeep for `patch split` and `patch move-files
 * --create`: the declarations a file move invalidates.
 *
 * Moving files into a new patch changes three kinds of declaration:
 *
 *  - an `owner` that named the source for a `creates` path that moved now
 *    names the new patch (both kinds, see {@link rewriteSplitOwners});
 *  - a declaration the source holds for a site in a moved file belongs to
 *    the new patch, because the importing or registering line moved with
 *    the file ({@link relocatedSourceDeclarations});
 *  - a declaration that was in use before the move and is not after it
 *    (the new patch now applies before the importer, or the importer and
 *    the imported file landed in one patch) is dropped
 *    ({@link findDeclarationsMadeUnused}).
 *
 * Without this the move would write the bodies and leave the queue audit
 * and the per-patch lint to report `queue-dependency-creates-unowned` and
 * `staged-dependency-unused` afterwards, one `--remove`/`--add` pair per
 * entry to repair by hand.
 */

import type { PatchQueueEntry } from '../../core/patch-lint.js';
import { stagedDependencyUnusedFingerprint } from '../../core/patch-lint-staged-registration.js';
import type {
  PatchLintIssue,
  PatchMetadata,
  PatchStagedDependencies,
  PatchStagedForwardImport,
  PatchStagedRegistration,
} from '../../types/commands/index.js';

/** One declaration of either kind. */
export type StagedDeclaration = PatchStagedForwardImport | PatchStagedRegistration;

/** A declaration the move made unused, named by its post-move holder. */
export interface DroppedStagedDeclaration {
  /** Holder patch filename after the move (and any renumber). */
  holder: string;
  /** The declaration as the projected queue holds it. */
  declaration: StagedDeclaration;
}

/** Declaration changes a split or `move-files --create` commits. */
export interface SplitStagedMaintenance {
  /** Source declarations whose declaring file moved, re-homed on the new patch. */
  relocated: PatchStagedDependencies;
  /** Declarations in use before the move and unused after it. */
  dropped: DroppedStagedDeclaration[];
}

/** An empty maintenance plan. */
export function emptyStagedMaintenance(): SplitStagedMaintenance {
  return { relocated: {}, dropped: [] };
}

function declarationsOf(staged: PatchStagedDependencies | undefined): StagedDeclaration[] {
  return [...(staged?.forwardImports ?? []), ...(staged?.registrations ?? [])];
}

function matcherOf(declaration: StagedDeclaration): string {
  return 'specifier' in declaration ? `i:${declaration.specifier}` : `r:${declaration.line}`;
}

/** Identity of a declaration, owner included. */
function declarationKey(declaration: StagedDeclaration): string {
  return [
    declaration.file,
    matcherOf(declaration),
    declaration.creates,
    declaration.owner ?? '',
  ].join('\0');
}

/** Identity without the owner, which a renumber or split may rewrite. */
function declarationSiteKey(declaration: StagedDeclaration): string {
  return [declaration.file, matcherOf(declaration), declaration.creates].join('\0');
}

function rebuildStaged(
  staged: PatchStagedDependencies | undefined,
  keep: (declaration: StagedDeclaration) => boolean,
  rewrite: (declaration: StagedDeclaration) => StagedDeclaration = (declaration) => declaration
): PatchStagedDependencies {
  const forwardImports = (staged?.forwardImports ?? [])
    .filter(keep)
    .map((entry) => rewrite(entry) as PatchStagedForwardImport);
  const registrations = (staged?.registrations ?? [])
    .filter(keep)
    .map((entry) => rewrite(entry) as PatchStagedRegistration);
  return {
    ...(forwardImports.length > 0 ? { forwardImports } : {}),
    ...(registrations.length > 0 ? { registrations } : {}),
  };
}

function hasDeclarations(staged: PatchStagedDependencies): boolean {
  return declarationsOf(staged).length > 0;
}

/** Writes `staged` onto `patch`, dropping the field when it is empty. */
function withStaged(patch: PatchMetadata, staged: PatchStagedDependencies): PatchMetadata {
  if (hasDeclarations(staged)) return { ...patch, stagedDependencies: staged };
  if (patch.stagedDependencies === undefined) return patch;
  const rest = { ...patch };
  delete rest.stagedDependencies;
  return rest;
}

/**
 * The source's declarations whose declaring file moves, with owners passed
 * through `ownerLookup` (the renumber the placement implies).
 *
 * @param source - The source patch's current manifest row
 * @param movedSet - Files moving to the new patch
 * @param ownerLookup - Old → new filename for renumbered patches
 */
export function relocatedSourceDeclarations(
  source: PatchMetadata,
  movedSet: ReadonlySet<string>,
  ownerLookup: (oldFilename: string) => string | undefined
): PatchStagedDependencies {
  return rebuildStaged(
    source.stagedDependencies,
    (declaration) => movedSet.has(declaration.file),
    (declaration) => {
      const owner = declaration.owner === undefined ? undefined : ownerLookup(declaration.owner);
      return owner === undefined ? { ...declaration } : { ...declaration, owner };
    }
  );
}

/**
 * Removes from the source row the declarations whose declaring file moved
 * (they are re-homed on the new patch).
 */
export function withoutRelocatedDeclarations(
  source: PatchMetadata,
  movedSet: ReadonlySet<string>
): PatchMetadata {
  if (!declarationsOf(source.stagedDependencies).some((d) => movedSet.has(d.file))) return source;
  return withStaged(
    source,
    rebuildStaged(source.stagedDependencies, (declaration) => !movedSet.has(declaration.file))
  );
}

/**
 * Re-points `owner` from the source to the new patch on every declaration
 * (forward-import and registration alike) whose `creates` path moved.
 */
export function rewriteSplitOwners(
  patch: PatchMetadata,
  sourceFilename: string,
  movedSet: ReadonlySet<string>,
  newFilename: string
): PatchMetadata {
  const matches = (declaration: StagedDeclaration): boolean =>
    declaration.owner === sourceFilename && movedSet.has(declaration.creates);
  if (!declarationsOf(patch.stagedDependencies).some(matches)) return patch;
  return {
    ...patch,
    stagedDependencies: {
      ...patch.stagedDependencies,
      ...rebuildStaged(
        patch.stagedDependencies,
        () => true,
        (declaration) =>
          matches(declaration) ? { ...declaration, owner: newFilename } : declaration
      ),
    },
  };
}

/**
 * Finds patches holding a declaration (either kind) whose `owner` is the
 * source patch and whose `creates` path moves to the new patch.
 */
export function findOwnerRewriteHolders(
  patches: readonly PatchMetadata[],
  sourceFilename: string,
  movedSet: ReadonlySet<string>
): string[] {
  return patches
    .filter((patch) =>
      declarationsOf(patch.stagedDependencies).some(
        (declaration) => declaration.owner === sourceFilename && movedSet.has(declaration.creates)
      )
    )
    .map((patch) => patch.filename);
}

/** Inputs to {@link findDeclarationsMadeUnused}. */
export interface MadeUnusedInput {
  /** Queue entries before the move. */
  baselineEntries: readonly PatchQueueEntry[];
  /** Queue entries after the move, relocations and owner rewrites applied. */
  projectedEntries: readonly PatchQueueEntry[];
  /** Every finding of the baseline queue lint (all severities). */
  baselineIssues: readonly PatchLintIssue[];
  /** Every finding of the projected queue lint (all severities). */
  projectedIssues: readonly PatchLintIssue[];
  /** Source patch filename before the move. */
  sourceFilename: string;
  /** The new patch's filename. */
  newFilename: string;
  /** Projected → pre-move filename for renumbered patches. */
  mapBack: (projectedFilename: string) => string;
  /** Files moving to the new patch. */
  movedSet: ReadonlySet<string>;
}

/**
 * Declarations the projected queue reports `staged-dependency-unused` for
 * that the baseline queue did not: the ones the move itself made unused.
 * Only declarations the move touches are candidates (their `creates` path
 * moved, or they were re-homed on the new patch), so pre-existing stale
 * declarations elsewhere are left for the operator.
 */
export function findDeclarationsMadeUnused(input: MadeUnusedInput): DroppedStagedDeclaration[] {
  const unusedFingerprints = (issues: readonly PatchLintIssue[]): Set<string> =>
    new Set(
      issues
        .filter((issue) => issue.check === 'staged-dependency-unused')
        .map((issue) => issue.fingerprint ?? '')
    );
  const baselineUnused = unusedFingerprints(input.baselineIssues);
  const projectedUnused = unusedFingerprints(input.projectedIssues);
  const baselineByHolder = new Map(
    input.baselineEntries.map((entry) => [entry.filename, entry.metadata] as const)
  );

  const dropped: DroppedStagedDeclaration[] = [];
  for (const entry of input.projectedEntries) {
    const isNewPatch = entry.filename === input.newFilename;
    for (const declaration of declarationsOf(entry.metadata?.stagedDependencies)) {
      if (!isNewPatch && !input.movedSet.has(declaration.creates)) continue;
      if (!projectedUnused.has(stagedDependencyUnusedFingerprint(entry.filename, declaration))) {
        continue;
      }
      const originalHolder = isNewPatch ? input.sourceFilename : input.mapBack(entry.filename);
      const original = declarationsOf(
        baselineByHolder.get(originalHolder)?.stagedDependencies
      ).find((candidate) => declarationSiteKey(candidate) === declarationSiteKey(declaration));
      if (
        original !== undefined &&
        baselineUnused.has(stagedDependencyUnusedFingerprint(originalHolder, original))
      ) {
        continue;
      }
      dropped.push({ holder: entry.filename, declaration });
    }
  }
  return dropped;
}

/**
 * Removes the dropped declarations held by `patch` (matched by its
 * post-move filename and the declaration's projected identity).
 */
export function withoutDroppedDeclarations(
  patch: PatchMetadata,
  dropped: readonly DroppedStagedDeclaration[]
): PatchMetadata {
  const keys = new Set(
    dropped
      .filter((entry) => entry.holder === patch.filename)
      .map((entry) => declarationKey(entry.declaration))
  );
  if (keys.size === 0) return patch;
  return withStaged(
    patch,
    rebuildStaged(patch.stagedDependencies, (declaration) => !keys.has(declarationKey(declaration)))
  );
}

/** The relocated declarations the new patch keeps (relocated minus dropped). */
export function keptRelocatedDeclarations(
  maintenance: SplitStagedMaintenance,
  newFilename: string
): PatchStagedDependencies {
  const keys = new Set(
    maintenance.dropped
      .filter((entry) => entry.holder === newFilename)
      .map((entry) => declarationKey(entry.declaration))
  );
  return rebuildStaged(
    maintenance.relocated,
    (declaration) => !keys.has(declarationKey(declaration))
  );
}

function describeDeclaration(declaration: StagedDeclaration): string {
  return 'specifier' in declaration
    ? `${declaration.file} imports "${declaration.specifier}" (${declaration.creates})`
    : `${declaration.file} registers "${declaration.line}" (${declaration.creates})`;
}

/**
 * Operator-facing lines naming every declaration the move re-homes or
 * drops. Empty when the move touches no declaration.
 *
 * @param maintenance - The planned changes
 * @param sourceFilename - Source patch filename
 * @param newFilename - The new patch's filename
 */
export function describeStagedMaintenance(
  maintenance: SplitStagedMaintenance,
  sourceFilename: string,
  newFilename: string
): string[] {
  const lines: string[] = [];
  const kept = declarationsOf(keptRelocatedDeclarations(maintenance, newFilename));
  if (kept.length > 0) {
    lines.push(
      `staged-dependency declarations moved from ${sourceFilename} to ${newFilename} (${kept.length}):`
    );
    for (const declaration of kept) lines.push(`  ${describeDeclaration(declaration)}`);
  }
  if (maintenance.dropped.length > 0) {
    lines.push(
      `staged-dependency declarations dropped because the move made them unused (${maintenance.dropped.length}):`
    );
    for (const { holder, declaration } of maintenance.dropped) {
      const shownHolder = holder === newFilename ? `${sourceFilename} → ${newFilename}` : holder;
      lines.push(`  ${shownHolder}: ${describeDeclaration(declaration)}`);
    }
  }
  return lines;
}
