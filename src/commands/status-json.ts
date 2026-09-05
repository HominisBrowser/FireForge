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
 */
import type { ClassifiedFile, FileClassification } from '../core/status-classify.js';
import { setStdoutSealed } from '../utils/logger.js';
import {
  collectStatusCheckOffenders,
  type StatusCheckOffender,
  type StatusCheckPolicy,
} from './status-check.js';
import type { OwnershipJsonBlock } from './status-ownership.js';

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
 * Full `--json` payload: summary plus the per-file `files[]` list, and,
 * under `--include-ownership`, the additive `ownership` block.
 * Additive within schemaVersion 1: a consumer that does not ask for the
 * block never sees the key.
 */
export function renderJsonStatus(
  classified: readonly ClassifiedFile[],
  ownership?: OwnershipJsonBlock
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
  const output = {
    schemaVersion: 1,
    summary: {
      total: outputFiles.length,
      byClassification: countByClassification(classified),
    },
    files: outputFiles,
    ...(ownership !== undefined ? { ownership } : {}),
  };
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  // Payload written: stdout is now spoken for. See docs/machine-output.md.
  setStdoutSealed(true);
}

/**
 * Summary-only `--json --summary` payload. Counts are always present. When
 * the `--check`/`--fail-on` policy is active, the payload adds a `check`
 * block with the active fail set, the verdict, and the offending files per
 * fail-set classification (sourced from the same collector as the human
 * `--check` message, so the two views can never disagree). The absent
 * `files[]` is the mode signal within schemaVersion 1. Consumers opt in via
 * the flag.
 */
export function renderJsonSummaryStatus(
  classified: readonly ClassifiedFile[],
  policy: StatusCheckPolicy,
  ownership?: OwnershipJsonBlock
): void {
  const output: {
    schemaVersion: number;
    summary: { total: number; byClassification: Record<FileClassification, number> };
    check?: {
      enabled: boolean;
      failOn: readonly FileClassification[];
      failed: boolean;
      offenders: StatusCheckOffender[];
    };
    ownership?: OwnershipJsonBlock;
  } = {
    schemaVersion: 1,
    summary: {
      total: classified.length,
      byClassification: countByClassification(classified),
    },
  };
  if (policy.checkEnabled) {
    const offenders = collectStatusCheckOffenders(classified, policy);
    output.check = {
      enabled: true,
      failOn: policy.failOn,
      failed: offenders.length > 0,
      offenders,
    };
  }
  if (ownership !== undefined) {
    output.ownership = ownership;
  }
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  // Payload written: stdout is now spoken for. See docs/machine-output.md.
  setStdoutSealed(true);
}
