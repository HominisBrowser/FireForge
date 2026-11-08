// SPDX-License-Identifier: EUPL-1.2
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { sourceFixture, writeAt } from '../authored/__tests__/fixtures.js';
import { captureAuthoredSnapshot } from '../authored/capture.js';
import { digest } from '../authored/git.js';
import { authoredScopeRuleId, evaluateAuthoredSourcePolicy } from '../authored-policy.js';
import { authoredWaivers } from '../authored-waivers.js';
import { evaluateAuthoredUpstreamPolicy } from '../patch-policy-content.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function migrationFixture(): Promise<
  Awaited<ReturnType<typeof sourceFixture>> & {
    component: string;
    provenance: string;
    checks: { rule: string; max: number; reason: string }[];
  }
> {
  const value = await sourceFixture();
  directories.push(dirname(value.root));
  const component = '123-infra-module.patch';
  const checks = [{ rule: 'file-too-large', max: 100, reason: 'Original ceiling.' }];
  const archive = JSON.stringify({
    version: 1,
    patches: [
      {
        filename: component,
        order: 123,
        category: 'infra',
        name: 'module',
        description: 'Archived original',
        createdAt: '2026-11-05T00:00:00.000Z',
        sourceEsrVersion: value.config.firefox.version,
        filesAffected: ['browser/new.js'],
        lintIgnore: checks,
      },
    ],
  });
  const provenance = createHash('sha256').update(archive).digest('hex');
  await writeAt(value.root, '.fireforge-sources/legacy-manifest.json', archive);
  await writeAt(
    value.root,
    '.fireforge-sources/cutover-map.json',
    JSON.stringify({
      schemaVersion: 1,
      frozen: true,
      provenance,
      paths: { 'browser/new.js': [component] },
    })
  );
  return { ...value, component, provenance, checks };
}

async function capture(
  value: Awaited<ReturnType<typeof sourceFixture>>
): Promise<Awaited<ReturnType<typeof captureAuthoredSnapshot>>> {
  return captureAuthoredSnapshot({
    projectRoot: value.root,
    intendedPaths: ['src', 'docs'],
    pristineRepository: value.pristine,
  });
}

it('requires an explicit approved ADR decision before retiring created-file patch budgets', async () => {
  const value = await migrationFixture();
  await expect(evaluateAuthoredSourcePolicy(await capture(value))).rejects.toThrow(
    'policy-migration-required'
  );
  await writeAt(value.root, 'docs/source-policy.md', 'Reviewed source-policy migration');
  const policy = {
    schemaVersion: 1,
    status: 'approved',
    adr: 'docs/source-policy.md',
    legacyScopeDigest: digest([]),
    scopeRules: [],
  };
  await writeAt(value.root, '.fireforge-sources/policy.json', JSON.stringify(policy));
  await expect(evaluateAuthoredSourcePolicy(await capture(value))).rejects.toThrow(
    'created-budget-decision-required'
  );
  await writeAt(
    value.root,
    '.fireforge-sources/policy.json',
    JSON.stringify({
      ...policy,
      retireCreatedPatchBudgets: true,
      createdPatchBudgetReason:
        'Review units are native source changes; file and module limits remain.',
    })
  );
  expect(await evaluateAuthoredSourcePolicy(await capture(value))).toEqual([]);
});

it('requires every original scope decision, refuses a widened retained rule and checks historical selection coverage', async () => {
  const value = await migrationFixture();
  const rule = { category: 'infra', files: ['browser/**'] };
  value.config.patchPolicy = {
    ranges: [{ from: 1, to: 899, category: 'infra' }],
    scopeRules: [rule],
  };
  await writeAt(value.root, 'fireforge.json', JSON.stringify(value.config));
  await writeAt(value.root, 'docs/source-policy.md', 'Reviewed source-policy migration');
  const policy = {
    schemaVersion: 1,
    status: 'approved',
    adr: 'docs/source-policy.md',
    legacyScopeDigest: digest([rule]),
    retireCreatedPatchBudgets: true,
    createdPatchBudgetReason: 'Native source review unit.',
    scopeRules: [] as unknown[],
  };
  await writeAt(value.root, '.fireforge-sources/policy.json', JSON.stringify(policy));
  await expect(evaluateAuthoredSourcePolicy(await capture(value))).rejects.toThrow(
    'scope-decision-missing'
  );
  const retained = {
    legacyRule: authoredScopeRuleId(rule, 0),
    decision: 'retain',
    reason: 'Preserve the browser module boundary.',
    select: ['browser/**'],
    allow: ['**'],
  };
  await writeAt(
    value.root,
    '.fireforge-sources/policy.json',
    JSON.stringify({ ...policy, scopeRules: [retained] })
  );
  await expect(evaluateAuthoredSourcePolicy(await capture(value))).rejects.toThrow(
    'retained-scope-widened'
  );
  await writeAt(
    value.root,
    '.fireforge-sources/policy.json',
    JSON.stringify({
      ...policy,
      scopeRules: [{ ...retained, select: ['tests/**'], allow: rule.files }],
    })
  );
  await expect(evaluateAuthoredSourcePolicy(await capture(value))).rejects.toThrow(
    'retained-scope-uncovered'
  );
  await writeAt(
    value.root,
    '.fireforge-sources/policy.json',
    JSON.stringify({ ...policy, scopeRules: [{ ...retained, allow: rule.files }] })
  );
  expect(await evaluateAuthoredSourcePolicy(await capture(value))).toEqual([]);
  await writeAt(
    value.root,
    '.fireforge-sources/policy.json',
    JSON.stringify({
      ...policy,
      scopeRules: [
        {
          legacyRule: authoredScopeRuleId(rule, 0),
          decision: 'retire',
          reason: 'The ADR replaces the old category unit explicitly.',
        },
      ],
    })
  );
  expect(await evaluateAuthoredSourcePolicy(await capture(value))).toEqual([]);
});

it('authenticates waiver ceilings, tiers and path maps against original manifest bytes', async () => {
  const value = await migrationFixture();
  const original = {
    component: value.component,
    paths: ['browser/new.js'],
    checks: value.checks,
    provenance: value.provenance,
  };
  const write = async (exception: unknown): Promise<void> =>
    writeAt(
      value.root,
      '.fireforge-sources/waivers.json',
      JSON.stringify({ schemaVersion: 1, exceptions: [exception] })
    );
  await write(original);
  expect(await authoredWaivers(await capture(value))).toHaveLength(1);
  await write({ ...original, checks: [{ ...value.checks[0], max: 1000 }] });
  await expect(authoredWaivers(await capture(value))).rejects.toThrow('checks-widened');
  await write({ ...original, tier: 'branding' });
  await expect(authoredWaivers(await capture(value))).rejects.toThrow('checks-widened');
  await write(original);
  await writeAt(
    value.root,
    '.fireforge-sources/cutover-map.json',
    JSON.stringify({
      schemaVersion: 1,
      frozen: true,
      provenance: value.provenance,
      paths: { 'browser/other.js': [value.component] },
    })
  );
  await expect(authoredWaivers(await capture(value))).rejects.toThrow('path-map-changed');
});

it('refuses registration-only executable-bit changes and tombstones even on an allowlisted path', async () => {
  const value = await sourceFixture();
  directories.push(dirname(value.root));
  value.config.patchPolicy = {
    ranges: [{ from: 1, to: 899, category: 'infra' }],
    upstreamAllowlist: ['browser/manifest.txt'],
  };
  const diff =
    'diff --git a/browser/manifest.txt b/browser/manifest.txt\nold mode 100644\nnew mode 100755\n';
  const delta = { path: value.declaration.path, declaration: value.declaration, diff };
  expect(
    (await evaluateAuthoredUpstreamPolicy(value.config, value.root, [delta])).some((issue) =>
      issue.message.includes('mode changes')
    )
  ).toBe(true);
  expect(
    (
      await evaluateAuthoredUpstreamPolicy(value.config, value.root, [
        { ...delta, declaration: { ...value.declaration, kind: 'delete' } },
      ])
    ).some((issue) => issue.severity === 'error')
  ).toBe(true);
  const component = '900-infra-mode.patch';
  const adr = 'docs/mode.md';
  value.config.patchPolicy.reservedRanges = [
    { from: 900, to: 999, allowed: [{ filename: component, adr, files: [delta.path] }] },
  ];
  expect(
    await evaluateAuthoredUpstreamPolicy(value.config, value.root, [
      {
        ...delta,
        declaration: { ...value.declaration, component, classification: 'exception', adr },
      },
    ])
  ).toEqual([]);
});
