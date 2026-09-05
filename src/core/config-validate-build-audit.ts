// SPDX-License-Identifier: EUPL-1.2
/**
 * Validation for the `buildAudit` block.
 *
 * Split out of `config-validate.ts`, which is at its per-file line budget,
 * following the `config-validate-file-size.ts` precedent.
 *
 * The rules here are stricter than the schema strictly needs, and
 * deliberately so: every entry is a standing suppression of a warning the
 * audit would otherwise raise. A malformed one must fail loudly at config
 * load rather than quietly admit nothing (leaving the operator believing a
 * path is carved out) or quietly admit everything.
 */
import { ConfigError } from '../errors/config.js';
import type { BuildAuditConfig, BuildAuditUnpackagedDeclaration } from '../types/config.js';
import { isContainedRelativePath } from '../utils/paths.js';
import { isObject } from '../utils/validation.js';

/** Parses one `buildAudit.unpackaged[]` entry. */
function parseUnpackagedEntry(raw: unknown, field: string): BuildAuditUnpackagedDeclaration {
  if (!isObject(raw)) {
    throw new ConfigError(
      `Config field "${field}" must be a plain object with "path" and "reason"`
    );
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'path' && key !== 'reason') {
      throw new ConfigError(`Config field "${field}" has unknown key "${key}"`);
    }
  }
  const path = raw['path'];
  if (typeof path !== 'string' || path.trim().length === 0) {
    throw new ConfigError(`Config field "${field}.path" must be a non-empty string`);
  }
  if (!isContainedRelativePath(path)) {
    throw new ConfigError(`Config field "${field}.path" must be an engine-relative path`);
  }
  if (path.includes('**')) {
    // A `**` carve-out admits an entire subtree, which is how a reviewed
    // exception quietly becomes a blanket one. `*` inside a single segment
    // is enough for the shapes this exists for.
    throw new ConfigError(
      `Config field "${field}.path" must not use "**" — a carve-out may glob within one path segment only`
    );
  }
  const reason = raw['reason'];
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    // Required on purpose: this is the one audit class FireForge cannot
    // derive from the tree, so the declaration IS the evidence.
    throw new ConfigError(
      `Config field "${field}.reason" must be a non-empty string explaining why the file is never packaged`
    );
  }
  return { path, reason };
}

/**
 * Parses the `buildAudit` block.
 *
 * @param raw - The raw `buildAudit` value from fireforge.json
 * @returns The validated block
 */
export function parseBuildAuditConfig(raw: unknown): BuildAuditConfig {
  if (!isObject(raw)) {
    throw new ConfigError('Config field "buildAudit" must be a plain object');
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'unpackaged') {
      throw new ConfigError(`Config field "buildAudit" has unknown key "${key}"`);
    }
  }
  const unpackaged = raw['unpackaged'];
  if (unpackaged === undefined) return {};
  if (!Array.isArray(unpackaged)) {
    throw new ConfigError('Config field "buildAudit.unpackaged" must be an array');
  }
  const entries = unpackaged.map((entry, index) =>
    parseUnpackagedEntry(entry, `buildAudit.unpackaged[${String(index)}]`)
  );
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.path)) {
      // Two rows for one path means one of the two reasons is not the
      // operative one, and nothing says which.
      throw new ConfigError(
        `Config field "buildAudit.unpackaged" declares "${entry.path}" more than once`
      );
    }
    seen.add(entry.path);
  }
  return { unpackaged: entries };
}
