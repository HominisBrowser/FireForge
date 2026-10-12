// SPDX-License-Identifier: EUPL-1.2
/**
 * `status --json` payload rendering (schemaVersion 1). Helper module
 * consumed by status.ts (which sits at the max-lines budget). No top-level
 * registrar is exported and none is wanted.
 *
 * Two shapes share one counting pass:
 * - the full payload (`renderJsonStatus`) with the per-file `files[]` list,
 * - the `--summary` gate payload (`renderJsonSummaryStatus`), which omits
 *   `files[]` entirely, because engine-clean gates need the verdict,
 *   per-class counts, and offender names, not a payload that grows with
 *   the queue (175 KB+ on a large one).
 *
 * Both carry the `check` block when the `--check` policy is active, and the
 * `scope` block under `--patches`.
 */
import type { ClassifiedFile, FileClassification } from '../core/status-classify.js';
import { setStdoutSealed } from '../utils/logger.js';
import {
  collectStatusCheckOffenders,
  type StatusCheckClass,
  type StatusCheckOffender,
  type StatusCheckPolicy,
} from './status-check.js';
import type { OwnershipJsonBlock } from './status-ownership.js';
import type { StatusScope } from './status-scope.js';

/** What a JSON payload adds beside the classification counts. */
export interface StatusJsonContext {
  policy: StatusCheckPolicy;
  /** Paths claimed by more than one patch, for the `ownership-conflict` class. */
  ownershipConflicts: readonly string[];
  /** The `--include-ownership` block, when asked for. */
  ownership?: OwnershipJsonBlock | undefined;
  /** The `--patches` scope, when given. */
  scope?: StatusScope | undefined;
}

/** The `check` block: the policy as resolved, and its verdict. */
interface StatusJsonCheckBlock {
  enabled: boolean;
  failOn: readonly StatusCheckClass[];
  allow?: readonly StatusCheckClass[];
  failOnUnknown?: boolean;
  failed: boolean;
  offenders: StatusCheckOffender[];
}

function countByClassification(
  classified: readonly ClassifiedFile[]
): Record<FileClassification, number> {
  const byClassification: Record<FileClassification, number> = {
    unmanaged: 0,
    'patch-owned-drift': 0,
    'patch-backed': 0,
    branding: 0,
    furnace: 0,
    conflict: 0,
    'binary-unsupported': 0,
  };
  for (const file of classified) {
    byClassification[file.classification]++;
  }
  return byClassification;
}

/**
 * Builds the `check` block, or undefined when no policy is active.
 * `allow` and `failOnUnknown` appear only when the caller set them, so a
 * consumer that never passes those flags sees the block it always did.
 */
function buildCheckBlock(
  classified: readonly ClassifiedFile[],
  context: StatusJsonContext
): StatusJsonCheckBlock | undefined {
  const { policy } = context;
  if (!policy.checkEnabled) return undefined;
  const offenders = collectStatusCheckOffenders(classified, policy, context.ownershipConflicts);
  return {
    enabled: true,
    failOn: policy.failOn,
    ...(policy.allow !== undefined ? { allow: policy.allow } : {}),
    ...(policy.failOnUnknown === true ? { failOnUnknown: true } : {}),
    failed: offenders.length > 0,
    offenders,
  };
}

/** The additive tail both payloads share: check, scope, ownership. */
function buildTrailingBlocks(
  classified: readonly ClassifiedFile[],
  context: StatusJsonContext
): {
  check?: StatusJsonCheckBlock;
  scope?: StatusScope;
  ownership?: OwnershipJsonBlock;
} {
  const check = buildCheckBlock(classified, context);
  return {
    ...(check !== undefined ? { check } : {}),
    ...(context.scope !== undefined ? { scope: context.scope } : {}),
    ...(context.ownership !== undefined ? { ownership: context.ownership } : {}),
  };
}

function writePayload(output: object): void {
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  // Payload written: stdout is now spoken for. See docs/machine-output.md.
  setStdoutSealed(true);
}

/**
 * Full `--json` payload: summary plus the per-file `files[]` list, and the
 * additive `check`, `scope` and `ownership` blocks when their flags are
 * set. Additive within schemaVersion 1: a consumer that does not ask for a
 * block never sees the key.
 */
export function renderJsonStatus(
  classified: readonly ClassifiedFile[],
  context: StatusJsonContext
): void {
  const outputFiles = classified.map((f) => {
    const entry: {
      file: string;
      status: string;
      classification: FileClassification;
      /** Owning patch filename. Null when unowned (additive to schemaVersion 1). */
      patch: string | null;
      claimedBy?: string[];
    } = {
      file: f.file,
      status: f.status.trim(),
      classification: f.classification,
      patch: f.owner ?? null,
    };
    if (f.classification === 'conflict' && f.claimedBy && f.claimedBy.length > 0) {
      entry.claimedBy = [...f.claimedBy];
    }
    return entry;
  });
  writePayload({
    schemaVersion: 1,
    summary: {
      total: outputFiles.length,
      byClassification: countByClassification(classified),
    },
    files: outputFiles,
    ...buildTrailingBlocks(classified, context),
  });
}

/**
 * Summary-only `--json --summary` payload. Counts are always present. When
 * the `--check`/`--fail-on` policy is active, the payload adds a `check`
 * block with the active fail set, the verdict, and the offending files per
 * failing class (sourced from the same collector as the human `--check`
 * message, so the two views can never disagree). The absent `files[]` is
 * the mode signal within schemaVersion 1. Consumers opt in via the flag.
 */
export function renderJsonSummaryStatus(
  classified: readonly ClassifiedFile[],
  context: StatusJsonContext
): void {
  writePayload({
    schemaVersion: 1,
    summary: {
      total: classified.length,
      byClassification: countByClassification(classified),
    },
    ...buildTrailingBlocks(classified, context),
  });
}
