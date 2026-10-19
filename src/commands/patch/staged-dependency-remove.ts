// SPDX-License-Identifier: EUPL-1.2
/**
 * `--remove` target selection for `patch staged-dependency`. Split out of
 * `staged-dependency.ts` for the per-file line budget.
 *
 * A removal names its entries by any of `--file`, `--specifier`/`--line`,
 * `--creates` and `--owner`, and must give at least `--creates` or the
 * `--file` + matcher pair. Registration lines compare whitespace-
 * insensitively (runs of whitespace collapse, ends trimmed), the way the
 * lint compares them, so a line copied from a patch hunk matches the stored
 * one whatever its padding. A selection that matches nothing is refused
 * rather than reported as a no-op.
 */

import { GeneralError, InvalidArgumentError } from '../../errors/base.js';
import type {
  PatchStagedDependencies,
  PatchStagedDependencyOptions,
} from '../../types/commands/index.js';
import { info } from '../../utils/logger.js';
import {
  dependencyLabel,
  importView,
  registrationView,
  type StagedDependencyKind,
  type StagedEntryView,
} from './staged-dependency-entries.js';

/** Collapses whitespace runs and trims, for registration-line comparison. */
function normalizeRegistrationLine(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

function stagedViews(
  kind: StagedDependencyKind,
  staged: PatchStagedDependencies | undefined
): StagedEntryView[] {
  return kind === 'import'
    ? (staged?.forwardImports ?? []).map(importView)
    : (staged?.registrations ?? []).map(registrationView);
}

/**
 * Resolves the staged entries a `--remove` invocation names. The returned
 * views are the stored entries themselves, so the removal matches them
 * exactly.
 *
 * - `--file` + matcher identifying one entry infers `--creates`.
 * - `--file` + matcher identifying several entries without `--creates`
 *   refuses with the candidate list.
 * - `--creates` alone selects every declaration for that created path.
 *
 * @param kind - Declaration kind (`--kind`)
 * @param options - Command options
 * @param staged - The target patch's current staged dependencies
 * @returns The matching stored entries (never empty)
 * @throws InvalidArgumentError when the selectors are insufficient or match nothing
 */
export function selectRemovalEntries(
  kind: StagedDependencyKind,
  options: PatchStagedDependencyOptions,
  staged: PatchStagedDependencies | undefined
): StagedEntryView[] {
  const matcherFlag = kind === 'import' ? '--specifier' : '--line';
  const matcher = kind === 'import' ? options.specifier : options.line;
  const hasPair = Boolean(options.file) && Boolean(matcher);
  if (!options.creates && !hasPair) {
    throw new InvalidArgumentError(
      `--remove${kind === 'registration' ? ' --kind registration' : ''} requires --creates, ` +
        `or --file with ${matcherFlag}; --creates alone removes every declaration for that path.`,
      matcher && !options.file
        ? '--file'
        : options.file && !matcher
          ? matcherFlag
          : `--creates or --file + ${matcherFlag}`
    );
  }

  const wanted = matcher === undefined ? undefined : comparableMatcher(kind, matcher);
  const views = stagedViews(kind, staged);
  const candidates = views.filter(
    (view) =>
      (!options.file || view.file === options.file) &&
      (wanted === undefined || comparableMatcher(kind, view.matcher) === wanted) &&
      (!options.creates || view.creates === options.creates) &&
      (options.owner === undefined || view.owner === options.owner)
  );

  if (candidates.length === 0) {
    const noun = kind === 'import' ? 'staged forward-import' : 'staged registration';
    const existing =
      views.length === 0
        ? `This patch has no ${noun}s.`
        : `This patch's ${noun}s:\n${views.map((view) => `  - ${dependencyLabel(kind, view)}`).join('\n')}`;
    throw new InvalidArgumentError(`--remove matched no ${noun}. ${existing}`, '--remove');
  }
  if (candidates.length > 1 && !options.creates) {
    const list = candidates.map((view) => `  - ${dependencyLabel(kind, view)}`).join('\n');
    const noun = kind === 'import' ? 'staged forward-imports' : 'staged registrations';
    throw new GeneralError(
      `--remove matches ${candidates.length} ${noun} on this patch; pass --creates to pick one:\n${list}`
    );
  }
  const single = candidates.length === 1 ? candidates[0] : undefined;
  if (single !== undefined && !options.creates) {
    info(`Inferred --creates ${single.creates} from the single matching staged entry.`);
  }
  return candidates;
}

function comparableMatcher(kind: StagedDependencyKind, matcher: string): string {
  return kind === 'registration' ? normalizeRegistrationLine(matcher) : matcher;
}
