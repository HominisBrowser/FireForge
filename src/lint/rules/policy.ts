// SPDX-License-Identifier: EUPL-1.2
/**
 * `patchPolicy` over the owned changes: which upstream files a group may
 * change and how, which files a class of group may touch, and that the
 * documents behind reviewed exceptions exist.
 *
 * A path is upstream when its first owned step is not a create. A group
 * named by a `reservedRanges[].allowed` entry is an exception: it may
 * change the upstream files the entry lists (any, when it lists none)
 * outside `upstreamAllowlist`, and its list must not name an upstream file
 * it no longer changes. Every other group may change an upstream file only
 * when an allowlist glob matches it; under an `addOnly` entry it may only
 * add lines, each carrying the marker, and remove lines that name one of
 * the entry's `retiredPaths`.
 */
import { join } from 'node:path';

import type { PatchPolicyConfig } from '../../config/index.js';
import { exists } from '../../kernel/fs.js';
import { matchesAnyGlob } from '../../kernel/glob.js';
import type { OwnedChange } from '../../project/index.js';
import type { Draft, Rule, RuleContext, Severity } from '../rule.js';

type AllowEntry = Exclude<NonNullable<PatchPolicyConfig['upstreamAllowlist']>[number], string>;
type Exception = NonNullable<PatchPolicyConfig['reservedRanges']>[number]['allowed'][number];

function severityOf(policy: PatchPolicyConfig): Severity {
  return policy.mutationMode === 'warn' ? 'warning' : 'error';
}

function exceptionFor(policy: PatchPolicyConfig, group: string | undefined): Exception | undefined {
  if (group === undefined) return undefined;
  return (policy.reservedRanges ?? [])
    .flatMap((range) => range.allowed)
    .find((entry) => entry.filename === group);
}

/** The steps that change upstream paths, by group (`''` for ungrouped steps). */
function upstreamSteps(context: RuleContext): Map<string, OwnedChange[]> {
  const byGroup = new Map<string, OwnedChange[]>();
  for (const step of context.changes.changes) {
    if (context.changes.at(step.path)[0]?.kind === 'create') continue;
    const key = step.group ?? '';
    byGroup.set(key, [...(byGroup.get(key) ?? []), step]);
  }
  return byGroup;
}

const label = (group: string): string => (group === '' ? 'Ungrouped changes' : group);

async function addOnlyViolation(
  context: RuleContext,
  step: OwnedChange,
  marker: string,
  retired: readonly string[]
): Promise<string | undefined> {
  if (step.kind === 'delete') return 'deletes the file';
  if (step.binary) return 'changes it as binary';
  const removed = (await context.owned.removed(step)).filter(
    (line) => line.trim() !== '' && !retired.some((path) => line.includes(path))
  );
  if (removed.length > 0) {
    return `removes ${removed.length} line(s), first: ${JSON.stringify(removed[0])}`;
  }
  const unmarked = (await context.owned.added(step)).filter(
    (entry) => entry.text.trim() !== '' && !entry.text.toLowerCase().includes(marker.toLowerCase())
  );
  const [first] = unmarked;
  if (first === undefined) return undefined;
  return `adds ${unmarked.length} line(s) without the "${marker}" marker, first: ${JSON.stringify(first.text)}`;
}

function exceptionDrafts(
  context: RuleContext,
  group: string,
  steps: readonly OwnedChange[],
  exception: Exception
): Draft[] {
  if (exception.files === undefined) return [];
  const listed = new Set(exception.files);
  const changed = new Set(steps.map((step) => step.path));
  const outside = [...changed].filter((path) => !listed.has(path)).sort();
  const stale = exception.files.filter(
    (path) => !changed.has(path) && context.changes.at(path)[0]?.kind !== 'create'
  );
  const drafts: Draft[] = [];
  if (outside.length > 0) {
    drafts.push({
      group,
      message: `${group} is a reviewed exception, but changes upstream file(s) its entry does not list: ${outside.join(', ')}.`,
    });
  }
  if (stale.length > 0) {
    drafts.push({
      group,
      message: `${group}'s exception lists upstream file(s) it no longer changes: ${stale.join(', ')}. Update the entry.`,
    });
  }
  return drafts;
}

const upstreamAllowlist: Rule = {
  id: 'upstream-allowlist',
  severity: 'error',
  description: 'Upstream files change only where patchPolicy allows it',
  check(context) {
    const policy = context.config.patchPolicy;
    if (policy === undefined) return [];
    const severity = severityOf(policy);
    const globs = (policy.upstreamAllowlist ?? []).map((entry) =>
      typeof entry === 'string' ? entry : entry.path
    );
    const drafts: Draft[] = [];
    for (const [group, steps] of upstreamSteps(context)) {
      const exception = exceptionFor(policy, group);
      if (exception !== undefined) {
        drafts.push(
          ...exceptionDrafts(context, group, steps, exception).map((d) => ({ ...d, severity }))
        );
        continue;
      }
      if (policy.upstreamAllowlist === undefined) continue;
      const outside = [...new Set(steps.map((step) => step.path))]
        .filter((path) => !matchesAnyGlob(path, globs))
        .sort();
      if (outside.length === 0) continue;
      drafts.push({
        ...(group === '' ? {} : { group }),
        severity,
        message:
          `${label(group)} change(s) upstream file(s) outside patchPolicy.upstreamAllowlist: ` +
          `${outside.join(', ')}. Move the change into a project-owned file, or add a reviewed allowlist entry.`,
      });
    }
    return drafts;
  },
};

const addOnly: Rule = {
  id: 'add-only',
  severity: 'error',
  description: 'Add-only upstream files only gain lines carrying the marker',
  async check(context) {
    const policy = context.config.patchPolicy;
    const entries = (policy?.upstreamAllowlist ?? []).filter(
      (entry): entry is AllowEntry => typeof entry !== 'string' && entry.addOnly === true
    );
    if (policy === undefined || entries.length === 0) return [];
    const drafts: Draft[] = [];
    for (const [group, steps] of upstreamSteps(context)) {
      if (exceptionFor(policy, group) !== undefined) continue;
      for (const step of steps) {
        const matching = entries.filter((entry) => matchesAnyGlob(step.path, [entry.path]));
        const [first] = matching;
        if (first === undefined) continue;
        const marker = first.marker ?? policy.addOnlyMarker ?? '';
        const retired = matching.flatMap((entry) => entry.retiredPaths ?? []);
        const violation = await addOnlyViolation(context, step, marker, retired);
        if (violation === undefined) continue;
        drafts.push({
          path: step.path,
          ...(group === '' ? {} : { group }),
          severity: severityOf(policy),
          message: `${label(group)} edits this add-only upstream file (added lines carry "${marker}"), but ${violation}.`,
        });
      }
    }
    return drafts;
  },
};

const scope: Rule = {
  id: 'scope',
  severity: 'error',
  description: 'Groups a scope rule selects touch only the files it names',
  check(context) {
    const policy = context.config.patchPolicy;
    if (policy === undefined) return [];
    return (policy.scopeRules ?? []).flatMap((rule, index) =>
      context.changes.groups
        .filter((group) => new RegExp(rule.group).test(group.id))
        .flatMap((group): Draft[] => {
          const outside = context.changes
            .inGroup(group.id)
            .map((step) => step.path)
            .filter((path) => !matchesAnyGlob(path, rule.files));
          if (outside.length === 0) return [];
          return [
            {
              group: group.id,
              severity: severityOf(policy),
              message:
                `${group.id} is scoped by patchPolicy.scopeRules[${index}] to ${rule.files.join(', ')}, ` +
                `but touches: ${outside.join(', ')}. Move those files to a group of the class that owns them.`,
            },
          ];
        })
    );
  },
};

const documents: Rule = {
  id: 'policy-document-missing',
  severity: 'error',
  description: 'The decision records and documents of reviewed exceptions exist',
  async check(context) {
    const policy = context.config.patchPolicy;
    if (policy?.verifyDocumentPaths !== true) return [];
    const drafts: Draft[] = [];
    for (const entry of (policy.reservedRanges ?? []).flatMap((range) => range.allowed)) {
      for (const [field, path] of [
        ['adr', entry.adr],
        ['documentation', entry.documentation],
      ] as const) {
        if (path === undefined || (await exists(join(context.projectRoot, path)))) continue;
        drafts.push({
          group: entry.filename,
          severity: severityOf(policy),
          message: `${entry.filename}'s exception names ${field} "${path}", which does not exist. Restore it or correct the path.`,
        });
      }
    }
    return drafts;
  },
};

/** The policy rules. */
export const policyRules: readonly Rule[] = [upstreamAllowlist, addOnly, scope, documents];
