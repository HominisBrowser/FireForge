// SPDX-License-Identifier: EUPL-1.2
import { createHash } from 'node:crypto';

import { GeneralError } from '../errors/base.js';
import type { LintIgnoreEntry, PatchesManifest, PatchLintIssue } from '../types/commands/index.js';
import { isObject } from '../utils/validation.js';
import { canonicalJson, readSourceBlob, sourcePathText } from './authored/git.js';
import { assertSourcePath } from './authored/paths.js';
import type { AuthoredSnapshot } from './authored/types.js';
import {
  buildLintIgnoreChecks,
  isLintIgnored,
  parseLintIgnoreEntries,
} from './patch-lint-ignore.js';
import { validatePatchesManifest } from './patch-manifest-validate.js';

export interface AuthoredWaiver {
  component: string;
  paths: string[];
  checks: LintIgnoreEntry[];
  tier?: 'branding';
}

async function capturedMetadata(
  snapshot: AuthoredSnapshot,
  name: string
): Promise<Buffer | undefined> {
  const root = snapshot.config.sources?.metadataRoot;
  const entry = snapshot.inputs.find((input) => input.path === `${root}/${name}`);
  return entry ? readSourceBlob(snapshot.repository, entry.blob) : undefined;
}

/** Authenticate the frozen path map against the exact archived original manifest. */
export async function readAuthoredLegacyManifest(
  snapshot: AuthoredSnapshot
): Promise<PatchesManifest | undefined> {
  const rawMap = await capturedMetadata(snapshot, 'cutover-map.json');
  const archive = await capturedMetadata(snapshot, 'legacy-manifest.json');
  if (!rawMap && !archive) return undefined;
  if (!rawMap || !archive) throw new GeneralError('authored-waiver-provenance-missing');
  const frozen: unknown = JSON.parse(sourcePathText(rawMap));
  const provenance = createHash('sha256').update(archive).digest('hex');
  if (
    !isObject(frozen) ||
    frozen['schemaVersion'] !== 1 ||
    frozen['frozen'] !== true ||
    frozen['provenance'] !== provenance ||
    !isObject(frozen['paths'])
  )
    throw new GeneralError('authored-waiver-provenance-invalid');
  const manifest = validatePatchesManifest(JSON.parse(sourcePathText(archive)) as unknown);
  const expected = new Map<string, string[]>();
  for (const row of manifest.patches) {
    for (const path of row.filesAffected) {
      assertSourcePath(path);
      expected.set(path, [...(expected.get(path) ?? []), row.filename]);
    }
  }
  const actual = frozen['paths'];
  if (Object.keys(actual).length !== expected.size)
    throw new GeneralError('authored-waiver-path-map-changed');
  for (const [path, owners] of expected) {
    const mapped = actual[path];
    if (
      !Array.isArray(mapped) ||
      !mapped.every((owner: unknown) => typeof owner === 'string') ||
      canonicalJson([...mapped].sort()) !== canonicalJson(owners.sort())
    )
      throw new GeneralError('authored-waiver-path-map-changed');
  }
  return manifest;
}

/** Original checks, ceilings and tiers cannot be widened by editing a matching hash label. */
export async function authoredWaivers(snapshot: AuthoredSnapshot): Promise<AuthoredWaiver[]> {
  const bytes = await capturedMetadata(snapshot, 'waivers.json');
  if (!bytes) return [];
  const manifest = await readAuthoredLegacyManifest(snapshot);
  const archive = await capturedMetadata(snapshot, 'legacy-manifest.json');
  if (!manifest || !archive) throw new GeneralError('authored-waiver-provenance-missing');
  const provenance = createHash('sha256').update(archive).digest('hex');
  const value: unknown = JSON.parse(sourcePathText(bytes));
  if (!isObject(value) || value['schemaVersion'] !== 1 || !Array.isArray(value['exceptions']))
    throw new GeneralError('authored-waiver-schema');
  const seen = new Set<string>();
  return (value['exceptions'] as unknown[]).map((row): AuthoredWaiver => {
    if (
      !isObject(row) ||
      typeof row['component'] !== 'string' ||
      !Array.isArray(row['paths']) ||
      !row['paths'].every((path: unknown) => typeof path === 'string') ||
      row['provenance'] !== provenance ||
      (row['tier'] !== undefined && row['tier'] !== 'branding')
    )
      throw new GeneralError('authored-waiver-schema');
    const component = row['component'];
    const original = manifest.patches.find((patch) => patch.filename === component);
    if (!original || seen.has(component))
      throw new GeneralError('authored-waiver-component-changed');
    seen.add(component);
    const owned: string[] = row['paths'];
    if (
      new Set(owned).size !== owned.length ||
      owned.some((path) => !original.filesAffected.includes(path))
    )
      throw new GeneralError('authored-waiver-path-widened');
    const checks = parseLintIgnoreEntries(row['checks'], `source waiver ${component}`);
    if (
      canonicalJson(checks) !== canonicalJson(original.lintIgnore ?? []) ||
      row['tier'] !== original.tier
    )
      throw new GeneralError('authored-waiver-checks-widened');
    return {
      component,
      paths: owned,
      checks,
      ...(row['tier'] === 'branding' ? { tier: 'branding' } : {}),
    };
  });
}

/** Only matching migrated paths/checks are waived; ceiling overgrowth stays an error. */
export function applyAuthoredWaivers(
  issues: readonly PatchLintIssue[],
  waivers: readonly AuthoredWaiver[]
): PatchLintIssue[] {
  return issues.filter(
    (issue) =>
      !waivers.some(
        (waiver) =>
          (waiver.paths.includes(issue.file) || waiver.component === issue.file) &&
          isLintIgnored(issue, buildLintIgnoreChecks(waiver.checks))
      )
  );
}
