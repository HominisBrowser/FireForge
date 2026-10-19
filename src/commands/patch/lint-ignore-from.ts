// SPDX-License-Identifier: EUPL-1.2
/**
 * Batch and per-entry input for `patch lint-ignore --add`. Split out of
 * `lint-ignore.ts` for the per-file line budget.
 *
 * A rebaseline that sets a ceiling per rule used to take one call per rule,
 * each taking the patch lock and rewriting `patches.json` (138 calls on one
 * consumer's queue), because `--max` applied to every `--add` of a call.
 * Two forms lift that:
 *
 * - `--add <rule>=<max>` gives each entry its own ceiling in one call.
 * - `--from <json-file>` reads every entry from a file, under one lock hold
 *   and one write. The file is a JSON array of entries (a check ID string,
 *   or `{ rule, max, reason?, share?, meta?, patch? }`), or a
 *   `lint --per-patch --report` document, whose `lintIgnoreCeilings` rows
 *   for the target patch are rebaselined to their current measurement.
 */

import { LINT_IGNORE_CEILING_RULES, parseLintIgnoreEntries } from '../../core/patch-lint-ignore.js';
import { InvalidArgumentError } from '../../errors/base.js';
import type {
  LintIgnoreEntry,
  PatchLintIgnoreOptions,
  PatchSizeShare,
} from '../../types/commands/index.js';
import { toError } from '../../utils/errors.js';
import { readJson } from '../../utils/fs.js';
import { isArray, isObject } from '../../utils/validation.js';

const RULE_MAX_PATTERN = /^(?<rule>[^=\s]+)=(?<max>[1-9]\d*)$/;

/**
 * Turns `--add` values into entries: `<rule>=<max>` is a ceiling at `max`,
 * a bare ID is a ceiling at `--max` when that is given and a bare waiver
 * otherwise. Every ceiling takes `--reason` (required) and `--share`.
 *
 * @param ids - The `--add` values
 * @param options - Command options (`max`, `reason`, `share`)
 * @returns The entries to upsert
 */
export function resolveAddEntries(
  ids: readonly string[],
  options: Pick<PatchLintIgnoreOptions, 'max' | 'reason' | 'share'>
): LintIgnoreEntry[] {
  const parsed = ids.map((id) => {
    if (id.includes('=')) {
      const match = RULE_MAX_PATTERN.exec(id);
      if (match?.groups === undefined) {
        throw new InvalidArgumentError(
          `--add ${id}: expected <rule>=<max> with a positive integer max.`,
          '--add'
        );
      }
      return { rule: match.groups['rule'] as string, max: Number(match.groups['max']) };
    }
    return { rule: id, max: options.max };
  });
  const ceilings = parsed.filter((entry) => entry.max !== undefined);
  if (ceilings.length === 0) {
    if (options.reason !== undefined || options.share !== undefined) {
      throw new InvalidArgumentError(
        '--reason and --share apply to ceilings: pass --max <n> or --add <rule>=<max>.',
        options.reason !== undefined ? '--reason' : '--share'
      );
    }
    return parsed.map((entry) => entry.rule);
  }
  if (options.reason === undefined || options.reason.trim() === '') {
    throw new InvalidArgumentError(
      'A lintIgnore ceiling needs --reason <text> (with --max <n> or --add <rule>=<max>).',
      '--reason'
    );
  }
  const unmeasured = ceilings.filter((entry) => !LINT_IGNORE_CEILING_RULES.includes(entry.rule));
  if (unmeasured.length > 0) {
    throw new InvalidArgumentError(
      `A ceiling only applies to the measured size rules (${LINT_IGNORE_CEILING_RULES.join(', ')}); ` +
        `got ${unmeasured.map((entry) => entry.rule).join(', ')}.`,
      '--max'
    );
  }
  const { reason, share } = options;
  return validated(
    parsed.map((entry) =>
      entry.max === undefined
        ? entry.rule
        : { rule: entry.rule, max: entry.max, reason, ...(share !== undefined ? { share } : {}) }
    ),
    '--add'
  );
}

/** Runs the manifest validator over CLI-built entries, as an argument error. */
function validated(entries: unknown[], flag: string): LintIgnoreEntry[] {
  try {
    return parseLintIgnoreEntries(entries, flag);
  } catch (error: unknown) {
    throw new InvalidArgumentError(toError(error).message, flag);
  }
}

/** Entries read from a `--from` file for one target patch. */
export interface LintIgnoreBatch {
  entries: LintIgnoreEntry[];
  /** Entries naming a different patch, left out. */
  skippedForOtherPatches: number;
}

/** The target patch's ceiling rows of a lint report, rebaselined to their measurement. */
function rebaselineFromReport(
  data: Record<string, unknown>,
  targetFilename: string
): { raw: unknown[]; skipped: number } {
  const patches = isArray(data['patches']) ? data['patches'] : [];
  const row = patches.find((patch) => isObject(patch) && patch['filename'] === targetFilename);
  const ceilings =
    isObject(row) && isArray(row['lintIgnoreCeilings']) ? row['lintIgnoreCeilings'] : [];
  const raw: unknown[] = [];
  for (const ceiling of ceilings) {
    if (!isObject(ceiling) || typeof ceiling['measurement'] !== 'number') continue;
    if (ceiling['measurement'] <= 0) continue;
    const { measurement, rule, reason, share, meta } = ceiling;
    raw.push({
      rule,
      max: measurement,
      reason,
      ...(share !== undefined ? { share } : {}),
      ...(meta !== undefined ? { meta } : {}),
    });
  }
  return { raw, skipped: patches.length - (row === undefined ? 0 : 1) };
}

/**
 * Reads a `--from` file into entries for `targetFilename`.
 *
 * @param path - JSON file path
 * @param targetFilename - The patch the command edits
 * @param defaultReason - `--reason`, used for object entries without one
 * @returns The validated entries and the count left out for other patches
 */
export async function readLintIgnoreBatch(
  path: string,
  targetFilename: string,
  defaultReason: string | undefined
): Promise<LintIgnoreBatch> {
  let data: unknown;
  try {
    data = await readJson<unknown>(path);
  } catch (error: unknown) {
    throw new InvalidArgumentError(
      `Cannot read --from ${path}: ${toError(error).message}`,
      '--from'
    );
  }
  if (isObject(data)) {
    const { raw, skipped } = rebaselineFromReport(data, targetFilename);
    return { entries: validated(raw, '--from'), skippedForOtherPatches: skipped };
  }
  if (!isArray(data)) {
    throw new InvalidArgumentError(
      '--from must hold a JSON array of lintIgnore entries or a "lint --per-patch --report" document.',
      '--from'
    );
  }
  const raw: unknown[] = [];
  let skipped = 0;
  for (const entry of data) {
    if (!isObject(entry)) {
      raw.push(entry);
      continue;
    }
    const { patch, ...rest } = entry;
    if (patch !== undefined && patch !== targetFilename) {
      skipped++;
      continue;
    }
    raw.push(
      rest['reason'] === undefined && defaultReason !== undefined
        ? { ...rest, reason: defaultReason }
        : rest
    );
  }
  return { entries: validated(raw, '--from'), skippedForOtherPatches: skipped };
}

/** Parses `--share`. */
export function parseShare(value: string): PatchSizeShare {
  if (value !== 'test' && value !== 'product') {
    throw new InvalidArgumentError(
      `--share must be "test" or "product" (got "${value}").`,
      '--share'
    );
  }
  return value;
}
