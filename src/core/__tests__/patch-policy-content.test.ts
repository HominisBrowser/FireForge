// SPDX-License-Identifier: EUPL-1.2
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempProject, removeTempProject, writeFiles } from '../../test-utils/index.js';
import type { PatchesManifest, PatchMetadata } from '../../types/commands/index.js';
import type { FireForgeConfig, PatchPolicyConfig } from '../../types/config.js';
import type { PatchQueueEntry } from '../patch-lint-cross.js';
import { evaluatePatchPolicyContent, hasPatchPolicyContentRules } from '../patch-policy-content.js';

function newFileDiff(path: string, lines: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${String(lines.length)} @@`,
    ...lines.map((line) => `+${line}`),
  ].join('\n');
}

function modifyDiff(path: string, removed: string[], added: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${String(removed.length + 1)} +1,${String(added.length + 1)} @@`,
    ' context',
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ].join('\n');
}

function deleteDiff(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    'deleted file mode 100644',
    'index 1111111..0000000',
    `--- a/${path}`,
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-gone',
  ].join('\n');
}

interface Seed {
  filename: string;
  order: number;
  category?: string;
  files: string[];
  diff: string;
  created?: string[];
}

function queue(seeds: Seed[]): { manifest: PatchesManifest; entries: PatchQueueEntry[] } {
  const patches: PatchMetadata[] = seeds.map((seed) => ({
    filename: seed.filename,
    order: seed.order,
    category: seed.category ?? 'ui',
    name: seed.filename,
    description: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected: seed.files,
  }));
  const entries: PatchQueueEntry[] = seeds.map((seed, index) => ({
    filename: seed.filename,
    order: seed.order,
    metadata: patches[index] ?? null,
    diff: seed.diff,
    newFiles: new Map(),
    createdFiles: new Set(seed.created ?? []),
    modifiedFileAdditions: new Map(),
  }));
  return { manifest: { version: 1, patches }, entries };
}

function configWith(policy: Partial<PatchPolicyConfig>): FireForgeConfig {
  return {
    name: 'Test',
    vendor: 'Test',
    appId: 'org.test.browser',
    binaryName: 'testbrowser',
    firefox: { version: '140.0esr', product: 'firefox-esr' },
    patchPolicy: { ranges: [{ from: 1, to: 899, category: 'ui' }], ...policy },
  };
}

describe('evaluatePatchPolicyContent', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-policy-content-');
  });
  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('is a no-op without a policy or without any body-dependent rule', async () => {
    const { manifest, entries } = queue([
      {
        filename: '001-ui-a.patch',
        order: 1,
        files: ['x.js'],
        diff: modifyDiff('x.js', [], ['y']),
      },
    ]);
    const bare = { ...configWith({}), patchPolicy: undefined } as unknown as FireForgeConfig;
    expect(hasPatchPolicyContentRules(bare)).toBe(false);
    expect(hasPatchPolicyContentRules(configWith({}))).toBe(false);
    expect(await evaluatePatchPolicyContent(bare, projectRoot, manifest, entries)).toEqual([]);
    expect(
      await evaluatePatchPolicyContent(configWith({}), projectRoot, manifest, entries)
    ).toEqual([]);
  });

  it('flags upstream modifications outside the allowlist, skipping queue-created files and reserved patches', async () => {
    const { manifest, entries } = queue([
      {
        filename: '001-ui-new.patch',
        order: 1,
        files: ['browser/modules/testbrowser/New.sys.mjs'],
        diff: newFileDiff('browser/modules/testbrowser/New.sys.mjs', ['export {};']),
        created: ['browser/modules/testbrowser/New.sys.mjs'],
      },
      {
        filename: '002-ui-edit.patch',
        order: 2,
        files: [
          'browser/modules/testbrowser/New.sys.mjs',
          'browser/base/content/browser.js',
          'toolkit/other.js',
        ],
        diff: [
          modifyDiff('browser/modules/testbrowser/New.sys.mjs', [], ['// later']),
          modifyDiff('browser/base/content/browser.js', [], ['x()']),
          modifyDiff('toolkit/other.js', [], ['y()']),
        ].join('\n'),
      },
      {
        filename: '950-ui-reserved.patch',
        order: 950,
        files: ['toolkit/reserved.js'],
        diff: modifyDiff('toolkit/reserved.js', ['a'], ['b']),
      },
    ]);
    const config = configWith({
      upstreamAllowlist: ['browser/base/content/*.js'],
      reservedRanges: [{ from: 900, to: 999, allowed: [] }],
    });

    const issues = await evaluatePatchPolicyContent(config, projectRoot, manifest, entries);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: 'upstream-allowlist',
      filename: '002-ui-edit.patch',
      severity: 'error',
    });
    expect(issues[0]?.message).toContain(
      'outside patchPolicy.upstreamAllowlist: toolkit/other.js.'
    );
  });

  it('enforces add-only with a marker: removals, unmarked lines, deletions and binaries fail', async () => {
    const binary = [
      'diff --git a/reg/icon.png b/reg/icon.png',
      'index 1111111..2222222 100644',
      'Binary files a/reg/icon.png and b/reg/icon.png differ',
    ].join('\n');
    const { manifest, entries } = queue([
      {
        filename: '001-ui-ok.patch',
        order: 1,
        files: ['reg/jar.mn'],
        diff: modifyDiff('reg/jar.mn', [''], ['  content/TestBrowser.js', '']),
      },
      {
        filename: '002-ui-removes.patch',
        order: 2,
        files: ['reg/jar.mn'],
        diff: modifyDiff('reg/jar.mn', ['  content/upstream.js'], ['  content/testbrowser.js']),
      },
      {
        filename: '003-ui-unmarked.patch',
        order: 3,
        files: ['reg/moz.build'],
        diff: modifyDiff('reg/moz.build', [], ['DIRS += ["other"]']),
      },
      {
        filename: '004-ui-deletes.patch',
        order: 4,
        files: ['reg/jar.mn'],
        diff: deleteDiff('reg/jar.mn'),
      },
      { filename: '005-ui-binary.patch', order: 5, files: ['reg/icon.png'], diff: binary },
    ]);
    const config = configWith({
      mutationMode: 'warn',
      addOnlyMarker: 'testbrowser',
      upstreamAllowlist: [
        'reg/**',
        { path: 'reg/jar.mn', addOnly: true },
        { path: 'reg/moz.build', addOnly: true, marker: 'FORK:' },
        { path: 'reg/*.png', addOnly: true },
      ],
    });

    const issues = await evaluatePatchPolicyContent(config, projectRoot, manifest, entries);
    const byPatch = Object.fromEntries(issues.map((issue) => [issue.filename, issue]));

    expect(Object.keys(byPatch).sort()).toEqual([
      '002-ui-removes.patch',
      '003-ui-unmarked.patch',
      '004-ui-deletes.patch',
      '005-ui-binary.patch',
    ]);
    expect(issues.every((issue) => issue.code === 'add-only' && issue.severity === 'warning')).toBe(
      true
    );
    expect(byPatch['002-ui-removes.patch']?.message).toContain(
      'removes 1 line(s), first: "  content/upstream.js"'
    );
    expect(byPatch['003-ui-unmarked.patch']?.message).toContain(
      'adds 1 line(s) without the "FORK:" marker'
    );
    expect(byPatch['004-ui-deletes.patch']?.message).toContain('but deletes the file.');
    expect(byPatch['005-ui-binary.patch']?.message).toContain('carries a binary change');
  });

  it("lets an add-only file drop a line naming one of the entry's retiredPaths", async () => {
    const { manifest, entries } = queue([
      {
        filename: '001-ui-retires.patch',
        order: 1,
        files: ['browser/base/jar.mn'],
        diff: modifyDiff(
          'browser/base/jar.mn',
          ['        content/browser/fxa/fxa-logo.svg  (content/fxa/fxa-logo.svg)'],
          []
        ),
      },
      {
        filename: '002-ui-removes-other.patch',
        order: 2,
        files: ['browser/base/jar.mn'],
        diff: modifyDiff(
          'browser/base/jar.mn',
          [
            '        content/browser/fxa/fxa-logo.svg  (content/fxa/fxa-logo.svg)',
            '        content/browser/fxa/sync.svg  (content/fxa/sync.svg)',
          ],
          []
        ),
      },
    ]);
    const config = configWith({
      mutationMode: 'warn',
      upstreamAllowlist: [
        {
          path: '**/jar.mn',
          addOnly: true,
          marker: 'hominis',
          retiredPaths: ['content/fxa/fxa-logo.svg'],
        },
      ],
    });

    const issues = await evaluatePatchPolicyContent(config, projectRoot, manifest, entries);

    expect(issues.map((issue) => issue.filename)).toEqual(['002-ui-removes-other.patch']);
    expect(issues[0]?.message).toContain(
      'removes 1 line(s), first: "        content/browser/fxa/sync.svg  (content/fxa/sync.svg)"'
    );
  });

  it('scopes a patch class to its globs by filename pattern and category', async () => {
    const { manifest, entries } = queue([
      {
        filename: '010-ui-sidebar-tests.patch',
        order: 10,
        files: [
          'browser/base/content/test/sidebar/browser_a.js',
          'browser/base/content/sidebar.js',
        ],
        diff: '',
      },
      {
        filename: '011-ui-sidebar.patch',
        order: 11,
        files: ['browser/base/content/sidebar.js'],
        diff: '',
      },
      {
        filename: '012-l10n-x.patch',
        order: 12,
        category: 'l10n',
        files: ['browser/locales/en-US/x.ftl', 'browser/x.js'],
        diff: '',
      },
    ]);
    const config = configWith({
      scopeRules: [
        { filenamePattern: '-tests\\.patch$', files: ['**/test/**', '**/*.toml'] },
        { category: 'l10n', files: ['**/locales/**'] },
      ],
    });

    const issues = await evaluatePatchPolicyContent(config, projectRoot, manifest, entries);

    expect(issues.map((issue) => [issue.code, issue.filename])).toEqual([
      ['scope', '010-ui-sidebar-tests.patch'],
      ['scope', '012-l10n-x.patch'],
    ]);
    expect(issues[0]?.message).toContain('scopeRules[0]');
    expect(issues[0]?.message).toContain('but touches: browser/base/content/sidebar.js.');
    expect(issues[1]?.message).toContain('but touches: browser/x.js.');
  });

  it('verifies reserved allowlist adr / documentation paths when asked', async () => {
    await writeFiles(projectRoot, { 'docs/adr/0001-ok.md': '# ok\n' });
    const { manifest, entries } = queue([]);
    const reservedRanges = [
      {
        from: 900,
        to: 999,
        allowed: [
          { filename: '900-ui-ok.patch', adr: 'docs/adr/0001-ok.md' },
          {
            filename: '901-ui-gone.patch',
            adr: 'docs/adr/0002-gone.md',
            documentation: 'docs/gone.md',
          },
        ],
      },
    ];

    expect(
      await evaluatePatchPolicyContent(
        configWith({ reservedRanges }),
        projectRoot,
        manifest,
        entries
      )
    ).toEqual([]);
    const issues = await evaluatePatchPolicyContent(
      configWith({ reservedRanges, verifyDocumentPaths: true }),
      projectRoot,
      manifest,
      entries
    );
    expect(issues.map((issue) => [issue.code, issue.filename])).toEqual([
      ['reserved-document-missing', '901-ui-gone.patch'],
      ['reserved-document-missing', '901-ui-gone.patch'],
    ]);
    expect(issues[0]?.message).toContain('names adr "docs/adr/0002-gone.md"');
    expect(issues[1]?.message).toContain('names documentation "docs/gone.md"');
  });
});
