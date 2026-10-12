// SPDX-License-Identifier: EUPL-1.2
/**
 * Batch input and history delta for `patch staged-dependency`.
 *
 * `--from <json-file>` lets one `--add` call declare many edges under one
 * lock hold. Turning on `patchLint.forwardRegistration: "extended"` on a real
 * queue surfaced hundreds of undeclared registrations, each printed with its
 * own command, and one call per edge was the only way to declare them. The
 * file is either a `lint --per-patch --report` JSON (its findings carry the
 * `stagedDeclarations` that discharge them) or a plain array of
 * declarations.
 *
 * The history record of every call holds only the delta (`added` /
 * `removed`). Recording the patch's whole list before and after grew the
 * log quadratically with the list: 849 single-edge calls took one consumer's
 * log from 36 MB to 184 MB.
 */

import { InvalidArgumentError } from '../../errors/base.js';
import type {
  PatchStagedDependencies,
  PatchStagedForwardImport,
  PatchStagedRegistration,
} from '../../types/commands/index.js';
import { toError } from '../../utils/errors.js';
import { readJson } from '../../utils/fs.js';
import { isArray, isObject } from '../../utils/validation.js';

/** Declarations read from a `--from` file for one target patch. */
export interface StagedDependencyBatch {
  forwardImports: PatchStagedForwardImport[];
  registrations: PatchStagedRegistration[];
  /** Entries naming a different patch, left out. */
  skippedForOtherPatches: number;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  label: string
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidArgumentError(`${label}.${key} must be a non-empty string.`, '--from');
  }
  return value;
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = optionalString(record, key, label);
  if (value === undefined) {
    throw new InvalidArgumentError(`${label} is missing "${key}".`, '--from');
  }
  return value;
}

/**
 * Collects the declaration records a parsed file holds: a lint report's
 * `stagedDeclarations` (from `queueIssues` and every patch's `issues`), or
 * the elements of a plain array.
 */
function collectRecords(data: unknown): Array<{ record: Record<string, unknown>; label: string }> {
  if (isArray(data)) {
    return data.map((entry, index) => {
      if (!isObject(entry)) {
        throw new InvalidArgumentError(`--from entry [${index}] must be an object.`, '--from');
      }
      return { record: entry, label: `--from entry [${index}]` };
    });
  }
  if (!isObject(data)) {
    throw new InvalidArgumentError(
      '--from must hold a JSON array of declarations or a "lint --per-patch --report" document.',
      '--from'
    );
  }
  const issues: unknown[] = [];
  if (isArray(data['queueIssues'])) issues.push(...data['queueIssues']);
  if (isArray(data['patches'])) {
    for (const patch of data['patches']) {
      if (isObject(patch) && isArray(patch['issues'])) issues.push(...patch['issues']);
    }
  }
  const records: Array<{ record: Record<string, unknown>; label: string }> = [];
  for (const issue of issues) {
    if (!isObject(issue) || !isArray(issue['stagedDeclarations'])) continue;
    for (const declaration of issue['stagedDeclarations']) {
      if (isObject(declaration)) {
        records.push({
          record: declaration,
          label: `stagedDeclarations of [${String(issue['check'])}] ${String(issue['file'])}`,
        });
      }
    }
  }
  return records;
}

/**
 * Reads the declarations a `--from` file supplies for `targetFilename`.
 *
 * Every entry takes `file`, `creates`, optional `owner` and `reason`, and
 * either `specifier` (an import) or `line` (a registration); `kind` may
 * name the shape explicitly. An entry with a `patch` field naming another
 * patch is skipped and counted, so one report can be applied patch by
 * patch. `defaultReason` (the `--reason` flag) fills entries without one.
 *
 * @param path - The JSON file
 * @param targetFilename - Filename of the patch being edited
 * @param defaultReason - Reason for entries that carry none
 */
export async function readStagedDependencyBatch(
  path: string,
  targetFilename: string,
  defaultReason?: string
): Promise<StagedDependencyBatch> {
  let data: unknown;
  try {
    data = await readJson<unknown>(path);
  } catch (error: unknown) {
    throw new InvalidArgumentError(
      `--from ${path} could not be read as JSON: ${toError(error).message}`,
      '--from'
    );
  }

  const batch: StagedDependencyBatch = {
    forwardImports: [],
    registrations: [],
    skippedForOtherPatches: 0,
  };
  for (const { record, label } of collectRecords(data)) {
    const patch = optionalString(record, 'patch', label);
    if (patch !== undefined && patch !== targetFilename) {
      batch.skippedForOtherPatches += 1;
      continue;
    }
    const specifier = optionalString(record, 'specifier', label);
    const line = optionalString(record, 'line', label);
    const kind = record['kind'] ?? (line !== undefined ? 'registration' : 'import');
    if (kind !== 'import' && kind !== 'registration') {
      throw new InvalidArgumentError(`${label}.kind must be "import" or "registration".`, '--from');
    }
    const file = requiredString(record, 'file', label);
    const creates = requiredString(record, 'creates', label);
    const owner = optionalString(record, 'owner', label);
    const reason = optionalString(record, 'reason', label) ?? defaultReason;
    const extras = {
      ...(owner !== undefined ? { owner } : {}),
      ...(reason !== undefined ? { reason } : {}),
    };
    if (kind === 'import') {
      if (specifier === undefined || line !== undefined) {
        throw new InvalidArgumentError(
          `${label} is an import declaration and needs "specifier" (not "line").`,
          '--from'
        );
      }
      batch.forwardImports.push({ file, specifier, creates, ...extras });
    } else {
      if (line === undefined || specifier !== undefined) {
        throw new InvalidArgumentError(
          `${label} is a registration declaration and needs "line" (not "specifier").`,
          '--from'
        );
      }
      batch.registrations.push({ file, line, creates, ...extras });
    }
  }
  return batch;
}

function entryKey(entry: PatchStagedForwardImport | PatchStagedRegistration): string {
  return JSON.stringify(entry);
}

function difference<T extends PatchStagedForwardImport | PatchStagedRegistration>(
  left: readonly T[] | undefined,
  right: readonly T[] | undefined
): T[] {
  const keys = new Set((right ?? []).map(entryKey));
  return (left ?? []).filter((entry) => !keys.has(entryKey(entry)));
}

function nonEmpty(staged: PatchStagedDependencies): PatchStagedDependencies | undefined {
  const forwardImports = staged.forwardImports ?? [];
  const registrations = staged.registrations ?? [];
  if (forwardImports.length === 0 && registrations.length === 0) return undefined;
  return {
    ...(forwardImports.length > 0 ? { forwardImports } : {}),
    ...(registrations.length > 0 ? { registrations } : {}),
  };
}

/**
 * The history delta between two committed `stagedDependencies` values:
 * the declarations the call added and the ones it removed. Each side is
 * omitted when empty. Older log records carry `before`/`after` instead;
 * a reader should accept either.
 */
export function stagedDependencyDelta(
  before: PatchStagedDependencies | undefined,
  after: PatchStagedDependencies | undefined
): { added?: PatchStagedDependencies; removed?: PatchStagedDependencies } {
  const added = nonEmpty({
    forwardImports: difference(after?.forwardImports, before?.forwardImports),
    registrations: difference(after?.registrations, before?.registrations),
  });
  const removed = nonEmpty({
    forwardImports: difference(before?.forwardImports, after?.forwardImports),
    registrations: difference(before?.registrations, after?.registrations),
  });
  return {
    ...(added !== undefined ? { added } : {}),
    ...(removed !== undefined ? { removed } : {}),
  };
}
