// SPDX-License-Identifier: EUPL-1.2
import { GeneralError } from '../errors/base.js';
import type { PatchLintIssue, PatchMetadata } from '../types/commands/index.js';
import type { PatchPolicyScopeRule } from '../types/config.js';
import { matchesAnyGlob } from '../utils/path-glob.js';
import { isObject } from '../utils/validation.js';
import { canonicalJson, digest, readSourceBlob, sourcePathText } from './authored/git.js';
import { assertSourcePath } from './authored/paths.js';
import type { AuthoredSnapshot } from './authored/types.js';
import { readAuthoredLegacyManifest } from './authored-waivers.js';

/** A stable rule identity includes its position so duplicate legacy rules remain explicit. */
export function authoredScopeRuleId(rule: PatchPolicyScopeRule, index: number): string {
  return digest({ index, rule });
}

function selectedLegacyPaths(rule: PatchPolicyScopeRule, rows: readonly PatchMetadata[]): string[] {
  return [
    ...new Set(
      rows
        .filter(
          (row) =>
            (rule.category === undefined || row.category === rule.category) &&
            (rule.filenamePattern === undefined ||
              new RegExp(rule.filenamePattern).test(row.filename))
        )
        .flatMap((row) => row.filesAffected)
    ),
  ];
}

function stringPatterns(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new GeneralError(`authored-policy-migration-invalid: ${label}`);
  const patterns: string[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'string' || entry.length === 0)
      throw new GeneralError(`authored-policy-migration-invalid: ${label}`);
    patterns.push(entry);
  }
  return patterns;
}

function approvedPolicy(
  value: unknown,
  rules: readonly PatchPolicyScopeRule[]
): {
  adr: string;
  decisions: unknown[];
  retireCreatedPatchBudgets: unknown;
  createdPatchBudgetReason: unknown;
} {
  if (
    !isObject(value) ||
    value['schemaVersion'] !== 1 ||
    value['status'] !== 'approved' ||
    typeof value['adr'] !== 'string' ||
    value['legacyScopeDigest'] !== digest(rules) ||
    !Array.isArray(value['scopeRules'])
  )
    throw new GeneralError(
      'authored-policy-migration-invalid: pending or mismatched policy decisions'
    );
  assertSourcePath(value['adr']);
  return {
    adr: value['adr'],
    decisions: value['scopeRules'] as unknown[],
    retireCreatedPatchBudgets: value['retireCreatedPatchBudgets'],
    createdPatchBudgetReason: value['createdPatchBudgetReason'],
  };
}

function evaluateRetainedScope(
  snapshot: AuthoredSnapshot,
  legacy: PatchPolicyScopeRule,
  paths: readonly string[],
  row: Record<string, unknown>
): PatchLintIssue[] {
  const select = stringPatterns(row['select'], 'select');
  const allow = stringPatterns(row['allow'], 'allow');
  if (canonicalJson([...allow].sort()) !== canonicalJson([...legacy.files].sort()))
    throw new GeneralError('authored-policy-retained-scope-widened');
  if (paths.some((path) => !matchesAnyGlob(path, select)))
    throw new GeneralError('authored-policy-retained-scope-uncovered');
  return snapshot.files
    .filter((file) => matchesAnyGlob(file.path, select) && !matchesAnyGlob(file.path, allow))
    .map((file) => ({
      file: file.path,
      check: 'source-scope',
      severity: 'error',
      message: 'Authored file violates the approved source-native scope policy.',
    }));
}

/** No legacy scope or created-patch budget disappears without an explicit captured ADR decision. */
export async function evaluateAuthoredSourcePolicy(
  snapshot: AuthoredSnapshot
): Promise<PatchLintIssue[]> {
  const rules = snapshot.config.patchPolicy?.scopeRules ?? [];
  const legacy = await readAuthoredLegacyManifest(snapshot);
  if (rules.length === 0 && !legacy) return [];
  const root = snapshot.config.sources?.metadataRoot;
  const entry = snapshot.inputs.find((input) => input.path === `${root}/policy.json`);
  if (!entry)
    throw new GeneralError(
      'authored-policy-migration-required: approve the source-native policy ADR before source proof'
    );
  const policy = approvedPolicy(
    JSON.parse(sourcePathText(await readSourceBlob(snapshot.repository, entry.blob))) as unknown,
    rules
  );
  if (!snapshot.inputs.some((input) => input.path === policy.adr))
    throw new GeneralError('authored-policy-adr-missing');
  if (
    legacy &&
    (policy.retireCreatedPatchBudgets !== true ||
      typeof policy.createdPatchBudgetReason !== 'string' ||
      policy.createdPatchBudgetReason.trim() === '')
  )
    throw new GeneralError('authored-created-budget-decision-required');
  if (policy.decisions.length !== rules.length)
    throw new GeneralError('authored-policy-scope-decision-missing');
  const decisions = policy.decisions;
  const seen = new Set<string>();
  const issues: PatchLintIssue[] = [];
  for (const value of decisions) {
    if (
      !isObject(value) ||
      typeof value['legacyRule'] !== 'string' ||
      (value['decision'] !== 'retain' && value['decision'] !== 'retire') ||
      typeof value['reason'] !== 'string' ||
      value['reason'].trim() === ''
    )
      throw new GeneralError(
        'authored-policy-migration-invalid: each rule needs a reasoned decision'
      );
    const id = value['legacyRule'];
    const index = rules.findIndex((rule, ordinal) => authoredScopeRuleId(rule, ordinal) === id);
    const rule = rules[index];
    if (!rule || seen.has(id)) throw new GeneralError('authored-policy-scope-decision-missing');
    seen.add(id);
    if (value['decision'] === 'retain')
      issues.push(
        ...evaluateRetainedScope(
          snapshot,
          rule,
          selectedLegacyPaths(rule, legacy?.patches ?? []),
          value
        )
      );
  }
  return issues;
}
