// SPDX-License-Identifier: EUPL-1.2
import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { sourceFixture, writeAt } from '../authored/__tests__/fixtures.js';
import { captureAuthoredSnapshot } from '../authored/capture.js';
import { digest, readSourceBlobs } from '../authored/git.js';
import {
  authoredGateContext,
  checkAuthoredTypes,
  lintAuthoredSource,
  verifyAuthoredSource,
} from '../authored-gates.js';
import { authoredScopeRuleId } from '../authored-policy.js';
import { applyAuthoredWaivers, authoredWaivers } from '../authored-waivers.js';
import { createDefaultFurnaceConfig } from '../furnace-config.js';
import { readAdmittedSnapshot } from '../jobs/guard.js';
import type { SlotRecord } from '../jobs/slot-types.js';
import {
  invokePatchLintCheckJsGrouped,
  runCheckJsTestFilesGrouped,
} from '../patch-lint-checkjs.js';

vi.mock('../jobs/guard.js', () => ({ readAdmittedSnapshot: vi.fn() }));
vi.mock('../patch-lint-checkjs.js', () => ({
  invokePatchLintCheckJsGrouped: vi.fn(() => Promise.resolve({ global: [], byFile: new Map() })),
  runCheckJsTestFilesGrouped: vi.fn(() => Promise.resolve({ global: [], byFile: new Map() })),
}));
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function fixture(): Promise<Awaited<ReturnType<typeof sourceFixture>>> {
  const value = await sourceFixture();
  directories.push(dirname(value.root));
  return value;
}
async function admitted(
  value: Awaited<ReturnType<typeof sourceFixture>>
): Promise<Awaited<ReturnType<typeof authoredGateContext>>> {
  const snapshot = await captureAuthoredSnapshot({
    projectRoot: value.root,
    intendedPaths: ['src', '.fireforge-sources', 'docs'],
    pristineRepository: value.pristine,
  });
  const slot: SlotRecord = {
    schemaVersion: 1,
    id: 'a',
    root: value.root,
    pristineRepository: value.pristine,
    pin: value.commit,
    sourceId: snapshot.id,
    generation: 1,
    successfulBuildGeneration: 1,
    inputs: snapshot.inputs.map((entry) => entry.path),
    quarantined: null,
    storage: { reservedBytes: 0, memoryBytes: 0, floorBytes: 0 },
  };
  vi.stubEnv('FIREFORGE_JOB_ID', 'owned-job');
  vi.mocked(readAdmittedSnapshot).mockResolvedValue({
    snapshot,
    pristineRepository: value.pristine,
    slot,
    phase: 'one-owned-static-phase',
  });
  await mkdir(join(value.root, 'engine/browser'), { recursive: true });
  const blobs = await readSourceBlobs(
    snapshot.repository,
    snapshot.files.flatMap((file) => (file.blob ? [file.blob] : []))
  );
  for (const file of snapshot.files) {
    if (file.blob)
      await writeAt(
        value.root,
        `engine/${file.path}`,
        blobs.get(file.blob) ?? Buffer.alloc(0),
        file.mode === '100755'
      );
  }
  return authoredGateContext(value.root);
}

describe('authored source gates', () => {
  it('checks actual captured objects after admission', async () => {
    const value = await fixture();
    const context = await admitted(value);
    expect(context.snapshot.id).toBeTruthy();
    expect(context.phase).toBe('one-owned-static-phase');
    expect(await verifyAuthoredSource(value.root)).toEqual([]);
    const issues = await lintAuthoredSource(value.root);
    expect(issues.some((issue) => issue.check === 'missing-license-header')).toBe(true);
  });

  it('builds strict source programs once per authenticated phase', async () => {
    const value = await fixture();
    value.config.patchLint = { checkJs: true, checkJsTestFiles: true };
    await writeAt(value.root, 'fireforge.json', JSON.stringify(value.config));
    const context = await admitted(value);
    await checkAuthoredTypes(context);
    await checkAuthoredTypes(context);
    expect(invokePatchLintCheckJsGrouped).toHaveBeenCalledTimes(1);
    expect(runCheckJsTestFilesGrouped).toHaveBeenCalledTimes(1);
    await checkAuthoredTypes({ ...context, phase: 'different-phase' });
    expect(invokePatchLintCheckJsGrouped).toHaveBeenCalledTimes(2);
    await expect(checkAuthoredTypes({ ...context, phase: '' })).rejects.toThrow(
      'unowned-type-phase'
    );
    const scope = new Set(['browser/new.js']);
    await checkAuthoredTypes(context, scope);
    await checkAuthoredTypes(context, new Set(['browser/new.js']));
    expect(invokePatchLintCheckJsGrouped).toHaveBeenCalledTimes(3);
    expect(vi.mocked(invokePatchLintCheckJsGrouped).mock.calls.at(-1)?.[4]).toEqual(scope);
  });

  it('keeps the type-result directory bounded and keeps the newest result', async () => {
    const value = await fixture();
    value.config.patchLint = { checkJs: true };
    await writeAt(value.root, 'fireforge.json', JSON.stringify(value.config));
    const context = await admitted(value);
    for (let index = 0; index < 40; index++)
      await checkAuthoredTypes({ ...context, phase: `phase-${index}` });
    const directory = join(value.root, '.fireforge/source-types');
    expect((await readdir(directory)).length).toBeLessThanOrEqual(32);
    const calls = vi.mocked(invokePatchLintCheckJsGrouped).mock.calls.length;
    await checkAuthoredTypes({ ...context, phase: 'phase-39' });
    expect(vi.mocked(invokePatchLintCheckJsGrouped).mock.calls.length).toBe(calls);
  });

  it('retains global type failures under a focused root selection', async () => {
    const value = await fixture();
    value.config.patchLint = { checkJs: true };
    await writeAt(value.root, 'fireforge.json', JSON.stringify(value.config));
    const context = await admitted(value);
    const issue = {
      file: '(checkJs)',
      check: 'check-js',
      severity: 'error' as const,
      message: 'Required compiler globals are unavailable.',
    };
    vi.mocked(invokePatchLintCheckJsGrouped).mockResolvedValueOnce({
      global: [issue],
      byFile: new Map(),
    });
    expect(await checkAuthoredTypes(context, new Set(['browser/new.js']))).toContainEqual(issue);
  });

  it('requires explicit ADR-backed source scopes when legacy category rules existed', async () => {
    const value = await fixture();
    value.config.patchPolicy = {
      ranges: [{ from: 1, to: 899, category: 'infra' }],
      scopeRules: [{ category: 'infra', files: ['tests/**'] }],
    };
    await writeAt(value.root, 'fireforge.json', JSON.stringify(value.config));
    await admitted(value);
    await expect(verifyAuthoredSource(value.root)).rejects.toThrow('policy-migration-required');
    await writeAt(value.root, 'docs/source-policy.md', 'Approved source-native policy migration');
    await writeAt(
      value.root,
      '.fireforge-sources/policy.json',
      JSON.stringify({
        schemaVersion: 1,
        status: 'approved',
        adr: 'docs/source-policy.md',
        legacyScopeDigest: digest(value.config.patchPolicy.scopeRules ?? []),
        scopeRules: [
          {
            legacyRule: authoredScopeRuleId({ category: 'infra', files: ['tests/**'] }, 0),
            decision: 'retain',
            reason: 'Preserve the test-only boundary.',
            select: ['browser/**'],
            allow: ['tests/**'],
          },
        ],
      })
    );
    await admitted(value);
    expect(
      (await verifyAuthoredSource(value.root)).some((issue) => issue.check === 'source-scope')
    ).toBe(true);
    expect(
      (await lintAuthoredSource(value.root)).some((issue) => issue.check === 'source-scope')
    ).toBe(true);
    expect(invokePatchLintCheckJsGrouped).not.toHaveBeenCalled();
  });

  it('preserves exact migrated waiver paths and bounded growth', async () => {
    const value = await fixture();
    const component = '123-infra-module.patch';
    const checks = [{ rule: 'file-too-large', max: 100, reason: 'Existing reviewed ceiling.' }];
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
    const exceptions = [{ component, paths: ['browser/new.js'], checks, provenance }];
    await writeAt(
      value.root,
      '.fireforge-sources/waivers.json',
      JSON.stringify({ schemaVersion: 1, exceptions })
    );
    const context = await admitted(value);
    const waivers = await authoredWaivers(context.snapshot);
    const issue = {
      file: 'browser/new.js',
      check: 'file-too-large',
      severity: 'error' as const,
      message: 'Large file',
      measurement: 90,
    };
    expect(applyAuthoredWaivers([issue], waivers)).toEqual([]);
    expect(applyAuthoredWaivers([{ ...issue, measurement: 101 }], waivers)).toHaveLength(1);
    expect(applyAuthoredWaivers([{ ...issue, file: 'browser/other.js' }], waivers)).toHaveLength(1);
    await writeAt(
      value.root,
      '.fireforge-sources/waivers.json',
      JSON.stringify({
        schemaVersion: 1,
        exceptions: [{ ...exceptions[0], paths: ['browser/new-unapproved.js'] }],
      })
    );
    await expect(authoredWaivers((await admitted(value)).snapshot)).rejects.toThrow('path-widened');
  });
  it('includes generated styles in token-scale coverage and refuses bad generated literals', async () => {
    const value = await fixture();
    value.config.patchLint = {
      tokenScales: [
        { properties: ['gap'], prefix: '--fixture-space-', allowLiterals: ['0'], minFiles: 1 },
      ],
    };
    await writeAt(value.root, 'fireforge.json', JSON.stringify(value.config));
    const furnace = createDefaultFurnaceConfig();
    furnace.custom['moz-fixture'] = {
      description: 'Fixture',
      targetPath: 'toolkit/content/widgets/moz-fixture',
      register: false,
      localized: false,
    };
    await writeAt(value.root, 'furnace.json', JSON.stringify(furnace));
    const style = 'components/custom/moz-fixture/moz-fixture.css';
    await writeAt(
      value.root,
      style,
      '/* SPDX-License-Identifier: EUPL-1.2 */\n:host { gap: var(--fixture-space-8); }\n'
    );
    await admitted(value);
    expect(
      (await verifyAuthoredSource(value.root)).some(
        (issue) => issue.check === 'token-scale-vacuous'
      )
    ).toBe(false);
    await writeAt(
      value.root,
      style,
      '/* SPDX-License-Identifier: EUPL-1.2 */\n:host { gap: 13px; }\n'
    );
    await admitted(value);
    expect(
      (await lintAuthoredSource(value.root)).some((issue) => issue.check === 'token-scale')
    ).toBe(true);
  });

  it('refuses corrupted phase caches and preserves valid error, warning and notice severities', async () => {
    const value = await fixture();
    value.config.patchLint = { checkJs: true };
    await writeAt(value.root, 'fireforge.json', JSON.stringify(value.config));
    const context = await admitted(value);
    await checkAuthoredTypes(context);
    const directory = join(value.root, '.fireforge/source-types');
    const [name] = await readdir(directory);
    if (!name) throw new Error('Expected an owned type cache');
    const cache = join(directory, name);
    for (const corrupt of [
      null,
      [{}],
      [
        {
          file: '(checkJs)',
          check: 'check-js',
          message: 'Compiler failed',
          severity: 'unrecognized',
        },
      ],
    ]) {
      await writeFile(cache, JSON.stringify(corrupt));
      await expect(checkAuthoredTypes(context)).rejects.toThrow('authored-invalid-type-cache');
    }
    const findings = ['error', 'warning', 'notice'].map((severity) => ({
      file: '(checkJs)',
      check: 'check-js',
      message: `Preserved ${severity}`,
      severity,
    }));
    await writeFile(cache, JSON.stringify(findings));
    expect(await checkAuthoredTypes(context)).toEqual(findings);
    expect(invokePatchLintCheckJsGrouped).toHaveBeenCalledTimes(1);
  });

  it('retains global failures while a focused directory excludes unrelated local findings', async () => {
    const value = await fixture();
    value.config.patchLint = { checkJs: true };
    await writeAt(value.root, 'fireforge.json', JSON.stringify(value.config));
    await writeAt(value.root, 'src/browser/selected/Chosen.sys.mjs', 'export const chosen = 1;\n');
    await writeAt(value.root, 'src/browser/other/Other.sys.mjs', 'export const other = 1;\n');
    await admitted(value);
    const global = {
      file: '(checkJs)',
      check: 'check-js',
      message: 'Global compiler configuration failed',
      severity: 'error' as const,
    };
    const local = {
      file: 'browser/other/Other.sys.mjs',
      check: 'check-js',
      message: 'Unselected module finding',
      severity: 'error' as const,
    };
    vi.mocked(invokePatchLintCheckJsGrouped).mockResolvedValueOnce({
      global: [global],
      byFile: new Map([[local.file, [local]]]),
    });
    const issues = await lintAuthoredSource(value.root, ['browser/selected']);
    expect(issues).toContainEqual(global);
    expect(issues).not.toContainEqual(local);
    expect(issues.some((issue) => issue.file === 'browser/selected/Chosen.sys.mjs')).toBe(true);
    expect(issues.some((issue) => issue.file === 'browser/new.js')).toBe(false);
  });

  it('refuses a lint path that matches nothing in the captured source', async () => {
    const value = await fixture();
    await admitted(value);
    await expect(lintAuthoredSource(value.root, ['browser/no-such-dir'])).rejects.toThrow(
      /lint path entry "browser\/no-such-dir" matches no file/
    );
  });

  it('keeps binary and invalid UTF-8 creations out of text symbol discovery', async () => {
    const value = await fixture();
    await writeAt(value.root, 'src/browser/binary.dat', Buffer.from([0, 0xff, 1]));
    await writeAt(value.root, 'src/browser/invalid.dat', Buffer.from([0xff, 0xfe]));
    await admitted(value);
    expect(await verifyAuthoredSource(value.root)).toEqual([]);
  });

  it('retains upstream component size budgets while created source has no distribution-patch budget', async () => {
    const value = await fixture();
    value.config.patchLint = {
      patchSizeThresholds: { general: { lines: { notice: 1, warning: 2, error: 3 } } },
    };
    await writeAt(value.root, 'fireforge.json', JSON.stringify(value.config));
    await writeAt(
      value.root,
      'src/browser/manifest.txt',
      'first\nreviewed registration\nthird\nfourth\nfifth\n'
    );
    await writeAt(
      value.root,
      '.fireforge-sources/overrides/browser/manifest.txt.json',
      JSON.stringify(value.declaration)
    );
    await admitted(value);
    const issues = await verifyAuthoredSource(value.root);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: 'large-patch-lines',
          file: value.declaration.component,
          severity: 'error',
        }),
      ])
    );
    expect(
      issues.some((issue) => issue.check === 'large-patch-lines' && issue.file === 'browser/new.js')
    ).toBe(false);
  });
});
