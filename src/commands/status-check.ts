// SPDX-License-Identifier: EUPL-1.2
/**
 * `status --check` enforcement policy. Turns the classified status view into
 * a CI-enforceable non-zero exit: the default policy fails on any
 * classification outside {patch-backed, branding, furnace}, and
 * `--fail-on <class,...>` replaces that set for finer control.
 *
 * Helper module consumed by status.ts, which sits at the max-lines budget.
 * No top-level registrar is exported and none is wanted.
 */
import type { ClassifiedFile, FileClassification } from '../core/status-classify.js';
import { GeneralError, InvalidArgumentError } from '../errors/base.js';

const ALL_CLASSIFICATIONS: readonly FileClassification[] = [
  'patch-backed',
  'patch-owned-drift',
  'unmanaged',
  'branding',
  'furnace',
  'conflict',
  'binary-unsupported',
];

/**
 * Default `--check` policy: everything outside {patch-backed, branding,
 * furnace, binary-unsupported} fails. `binary-unsupported` is excluded so
 * an honest "cannot compare" does not keep the gate permanently red.
 * Strict CI can opt in via `--fail-on binary-unsupported`.
 */
const DEFAULT_FAIL_CLASSIFICATIONS: readonly FileClassification[] = [
  'unmanaged',
  'patch-owned-drift',
  'conflict',
];

/** Resolved `--check`/`--fail-on` policy for one status invocation. */
export interface StatusCheckPolicy {
  checkEnabled: boolean;
  failOn: readonly FileClassification[];
}

/**
 * Resolves the enforcement policy from the raw flags: `--fail-on` implies
 * `--check` and replaces the default set. Both are refused alongside the
 * modes that skip (or elide) classification.
 */
export function resolveStatusCheckPolicy(options: {
  check?: boolean;
  failOn?: string;
  raw?: boolean;
  unmanaged?: boolean;
  ownership?: boolean;
  testCoverage?: boolean;
}): StatusCheckPolicy {
  const failOnList = parseFailOnClassifications(options.failOn);
  const checkEnabled = options.check === true || failOnList !== undefined;
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
  return { checkEnabled, failOn: failOnList ?? DEFAULT_FAIL_CLASSIFICATIONS };
}

function isClassification(value: string): value is FileClassification {
  return (ALL_CLASSIFICATIONS as readonly string[]).includes(value);
}

/**
 * Parses a comma-separated `--fail-on` value into a classification list.
 * Returns undefined when the flag was not given (the caller then applies
 * the default policy only under `--check`).
 */
function parseFailOnClassifications(raw: string | undefined): FileClassification[] | undefined {
  if (raw === undefined) return undefined;
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    throw new InvalidArgumentError(
      `--fail-on requires at least one classification. Valid: ${ALL_CLASSIFICATIONS.join(', ')}.`,
      '--fail-on'
    );
  }
  const classifications: FileClassification[] = [];
  for (const part of parts) {
    if (!isClassification(part)) {
      throw new InvalidArgumentError(
        `Unknown --fail-on classification "${part}". Valid: ${ALL_CLASSIFICATIONS.join(', ')}.`,
        '--fail-on'
      );
    }
    if (!classifications.includes(part)) classifications.push(part);
  }
  return classifications;
}

const CHECK_FILE_PREVIEW_MAX = 3;

/** One fail-set classification with a non-empty file list. */
export interface StatusCheckOffender {
  classification: FileClassification;
  count: number;
  files: string[];
}

/**
 * Collects the fail-set classifications that have offending files, in
 * policy order with full file lists. Shared by the human `--check`
 * verdict and the `--json --summary` payload so the two views can never
 * disagree about what failed.
 */
export function collectStatusCheckOffenders(
  classified: readonly ClassifiedFile[],
  policy: StatusCheckPolicy
): StatusCheckOffender[] {
  const offenders: StatusCheckOffender[] = [];
  for (const classification of policy.failOn) {
    const files = classified
      .filter((entry) => entry.classification === classification)
      .map((entry) => entry.file);
    if (files.length === 0) continue;
    offenders.push({ classification, count: files.length, files });
  }
  return offenders;
}

/**
 * Throws a GeneralError (exit 1) when the policy is enabled and any of
 * its classifications is non-empty, naming each offending classification
 * with its first few files. A disabled policy or a fully tool-covered
 * tree passes silently.
 */
export function runStatusCheck(
  classified: readonly ClassifiedFile[],
  policy: StatusCheckPolicy
): void {
  if (!policy.checkEnabled) return;
  const offending = collectStatusCheckOffenders(classified, policy).map((offender) => {
    const preview = offender.files.slice(0, CHECK_FILE_PREVIEW_MAX).join(', ');
    const more =
      offender.count > CHECK_FILE_PREVIEW_MAX
        ? `, +${offender.count - CHECK_FILE_PREVIEW_MAX} more`
        : '';
    return `${offender.count} ${offender.classification} (${preview}${more})`;
  });
  if (offending.length === 0) return;
  throw new GeneralError(
    `status --check failed: ${offending.join(', ')}. Export or adopt unmanaged files, ` +
      `re-export drifted patches, and run "fireforge verify" for conflict details.`
  );
}
