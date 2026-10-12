// SPDX-License-Identifier: EUPL-1.2
/**
 * `status --check` enforcement policy. Turns the classified status view into
 * a CI-enforceable non-zero exit: the default policy fails on any
 * classification outside {patch-backed, branding, furnace}, and
 * `--fail-on <class,...>` replaces that set for finer control.
 * `--allow <class,...>` names classes that never fail, and
 * `--fail-on-unknown` fails every present class that neither list names,
 * so a gate keeps failing closed when FireForge adds a classification.
 * `ownership-conflict` is a check class beside the file classifications:
 * a path claimed by more than one patch, judged from the same rows as
 * `--include-ownership`.
 *
 * Helper module consumed by status.ts, which sits at the max-lines budget.
 * No top-level registrar is exported and none is wanted.
 */
import type { ClassifiedFile, FileClassification } from '../core/status-classify.js';
import { GeneralError, InvalidArgumentError } from '../errors/base.js';

/**
 * A class `--fail-on`/`--allow` can name: every file classification, plus
 * `ownership-conflict`, which is judged from the ownership rows rather
 * than from a file's classification.
 */
export type StatusCheckClass = FileClassification | 'ownership-conflict';

const ALL_CHECK_CLASSES: readonly StatusCheckClass[] = [
  'patch-backed',
  'patch-owned-drift',
  'unmanaged',
  'branding',
  'furnace',
  'conflict',
  'binary-unsupported',
  'ownership-conflict',
];

/**
 * Default `--check` policy: everything outside {patch-backed, branding,
 * furnace, binary-unsupported} fails. `binary-unsupported` is excluded so
 * an honest "cannot compare" does not keep the gate permanently red.
 * Strict CI can opt in via `--fail-on binary-unsupported`.
 * `ownership-conflict` is opt-in too: the human `--ownership` mode already
 * fails on it, and adding it here would change the default gate.
 */
const DEFAULT_FAIL_CLASSIFICATIONS: readonly StatusCheckClass[] = [
  'unmanaged',
  'patch-owned-drift',
  'conflict',
];

/** Resolved `--check`/`--fail-on` policy for one status invocation. */
export interface StatusCheckPolicy {
  checkEnabled: boolean;
  /** Classes that fail: `--fail-on` (or the default set) minus `--allow`. */
  failOn: readonly StatusCheckClass[];
  /** `--allow`: classes that never fail. Set only when the flag was given. */
  allow?: readonly StatusCheckClass[];
  /** `--fail-on-unknown`: a present class named by neither list fails. */
  failOnUnknown?: boolean;
}

/**
 * Resolves the enforcement policy from the raw flags. `--fail-on`,
 * `--allow` and `--fail-on-unknown` each imply `--check`. `--fail-on`
 * replaces the default set and `--allow` subtracts from it (naming one
 * class in both is refused). `--fail-on-unknown` needs `--allow`: without
 * an allow list every class the caller did not name, `patch-backed`
 * included, would fail. All of them are refused alongside the modes that
 * skip (or elide) classification.
 */
export function resolveStatusCheckPolicy(options: {
  check?: boolean;
  failOn?: string;
  allow?: string;
  failOnUnknown?: boolean;
  raw?: boolean;
  unmanaged?: boolean;
  ownership?: boolean;
  testCoverage?: boolean;
}): StatusCheckPolicy {
  const failOnList = parseCheckClassList(options.failOn, '--fail-on');
  const allowList = parseCheckClassList(options.allow, '--allow');
  const failOnUnknown = options.failOnUnknown === true;
  const checkEnabled =
    options.check === true || failOnList !== undefined || allowList !== undefined || failOnUnknown;
  if (
    checkEnabled &&
    (options.raw === true ||
      options.unmanaged === true ||
      options.ownership === true ||
      options.testCoverage === true)
  ) {
    throw new InvalidArgumentError(
      '--check cannot be combined with --raw, --unmanaged, --ownership, or --test-coverage. Use the default view or --json.',
      '--check'
    );
  }
  if (failOnUnknown && allowList === undefined) {
    throw new InvalidArgumentError(
      '--fail-on-unknown requires --allow naming the classes that may pass. Without it every class you did not name, patch-backed included, would fail.',
      '--fail-on-unknown'
    );
  }
  const overlap = (failOnList ?? []).filter((entry) => allowList?.includes(entry) === true);
  if (overlap.length > 0) {
    throw new InvalidArgumentError(
      `--fail-on and --allow both name ${overlap.join(', ')}. A class either fails or is allowed.`,
      '--allow'
    );
  }
  const base = failOnList ?? DEFAULT_FAIL_CLASSIFICATIONS;
  const policy: StatusCheckPolicy = {
    checkEnabled,
    failOn: allowList ? base.filter((entry) => !allowList.includes(entry)) : base,
  };
  if (allowList !== undefined) policy.allow = allowList;
  if (failOnUnknown) policy.failOnUnknown = true;
  return policy;
}

function isCheckClass(value: string): value is StatusCheckClass {
  return (ALL_CHECK_CLASSES as readonly string[]).includes(value);
}

/**
 * Parses a comma-separated `--fail-on`/`--allow` value into a class list.
 * Returns undefined when the flag was not given.
 */
function parseCheckClassList(
  raw: string | undefined,
  flag: '--fail-on' | '--allow'
): StatusCheckClass[] | undefined {
  if (raw === undefined) return undefined;
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    throw new InvalidArgumentError(
      `${flag} requires at least one classification. Valid: ${ALL_CHECK_CLASSES.join(', ')}.`,
      flag
    );
  }
  const classes: StatusCheckClass[] = [];
  for (const part of parts) {
    if (!isCheckClass(part)) {
      throw new InvalidArgumentError(
        `Unknown ${flag} classification "${part}". Valid: ${ALL_CHECK_CLASSES.join(', ')}.`,
        flag
      );
    }
    if (!classes.includes(part)) classes.push(part);
  }
  return classes;
}

/**
 * True when the policy can fail on `ownership-conflict`, so the caller has
 * to build the ownership rows even without `--include-ownership`.
 */
export function policyNeedsOwnership(policy: StatusCheckPolicy): boolean {
  if (!policy.checkEnabled) return false;
  if (policy.failOn.includes('ownership-conflict')) return true;
  return policy.failOnUnknown === true && policy.allow?.includes('ownership-conflict') !== true;
}

const CHECK_FILE_PREVIEW_MAX = 3;

/** One failing class with a non-empty file list. */
export interface StatusCheckOffender {
  classification: StatusCheckClass;
  count: number;
  files: string[];
  /**
   * Set when the class failed only through `--fail-on-unknown`: neither
   * `--fail-on` nor `--allow` named it.
   */
  unnamed?: true;
}

/**
 * Collects the failing classes that have offending files, with full file
 * lists: the fail set in policy order, then (under `--fail-on-unknown`)
 * every other present class neither list names, in first-seen order.
 * Shared by the human `--check` verdict and the JSON `check` block so the
 * two views can never disagree about what failed.
 *
 * @param classified - Classified worktree entries
 * @param policy - Resolved policy
 * @param ownershipConflicts - Paths claimed by more than one patch. Only
 *   read for the `ownership-conflict` class
 */
export function collectStatusCheckOffenders(
  classified: readonly ClassifiedFile[],
  policy: StatusCheckPolicy,
  ownershipConflicts: readonly string[] = []
): StatusCheckOffender[] {
  const filesOf = (checkClass: StatusCheckClass): string[] =>
    checkClass === 'ownership-conflict'
      ? [...ownershipConflicts]
      : classified.filter((entry) => entry.classification === checkClass).map((e) => e.file);
  const offenders: StatusCheckOffender[] = [];
  for (const checkClass of policy.failOn) {
    const files = filesOf(checkClass);
    if (files.length === 0) continue;
    offenders.push({ classification: checkClass, count: files.length, files });
  }
  if (policy.failOnUnknown !== true) return offenders;

  const named = new Set<string>([...policy.failOn, ...(policy.allow ?? [])]);
  const present: StatusCheckClass[] = [...new Set(classified.map((e) => e.classification))];
  if (ownershipConflicts.length > 0) present.push('ownership-conflict');
  for (const checkClass of present) {
    if (named.has(checkClass)) continue;
    const files = filesOf(checkClass);
    offenders.push({ classification: checkClass, count: files.length, files, unnamed: true });
  }
  return offenders;
}

/**
 * Throws a GeneralError (exit 1) when the policy is enabled and any
 * failing class is non-empty, naming each offending class with its first
 * few files. A disabled policy or a fully tool-covered tree passes
 * silently.
 */
export function runStatusCheck(
  classified: readonly ClassifiedFile[],
  policy: StatusCheckPolicy,
  ownershipConflicts: readonly string[] = []
): void {
  if (!policy.checkEnabled) return;
  const offending = collectStatusCheckOffenders(classified, policy, ownershipConflicts).map(
    (offender) => {
      const preview = offender.files.slice(0, CHECK_FILE_PREVIEW_MAX).join(', ');
      const more =
        offender.count > CHECK_FILE_PREVIEW_MAX
          ? `, +${offender.count - CHECK_FILE_PREVIEW_MAX} more`
          : '';
      const unnamed = offender.unnamed === true ? ' [named by neither --fail-on nor --allow]' : '';
      return `${offender.count} ${offender.classification}${unnamed} (${preview}${more})`;
    }
  );
  if (offending.length === 0) return;
  throw new GeneralError(
    `status --check failed: ${offending.join(', ')}. Export or adopt unmanaged files, ` +
      `re-export drifted patches, and run "fireforge verify" for conflict details.`
  );
}
