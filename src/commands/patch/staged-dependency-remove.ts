// SPDX-License-Identifier: EUPL-1.2
/**
 * `--remove` target selection for `patch staged-dependency`. Split out of
 * `staged-dependency.ts` for the per-file line budget.
 *
 * A removal names its entries by any of `--file`, `--specifier`/`--line`,
 * `--creates` and `--owner`, and must give at least `--creates` or the
 * `--file` + matcher pair. Without `--kind` the matcher picks the kind
 * (`--specifier` an import, `--line` a registration), and a selection with
 * neither searches both kinds, so `--creates` alone removes every
 * declaration for that path. Registration lines compare whitespace-
 * insensitively (runs of whitespace collapse, ends trimmed), the way the
 * lint compares them, so a line copied from a patch hunk matches the stored
 * one whatever its padding. A selection that matches nothing is refused
 * rather than reported as a no-op.
 */

import { normalizeRegistrationLine } from '../../core/patch-lint-staged-registration.js';
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

/** One stored declaration together with its kind. */
export interface KindedEntryView {
  kind: StagedDependencyKind;
  view: StagedEntryView;
}

function stagedViews(
  kinds: readonly StagedDependencyKind[],
  staged: PatchStagedDependencies | undefined
): KindedEntryView[] {
  return kinds.flatMap((kind): KindedEntryView[] =>
    kind === 'import'
      ? (staged?.forwardImports ?? []).map((entry) => ({ kind, view: importView(entry) }))
      : (staged?.registrations ?? []).map((entry) => ({ kind, view: registrationView(entry) }))
  );
}

/** Singular noun for a declaration of the given kinds. */
export function declarationNoun(kinds: readonly StagedDependencyKind[]): string {
  if (kinds.length !== 1) return 'staged declaration';
  return kinds[0] === 'import' ? 'staged forward-import' : 'staged registration';
}

/**
 * The kinds a `--remove` searches. `--kind` wins when given (and is
 * validated by the caller); otherwise `--specifier` selects imports,
 * `--line` registrations, and a selection with neither matcher searches
 * both kinds.
 *
 * @param options - Command options
 * @returns The kinds to search, or undefined when `--kind` was given
 * @throws InvalidArgumentError when `--specifier` and `--line` are both given without `--kind`
 */
export function inferRemovalKinds(
  options: PatchStagedDependencyOptions
): readonly StagedDependencyKind[] | undefined {
  if (options.kind !== undefined) return undefined;
  if (options.specifier !== undefined && options.line !== undefined) {
    throw new InvalidArgumentError(
      '--specifier names an import and --line a registration; pass one of them, or --kind.',
      '--specifier/--line'
    );
  }
  if (options.specifier !== undefined) return ['import'];
  if (options.line !== undefined) return ['registration'];
  return ['import', 'registration'];
}

/**
 * Resolves the staged entries a `--remove` invocation names. The returned
 * views are the stored entries themselves, so the removal matches them
 * exactly.
 *
 * - `--file` + matcher identifying one entry infers `--creates`.
 * - `--file` + matcher identifying several entries without `--creates`
 *   refuses with the candidate list.
 * - `--creates` alone selects every declaration for that created path, of
 *   every kind searched.
 *
 * @param kinds - Declaration kinds to search
 * @param options - Command options
 * @param staged - The target patch's current staged dependencies
 * @returns The matching stored entries (never empty)
 * @throws InvalidArgumentError when the selectors are insufficient or match nothing
 */
export function selectRemovalEntries(
  kinds: readonly StagedDependencyKind[],
  options: PatchStagedDependencyOptions,
  staged: PatchStagedDependencies | undefined
): KindedEntryView[] {
  const single = kinds.length === 1 ? kinds[0] : undefined;
  const matcherFlag =
    single === 'import'
      ? '--specifier'
      : single === 'registration'
        ? '--line'
        : '--specifier or --line';
  const matcher =
    single === 'import' ? options.specifier : single === 'registration' ? options.line : undefined;
  const hasPair = Boolean(options.file) && Boolean(matcher);
  if (!options.creates && !hasPair) {
    throw new InvalidArgumentError(
      `--remove${options.kind === 'registration' ? ' --kind registration' : ''} requires --creates, ` +
        `or --file with ${matcherFlag}; --creates alone removes every declaration for that path.`,
      matcher && !options.file
        ? '--file'
        : options.file && !matcher
          ? matcherFlag
          : `--creates or --file + ${matcherFlag}`
    );
  }

  const views = stagedViews(kinds, staged);
  const candidates = views.filter(
    ({ kind, view }) =>
      (!options.file || view.file === options.file) &&
      (matcher === undefined ||
        comparableMatcher(kind, view.matcher) === comparableMatcher(kind, matcher)) &&
      (!options.creates || view.creates === options.creates) &&
      (options.owner === undefined || view.owner === options.owner)
  );

  const label = ({ kind, view }: KindedEntryView): string => `  - ${dependencyLabel(kind, view)}`;
  if (candidates.length === 0) {
    const noun = declarationNoun(kinds);
    const existing =
      views.length === 0
        ? `This patch has no ${noun}s.`
        : `This patch's ${noun}s:\n${views.map(label).join('\n')}`;
    throw new InvalidArgumentError(`--remove matched no ${noun}. ${existing}`, '--remove');
  }
  if (candidates.length > 1 && !options.creates) {
    throw new GeneralError(
      `--remove matches ${candidates.length} ${declarationNoun(kinds)}s on this patch; ` +
        `pass --creates to pick one:\n${candidates.map(label).join('\n')}`
    );
  }
  const only = candidates.length === 1 ? candidates[0] : undefined;
  if (only !== undefined && !options.creates) {
    info(`Inferred --creates ${only.view.creates} from the single matching staged entry.`);
  }
  return candidates;
}

function comparableMatcher(kind: StagedDependencyKind, matcher: string): string {
  return kind === 'registration' ? normalizeRegistrationLine(matcher) : matcher;
}
