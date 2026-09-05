// SPDX-License-Identifier: EUPL-1.2
/**
 * Validation helpers for `fireforge.json#patchPolicy`.
 */

import { ConfigError } from '../errors/config.js';
import type {
  PatchPolicyConfig,
  PatchPolicyMutationMode,
  PatchPolicyRange,
  PatchPolicyReservedAllowedPatch,
  PatchPolicyReservedRange,
} from '../types/config.js';
import { toError } from '../utils/errors.js';
import { type ParsedRecord, parseObject } from '../utils/parse.js';
import { isContainedRelativePath } from '../utils/paths.js';

const PATCH_POLICY_MUTATION_MODES: readonly PatchPolicyMutationMode[] = ['error', 'warn', 'force'];

function optionalConfigString(rec: ParsedRecord, key: string, label: string): string | undefined {
  const value = rec.raw(key);
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new ConfigError(`Config field "${label}" must be a string`);
  }
  return value;
}

function parsePositiveRangeEndpoint(raw: unknown, label: string): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw new ConfigError(`Config field "${label}" must be a positive integer`);
  }
  return raw;
}

function parsePatchPolicyCategory(raw: unknown, label: string): string {
  if (typeof raw !== 'string' || !/^[a-z][a-z0-9-]*$/.test(raw)) {
    throw new ConfigError(
      `Config field "${label}" must be a lowercase category identifier (letters, numbers, hyphens)`
    );
  }
  return raw;
}

/**
 * Shared head of every patch-policy range shape: the value must be an
 * object carrying positive integer `from`/`to` endpoints with
 * `to >= from`. Returns the parsed record so callers can read their
 * shape-specific fields from it.
 */
function parseRangeBounds(
  raw: unknown,
  label: string
): { rec: ParsedRecord; from: number; to: number } {
  let rec;
  try {
    rec = parseObject(raw, label);
  } catch {
    throw new ConfigError(`Config field "${label}" must be an object`);
  }
  const from = parsePositiveRangeEndpoint(rec.raw('from'), `${label}.from`);
  const to = parsePositiveRangeEndpoint(rec.raw('to'), `${label}.to`);
  if (to < from) {
    throw new ConfigError(`Config field "${label}.to" must be greater than or equal to from`);
  }
  return { rec, from, to };
}

function parsePatchPolicyRange(raw: unknown, label: string): PatchPolicyRange {
  const { rec, from, to } = parseRangeBounds(raw, label);
  return {
    from,
    to,
    category: parsePatchPolicyCategory(rec.raw('category'), `${label}.category`),
  };
}

function parsePatchPolicyDocumentPath(raw: unknown, label: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ConfigError(`Config field "${label}" must be a non-empty string`);
  }
  if (!isContainedRelativePath(raw)) {
    throw new ConfigError(`Config field "${label}" must be a project-relative path`);
  }
  return raw;
}

function parseReservedAllowedPatch(raw: unknown, label: string): PatchPolicyReservedAllowedPatch {
  let rec;
  try {
    rec = parseObject(raw, label);
  } catch {
    throw new ConfigError(`Config field "${label}" must be an object`);
  }
  const filename = optionalConfigString(rec, 'filename', `${label}.filename`);
  if (filename === undefined || filename.trim() === '') {
    throw new ConfigError(`Config field "${label}.filename" must be a non-empty string`);
  }
  const files = rec.raw('files');
  let parsedFiles: string[] | undefined;
  if (files !== undefined) {
    if (!Array.isArray(files) || files.some((value) => typeof value !== 'string')) {
      throw new ConfigError(`Config field "${label}.files" must be an array of strings`);
    }
    parsedFiles = files;
  }
  const adr = parsePatchPolicyDocumentPath(rec.raw('adr'), `${label}.adr`);
  const documentation = parsePatchPolicyDocumentPath(
    rec.raw('documentation'),
    `${label}.documentation`
  );
  const out: PatchPolicyReservedAllowedPatch = { filename };
  if (parsedFiles !== undefined) out.files = parsedFiles;
  if (adr !== undefined) out.adr = adr;
  if (documentation !== undefined) out.documentation = documentation;
  return out;
}

function parsePatchPolicyReservedRange(raw: unknown, label: string): PatchPolicyReservedRange {
  const { rec, from, to } = parseRangeBounds(raw, label);
  const allowedRaw = rec.raw('allowed');
  if (!Array.isArray(allowedRaw)) {
    throw new ConfigError(`Config field "${label}.allowed" must be an array`);
  }
  return {
    from,
    to,
    allowed: allowedRaw.map((entry, index) =>
      parseReservedAllowedPatch(entry, `${label}.allowed[${index}]`)
    ),
  };
}

function assertPolicyRangesDoNotOverlap(
  ranges: ReadonlyArray<{ from: number; to: number }>,
  label: string
): void {
  const sorted = [...ranges].sort((a, b) => a.from - b.from || a.to - b.to);
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (previous && current && current.from <= previous.to) {
      throw new ConfigError(
        `Config field "${label}" must not contain overlapping ranges (${previous.from}-${previous.to} overlaps ${current.from}-${current.to})`
      );
    }
  }
}

/** Parses and validates the optional patch policy config block. */
export function parsePatchPolicyBlock(rec: ParsedRecord): PatchPolicyConfig {
  const out: PatchPolicyConfig = { ranges: [] };

  const filenamePattern = optionalConfigString(
    rec,
    'filenamePattern',
    'patchPolicy.filenamePattern'
  );
  if (filenamePattern !== undefined) {
    try {
      new RegExp(filenamePattern);
    } catch (error: unknown) {
      throw new ConfigError(
        `Config field "patchPolicy.filenamePattern" must be a valid regular expression: ${toError(error).message}`
      );
    }
    out.filenamePattern = filenamePattern;
  }

  const requireDescription = rec.raw('requireDescription');
  if (requireDescription !== undefined) {
    if (typeof requireDescription !== 'boolean') {
      throw new ConfigError('Config field "patchPolicy.requireDescription" must be a boolean');
    }
    out.requireDescription = requireDescription;
  }

  const allowGaps = rec.raw('allowGaps');
  if (allowGaps !== undefined) {
    if (typeof allowGaps !== 'boolean') {
      throw new ConfigError('Config field "patchPolicy.allowGaps" must be a boolean');
    }
    out.allowGaps = allowGaps;
  }

  const mutationMode = rec.raw('mutationMode');
  if (mutationMode !== undefined) {
    if (
      typeof mutationMode !== 'string' ||
      !(PATCH_POLICY_MUTATION_MODES as readonly string[]).includes(mutationMode)
    ) {
      throw new ConfigError(
        `Config field "patchPolicy.mutationMode" must be one of: ${PATCH_POLICY_MUTATION_MODES.join(', ')}`
      );
    }
    out.mutationMode = mutationMode as PatchPolicyMutationMode;
  }

  const rangesRaw = rec.raw('ranges');
  if (!Array.isArray(rangesRaw) || rangesRaw.length === 0) {
    throw new ConfigError('Config field "patchPolicy.ranges" must be a non-empty array');
  }
  out.ranges = rangesRaw.map((entry, index) =>
    parsePatchPolicyRange(entry, `patchPolicy.ranges[${index}]`)
  );
  assertPolicyRangesDoNotOverlap(out.ranges, 'patchPolicy.ranges');

  const reservedRangesRaw = rec.raw('reservedRanges');
  if (reservedRangesRaw !== undefined) {
    if (!Array.isArray(reservedRangesRaw)) {
      throw new ConfigError('Config field "patchPolicy.reservedRanges" must be an array');
    }
    out.reservedRanges = reservedRangesRaw.map((entry, index) =>
      parsePatchPolicyReservedRange(entry, `patchPolicy.reservedRanges[${index}]`)
    );
    assertPolicyRangesDoNotOverlap(out.reservedRanges, 'patchPolicy.reservedRanges');
  }

  return out;
}
