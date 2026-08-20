// SPDX-License-Identifier: EUPL-1.2
/**
 * Cross-patch lint tests — duplicate /dev/null creation and forward-import
 * detection. These exercise the rule bodies directly against synthetic
 * PatchQueueContext instances so the tests do not need a temp patch
 * directory on disk.
 */

import { describe, expect, it } from 'vitest';

import type { PatchMetadata } from '../../types/commands/index.js';
import {
  collectNewFileCreatorsByPath,
  extractImportSpecifiers,
  FORWARD_IMPORT_IGNORE_MARKER,
  lintPatchQueue,
  lintPatchQueueDuplicateCreations,
  lintPatchQueueForwardImports,
  lintPatchQueueModuleRegistrations,
  type PatchQueueContext,
  type PatchQueueEntry,
} from '../patch-lint.js';

function makeEntry(
  filename: string,
  order: number,
  diff: string,
  newFiles: Record<string, string> = {},
  modifiedFileAdditions: Record<string, string> = {},
  metadataExtras: Partial<PatchMetadata> = {}
): PatchQueueEntry {
  return {
    filename,
    order,
    metadata: {
      filename,
      order,
      category: 'ui',
      name: filename.replace(/\.patch$/, ''),
      description: '',
      createdAt: '2026-05-27T00:00:00.000Z',
      sourceEsrVersion: '140.9.0esr',
      filesAffected: [...Object.keys(newFiles), ...Object.keys(modifiedFileAdditions)],
      ...metadataExtras,
    },
    diff,
    newFiles: new Map(Object.entries(newFiles)),
    modifiedFileAdditions: new Map(Object.entries(modifiedFileAdditions)),
  };
}

const CREATE_A_DIFF = [
  'diff --git a/foo/A.sys.mjs b/foo/A.sys.mjs',
  'new file mode 100644',
  'index 0000000..1111111',
  '--- /dev/null',
  '+++ b/foo/A.sys.mjs',
  '@@ -0,0 +1,1 @@',
  '+export const A = 1;',
].join('\n');

const CREATE_A_DUPLICATE_DIFF = [
  'diff --git a/foo/A.sys.mjs b/foo/A.sys.mjs',
  'new file mode 100644',
  'index 0000000..2222222',
  '--- /dev/null',
  '+++ b/foo/A.sys.mjs',
  '@@ -0,0 +1,1 @@',
  '+export const A = 2;',
].join('\n');

describe('lintPatchQueueDuplicateCreations', () => {
  it('flags the same path created by two patches', () => {
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry('001-infra-a.patch', 1, CREATE_A_DIFF),
        makeEntry('002-infra-b.patch', 2, CREATE_A_DUPLICATE_DIFF),
      ],
    };
    const issues = lintPatchQueueDuplicateCreations(ctx);
    expect(issues).toHaveLength(1);
    const issue = issues[0];
    expect(issue).toBeDefined();
    expect(issue?.check).toBe('duplicate-new-file-creation');
    expect(issue?.file).toBe('foo/A.sys.mjs');
    expect(issue?.message).toContain('001-infra-a.patch');
    expect(issue?.message).toContain('002-infra-b.patch');
    expect(issue?.severity).toBe('error');
    // Structured attribution for the export placement gate:
    // every creator is implicated.
    expect(issue?.patches).toEqual(['001-infra-a.patch', '002-infra-b.patch']);
  });

  it('does not flag the same path being modified in two patches', () => {
    const modifyDiff = [
      'diff --git a/foo/A.sys.mjs b/foo/A.sys.mjs',
      'index aaaaaaa..bbbbbbb 100644',
      '--- a/foo/A.sys.mjs',
      '+++ b/foo/A.sys.mjs',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
    ].join('\n');
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry('001-infra-a.patch', 1, modifyDiff),
        makeEntry('002-infra-b.patch', 2, modifyDiff),
      ],
    };
    expect(lintPatchQueueDuplicateCreations(ctx)).toHaveLength(0);
  });

  it('returns no issues for a clean queue', () => {
    const createBDiff = [
      'diff --git a/foo/B.sys.mjs b/foo/B.sys.mjs',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/foo/B.sys.mjs',
      '@@ -0,0 +1,1 @@',
      '+export const B = 1;',
    ].join('\n');
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry('001-infra-a.patch', 1, CREATE_A_DIFF),
        makeEntry('002-infra-b.patch', 2, createBDiff),
      ],
    };
    expect(lintPatchQueueDuplicateCreations(ctx)).toHaveLength(0);
  });
});

describe('lintPatchQueueForwardImports', () => {
  it('flags an import pointing to a file created by a later patch', () => {
    const importerContent = `import { B } from "resource:///modules/B.sys.mjs";\nexport const A = B;\n`;
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry('001-infra-a.patch', 1, CREATE_A_DIFF, { 'foo/A.sys.mjs': importerContent }),
        makeEntry('002-infra-b.patch', 2, CREATE_A_DIFF, {
          'foo/B.sys.mjs': 'export const B = 1;\n',
        }),
      ],
    };
    const issues = lintPatchQueueForwardImports(ctx);
    expect(issues.length).toBeGreaterThan(0);
    const issue = issues[0];
    expect(issue?.check).toBe('forward-import');
    expect(issue?.file).toBe('foo/A.sys.mjs');
    expect(issue?.message).toContain('002-infra-b.patch');
    expect(issue?.severity).toBe('error');
    // Structured attribution: the IMPORTING entry is implicated.
    expect(issue?.patches).toEqual(['001-infra-a.patch']);
  });

  it('flags a bare getter-property line added to an existing defineESModuleGetters map', () => {
    // The patch adds ONE line inside a pre-existing defineESModuleGetters
    // object literal, so the added-lines-only content never contains the
    // `defineESModuleGetters(` opener the balanced walk keys on.
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry(
          '001-infra-a.patch',
          1,
          CREATE_A_DIFF,
          {},
          { 'browser/base/content/browser.js': '  Foo: "resource://gre/modules/Foo.sys.mjs",' }
        ),
        makeEntry('002-infra-b.patch', 2, CREATE_A_DIFF, {
          'foo/Foo.sys.mjs': 'export const Foo = 1;\n',
        }),
      ],
    };
    const issues = lintPatchQueueForwardImports(ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe('forward-import');
    expect(issues[0]?.file).toBe('browser/base/content/browser.js');
    expect(issues[0]?.message).toContain('002-infra-b.patch');
  });

  it('flags a quoted-key getter-property line and lazy-style additions', () => {
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry(
          '001-infra-a.patch',
          1,
          CREATE_A_DIFF,
          {},
          { 'browser/base/content/browser.js': '  "Foo": \'resource://gre/modules/Foo.sys.mjs\',' }
        ),
        makeEntry('002-infra-b.patch', 2, CREATE_A_DIFF, {
          'foo/Foo.sys.mjs': 'export const Foo = 1;\n',
        }),
      ],
    };
    expect(lintPatchQueueForwardImports(ctx)).toHaveLength(1);
  });

  it('does not flag ordinary object-literal string properties', () => {
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry(
          '001-infra-a.patch',
          1,
          CREATE_A_DIFF,
          {},
          {
            'browser/base/content/browser.js':
              '  label: "Foo.sys.mjs",\n  url: "https://example.com/Foo.sys.mjs",',
          }
        ),
        makeEntry('002-infra-b.patch', 2, CREATE_A_DIFF, {
          'foo/Foo.sys.mjs': 'export const Foo = 1;\n',
        }),
      ],
    };
    expect(lintPatchQueueForwardImports(ctx)).toHaveLength(0);
  });

  it('does not double-report when the patch adds the whole getter call', () => {
    const added = [
      'ChromeUtils.defineESModuleGetters(lazy, {',
      '  Foo: "resource://gre/modules/Foo.sys.mjs",',
      '});',
    ].join('\n');
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry(
          '001-infra-a.patch',
          1,
          CREATE_A_DIFF,
          {},
          { 'browser/base/content/browser.js': added }
        ),
        makeEntry('002-infra-b.patch', 2, CREATE_A_DIFF, {
          'foo/Foo.sys.mjs': 'export const Foo = 1;\n',
        }),
      ],
    };
    expect(lintPatchQueueForwardImports(ctx)).toHaveLength(1);
  });

  it('honours the ignore marker on a bare getter-property line', () => {
    const added = [
      `  // ${FORWARD_IMPORT_IGNORE_MARKER}`,
      '  Foo: "resource://gre/modules/Foo.sys.mjs",',
    ].join('\n');
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry(
          '001-infra-a.patch',
          1,
          CREATE_A_DIFF,
          {},
          { 'browser/base/content/browser.js': added }
        ),
        makeEntry('002-infra-b.patch', 2, CREATE_A_DIFF, {
          'foo/Foo.sys.mjs': 'export const Foo = 1;\n',
        }),
      ],
    };
    expect(lintPatchQueueForwardImports(ctx)).toHaveLength(0);
  });

  it('enumerates every forward-import site in one pass, not just the first', () => {
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry('001-infra-a.patch', 1, CREATE_A_DIFF, {
          'foo/A.sys.mjs': 'import { B } from "resource:///modules/B.sys.mjs";\n',
          'foo/A2.sys.mjs': 'ChromeUtils.importESModule("resource:///modules/B.sys.mjs");\n',
        }),
        makeEntry('002-infra-b.patch', 2, CREATE_A_DIFF, {
          'foo/B.sys.mjs': 'export const B = 1;\n',
        }),
      ],
    };
    const issues = lintPatchQueueForwardImports(ctx);
    expect(issues.filter((i) => i.check === 'forward-import')).toHaveLength(2);
  });

  it('names the exact staged-dependency invocation per later owner', () => {
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry('001-infra-a.patch', 1, CREATE_A_DIFF, {
          'foo/A.sys.mjs': 'import { B } from "resource:///modules/B.sys.mjs";\n',
        }),
        makeEntry('002-infra-b.patch', 2, CREATE_A_DIFF, {
          'foo/B.sys.mjs': 'export const B = 1;\n',
        }),
      ],
    };
    const issues = lintPatchQueueForwardImports(ctx);
    expect(issues[0]?.message).toContain(
      'fireforge patch staged-dependency 001-infra-a.patch --add ' +
        '--file foo/A.sys.mjs --specifier "resource:///modules/B.sys.mjs" ' +
        '--creates foo/B.sys.mjs --owner 002-infra-b.patch'
    );
  });

  it('keeps the ordinal hint without patchPolicy, and when a legal ordinal exists', () => {
    const entries = [
      makeEntry('001-infra-a.patch', 1, CREATE_A_DIFF, {
        'foo/A.sys.mjs': 'import { B } from "resource:///modules/B.sys.mjs";\n',
      }),
      makeEntry('002-infra-b.patch', 2, CREATE_A_DIFF, {
        'foo/B.sys.mjs': 'export const B = 1;\n',
      }),
    ];

    const noPolicy = lintPatchQueueForwardImports({ entries });
    expect(noPolicy[0]?.message).toContain(
      'Closest legal ordinal that satisfies this dependency: 3.'
    );

    const roomyPolicy = lintPatchQueueForwardImports({
      entries,
      patchPolicy: { ranges: [{ category: 'ui', from: 1, to: 99 }] },
    });
    expect(roomyPolicy[0]?.message).toContain(
      'Closest legal ordinal that satisfies this dependency: 3.'
    );
  });

  it('suppresses an impossible ordinal hint and recommends the staged dependency', () => {
    const entries = [
      makeEntry('001-infra-a.patch', 1, CREATE_A_DIFF, {
        'foo/A.sys.mjs': 'import { B } from "resource:///modules/B.sys.mjs";\n',
      }),
      makeEntry('002-infra-b.patch', 2, CREATE_A_DIFF, {
        'foo/B.sys.mjs': 'export const B = 1;\n',
      }),
    ];

    // The importing patch's category range ends at 2 — order 3 is illegal.
    const issues = lintPatchQueueForwardImports({
      entries,
      patchPolicy: { ranges: [{ category: 'ui', from: 1, to: 2 }] },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).not.toContain('Closest legal ordinal');
    expect(issues[0]?.message).toContain(
      'No legal ordinal in the ui category range (001-002) lands after the creating patch(es); ' +
        'declaring the staged dependency is the recommended remedy.'
    );
  });

  it('keeps the fingerprint stable across ordinal-hint variants', () => {
    const entries = [
      makeEntry('001-infra-a.patch', 1, CREATE_A_DIFF, {
        'foo/A.sys.mjs': 'import { B } from "resource:///modules/B.sys.mjs";\n',
      }),
      makeEntry('002-infra-b.patch', 2, CREATE_A_DIFF, {
        'foo/B.sys.mjs': 'export const B = 1;\n',
      }),
    ];
    const withHint = lintPatchQueueForwardImports({ entries });
    const withoutHint = lintPatchQueueForwardImports({
      entries,
      patchPolicy: { ranges: [{ category: 'ui', from: 1, to: 2 }] },
    });
    expect(withHint[0]?.fingerprint).toBeDefined();
    expect(withHint[0]?.fingerprint).toBe(withoutHint[0]?.fingerprint);
  });

  it('suppresses an exact declared staged forward import', () => {
    const importerContent = `import { B } from "resource:///modules/B.sys.mjs";\nexport const A = B;\n`;
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry(
          '001-infra-a.patch',
          1,
          CREATE_A_DIFF,
          { 'foo/A.sys.mjs': importerContent },
          {},
          {
            stagedDependencies: {
              forwardImports: [
                {
                  file: 'foo/A.sys.mjs',
                  specifier: 'resource:///modules/B.sys.mjs',
                  creates: 'foo/B.sys.mjs',
                  owner: '002-infra-b.patch',
                },
              ],
            },
          }
        ),
        makeEntry('002-infra-b.patch', 2, CREATE_A_DIFF, {
          'foo/B.sys.mjs': 'export const B = 1;\n',
        }),
      ],
    };
    expect(lintPatchQueueForwardImports(ctx)).toHaveLength(0);
  });

  it('does not suppress unrelated forward imports when staged metadata is present', () => {
    const importerContent = `import { C } from "resource:///modules/C.sys.mjs";\n`;
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry(
          '001-infra-a.patch',
          1,
          CREATE_A_DIFF,
          { 'foo/A.sys.mjs': importerContent },
          {},
          {
            stagedDependencies: {
              forwardImports: [
                {
                  file: 'foo/A.sys.mjs',
                  specifier: 'resource:///modules/B.sys.mjs',
                  creates: 'foo/B.sys.mjs',
                },
              ],
            },
          }
        ),
        makeEntry('002-infra-c.patch', 2, CREATE_A_DIFF, {
          'foo/C.sys.mjs': 'export const C = 1;\n',
        }),
      ],
    };
    const issues = lintPatchQueueForwardImports(ctx);
    expect(issues.map((issue) => issue.check)).toEqual([
      'forward-import',
      'staged-dependency-unused',
    ]);
  });

  it('warns when a staged forward-import declaration is stale', () => {
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry(
          '001-infra-a.patch',
          1,
          CREATE_A_DIFF,
          { 'foo/A.sys.mjs': 'export const A = 1;\n' },
          {},
          {
            stagedDependencies: {
              forwardImports: [
                {
                  file: 'foo/A.sys.mjs',
                  specifier: 'resource:///modules/B.sys.mjs',
                  creates: 'foo/B.sys.mjs',
                },
              ],
            },
          }
        ),
      ],
    };
    const issues = lintPatchQueueForwardImports(ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe('staged-dependency-unused');
    expect(issues[0]?.severity).toBe('warning');
  });

  // ── 0.37.0 item 5: registration-kind staged dependencies — a jar.mn
  //    packaging line (or customElements/actor registration) referencing a
  //    later-created file has no import to match; the declaration is used
  //    when the declared line appears in the patch's added content. ──

  it('accepts a registration-kind entry whose jar.mn line the patch adds (item 5 acc 1)', () => {
    const jarLine =
      '        content/global/widgets/hominis-history-ui.js (widgets/hominis-history-ui.js)';
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry(
          '200-ui-history-jar.patch',
          200,
          CREATE_A_DIFF,
          {},
          { 'toolkit/content/jar.mn': `${jarLine}\n` },
          {
            stagedDependencies: {
              registrations: [
                {
                  file: 'toolkit/content/jar.mn',
                  line: jarLine.trim(),
                  creates: 'toolkit/content/widgets/hominis-history-ui.js',
                  owner: '248-ui-history-impl.patch',
                },
              ],
            },
          }
        ),
        makeEntry('248-ui-history-impl.patch', 248, CREATE_A_DIFF, {
          'toolkit/content/widgets/hominis-history-ui.js': 'export const ui = 1;\n',
        }),
      ],
    };
    expect(lintPatchQueueForwardImports(ctx)).toHaveLength(0);
  });

  it('matches a registration line added in a newly-created file too', () => {
    const registrationLine =
      'registerCustomElement("moz-hominis-history", "chrome://global/content/widgets/moz-hominis-history.mjs");';
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry(
          '202-ui-widgets.patch',
          202,
          CREATE_A_DIFF,
          { 'toolkit/content/hominisElements.js': `${registrationLine}\n` },
          {},
          {
            stagedDependencies: {
              registrations: [
                {
                  file: 'toolkit/content/hominisElements.js',
                  line: registrationLine,
                  creates: 'toolkit/content/widgets/moz-hominis-history.mjs',
                },
              ],
            },
          }
        ),
        makeEntry('248-ui-history-widget.patch', 248, CREATE_A_DIFF, {
          'toolkit/content/widgets/moz-hominis-history.mjs': 'export const el = 1;\n',
        }),
      ],
    };
    expect(lintPatchQueueForwardImports(ctx)).toHaveLength(0);
  });

  it('still requires an import for import-kind entries — a registration entry does not stand in (item 5 acc 2)', () => {
    const importerContent = `import { B } from "resource:///modules/B.sys.mjs";\n`;
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry(
          '001-infra-a.patch',
          1,
          CREATE_A_DIFF,
          { 'foo/A.sys.mjs': importerContent },
          {},
          {
            stagedDependencies: {
              registrations: [
                {
                  file: 'foo/A.sys.mjs',
                  line: 'import { B } from "resource:///modules/B.sys.mjs";',
                  creates: 'foo/B.sys.mjs',
                },
              ],
            },
          }
        ),
        makeEntry('002-infra-b.patch', 2, CREATE_A_DIFF, {
          'foo/B.sys.mjs': 'export const B = 1;\n',
        }),
      ],
    };
    // The forward import is NOT suppressed by a registration entry (they are
    // different claims); the registration itself matches its line, so the
    // only issue is the forward-import error.
    const issues = lintPatchQueueForwardImports(ctx);
    expect(issues.map((issue) => issue.check)).toEqual(['forward-import']);
  });

  it('warns unused when the declared registration line is absent from the patch (item 5 acc 3)', () => {
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry(
          '200-ui-history-jar.patch',
          200,
          CREATE_A_DIFF,
          {},
          { 'toolkit/content/jar.mn': '        content/global/other.js (other.js)\n' },
          {
            stagedDependencies: {
              registrations: [
                {
                  file: 'toolkit/content/jar.mn',
                  line: 'content/global/widgets/hominis-history-ui.js (widgets/hominis-history-ui.js)',
                  creates: 'toolkit/content/widgets/hominis-history-ui.js',
                },
              ],
            },
          }
        ),
      ],
    };
    const issues = lintPatchQueueForwardImports(ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe('staged-dependency-unused');
    expect(issues[0]?.severity).toBe('warning');
    expect(issues[0]?.message).toContain('staged registration');
    expect(issues[0]?.message).toContain('--kind registration');
  });

  it('matches registration lines whitespace-trimmed (indentation differences are fine)', () => {
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry(
          '200-ui-history-jar.patch',
          200,
          CREATE_A_DIFF,
          {},
          { 'toolkit/content/jar.mn': '     content/global/a.js (a.js)\n' },
          {
            stagedDependencies: {
              registrations: [
                {
                  file: 'toolkit/content/jar.mn',
                  line: 'content/global/a.js (a.js)',
                  creates: 'toolkit/content/a.js',
                },
              ],
            },
          }
        ),
        makeEntry('201-ui-a-impl.patch', 201, CREATE_A_DIFF, {
          'toolkit/content/a.js': 'export const a = 1;\n',
        }),
      ],
    };
    expect(lintPatchQueueForwardImports(ctx)).toHaveLength(0);
  });

  it('warns when a registration declares a creates no later-ordered patch creates', () => {
    const jarLine = 'content/global/a.js (a.js)';
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry(
          '200-ui-jar.patch',
          200,
          CREATE_A_DIFF,
          {},
          { 'toolkit/content/jar.mn': `${jarLine}\n` },
          {
            stagedDependencies: {
              registrations: [
                {
                  file: 'toolkit/content/jar.mn',
                  line: jarLine,
                  creates: 'toolkit/content/a.js',
                },
              ],
            },
          }
        ),
      ],
    };
    const issues = lintPatchQueueForwardImports(ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe('staged-dependency-unused');
    expect(issues[0]?.message).toContain('no later-ordered patch creates that file');
  });

  it('warns when the creates target is only created by an EARLIER patch (stale declaration)', () => {
    const jarLine = 'content/global/a.js (a.js)';
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry('100-ui-a-impl.patch', 100, CREATE_A_DIFF, {
          'toolkit/content/a.js': 'export const a = 1;\n',
        }),
        makeEntry(
          '200-ui-jar.patch',
          200,
          CREATE_A_DIFF,
          {},
          { 'toolkit/content/jar.mn': `${jarLine}\n` },
          {
            stagedDependencies: {
              registrations: [
                {
                  file: 'toolkit/content/jar.mn',
                  line: jarLine,
                  creates: 'toolkit/content/a.js',
                },
              ],
            },
          }
        ),
      ],
    };
    const issues = lintPatchQueueForwardImports(ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe('staged-dependency-unused');
    expect(issues[0]?.message).toContain('no later-ordered patch creates that file');
  });

  it('warns when the declared owner is not the patch that creates the file, naming the real creator', () => {
    const jarLine = 'content/global/a.js (a.js)';
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry(
          '200-ui-jar.patch',
          200,
          CREATE_A_DIFF,
          {},
          { 'toolkit/content/jar.mn': `${jarLine}\n` },
          {
            stagedDependencies: {
              registrations: [
                {
                  file: 'toolkit/content/jar.mn',
                  line: jarLine,
                  creates: 'toolkit/content/a.js',
                  owner: '999-ui-wrong.patch',
                },
              ],
            },
          }
        ),
        makeEntry('248-ui-a-impl.patch', 248, CREATE_A_DIFF, {
          'toolkit/content/a.js': 'export const a = 1;\n',
        }),
      ],
    };
    const issues = lintPatchQueueForwardImports(ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe('staged-dependency-unused');
    expect(issues[0]?.message).toContain('248-ui-a-impl.patch');
    expect(issues[0]?.message).toContain('not the declared owner');
  });

  it('appends the closest legal ordinal to the refusal message', () => {
    const importerContent = `import { B } from "resource:///modules/B.sys.mjs";`;
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry('001-infra-a.patch', 1, CREATE_A_DIFF, { 'foo/A.sys.mjs': importerContent }),
        makeEntry('005-infra-b.patch', 5, CREATE_A_DIFF, {
          'foo/B.sys.mjs': 'export const B = 1;\n',
        }),
      ],
    };
    const issues = lintPatchQueueForwardImports(ctx);
    expect(issues).toHaveLength(1);
    // The dependency lives at order 5, so the closest legal placement
    // for the importer is order 6 — operator turns "two attempts at
    // --order N" into one shot.
    expect(issues[0]?.message).toContain(
      'Closest legal ordinal that satisfies this dependency: 6.'
    );
  });

  it('does not flag an import pointing to a file created by the same patch', () => {
    const importerContent = `import { B } from "resource:///modules/B.sys.mjs";`;
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry('001-infra-a.patch', 1, CREATE_A_DIFF, {
          'foo/A.sys.mjs': importerContent,
          'foo/B.sys.mjs': 'export const B = 1;',
        }),
      ],
    };
    expect(lintPatchQueueForwardImports(ctx)).toHaveLength(0);
  });

  it('does not flag an import pointing to a file created by an earlier patch', () => {
    const importerContent = `import { A } from "resource:///modules/A.sys.mjs";`;
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry('001-infra-a.patch', 1, CREATE_A_DIFF, {
          'foo/A.sys.mjs': 'export const A = 1;',
        }),
        makeEntry('002-infra-b.patch', 2, CREATE_A_DIFF, { 'foo/B.sys.mjs': importerContent }),
      ],
    };
    expect(lintPatchQueueForwardImports(ctx)).toHaveLength(0);
  });

  it('does not flag imports resolving to pre-existing engine files (not in new-file index)', () => {
    const importerContent = `import { Existing } from "resource:///modules/Existing.sys.mjs";`;
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry('001-infra-a.patch', 1, CREATE_A_DIFF, { 'foo/A.sys.mjs': importerContent }),
      ],
    };
    expect(lintPatchQueueForwardImports(ctx)).toHaveLength(0);
  });

  it('flags an import ADDED into a pre-existing file that a later patch creates', () => {
    // Fix 1: before this change the rule only scanned `newFiles`, so a
    // patch that modifies browser.js to add `import "./B.sys.mjs"` was
    // silently waved through even if the matching file was created by a
    // later patch. This is the exact shape of bug the review flagged.
    const modifyBrowserDiff = [
      'diff --git a/browser/base/content/browser.js b/browser/base/content/browser.js',
      'index aaaaaaa..bbbbbbb 100644',
      '--- a/browser/base/content/browser.js',
      '+++ b/browser/base/content/browser.js',
      '@@ -1,1 +1,2 @@',
      ' existing;',
      '+import { B } from "resource:///modules/B.sys.mjs";',
    ].join('\n');
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry(
          '001-infra-modifier.patch',
          1,
          modifyBrowserDiff,
          {},
          {
            'browser/base/content/browser.js': 'import { B } from "resource:///modules/B.sys.mjs";',
          }
        ),
        makeEntry('002-infra-create-b.patch', 2, CREATE_A_DIFF, {
          'foo/B.sys.mjs': 'export const B = 1;',
        }),
      ],
    };
    const issues = lintPatchQueueForwardImports(ctx);
    expect(issues.length).toBe(1);
    const issue = issues[0];
    expect(issue?.check).toBe('forward-import');
    expect(issue?.file).toBe('browser/base/content/browser.js');
    expect(issue?.message).toContain('001-infra-modifier.patch');
    expect(issue?.message).toContain('002-infra-create-b.patch');
  });

  it('does not flag modifications whose added lines reference a file created earlier', () => {
    // Sibling to the test above: the *direction* matters. If the
    // creator is earlier, this is a perfectly fine import and should not
    // trip the rule.
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry('001-infra-create-b.patch', 1, CREATE_A_DIFF, {
          'foo/B.sys.mjs': 'export const B = 1;',
        }),
        makeEntry(
          '002-infra-modifier.patch',
          2,
          '',
          {},
          {
            'browser/base/content/browser.js': 'import { B } from "resource:///modules/B.sys.mjs";',
          }
        ),
      ],
    };
    expect(lintPatchQueueForwardImports(ctx)).toHaveLength(0);
  });

  it('catches ChromeUtils.defineESModuleGetters forward references', () => {
    const importerContent = `
      ChromeUtils.defineESModuleGetters(globalThis, {
        B: "resource:///modules/B.sys.mjs",
      });
    `;
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry('001-infra-a.patch', 1, CREATE_A_DIFF, { 'foo/A.sys.mjs': importerContent }),
        makeEntry('002-infra-b.patch', 2, CREATE_A_DIFF, {
          'foo/B.sys.mjs': 'export const B = 1;',
        }),
      ],
    };
    const issues = lintPatchQueueForwardImports(ctx);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.check).toBe('forward-import');
    expect(issues[0]?.fingerprint).toContain(
      'forward-import|foo/A.sys.mjs|resource:///modules/B.sys.mjs|002-infra-b.patch:foo/B.sys.mjs'
    );
  });
});

describe('lintPatchQueue orchestrator', () => {
  it('concatenates duplicate-creation and forward-import issues', () => {
    const importerContent = `import { B } from "resource:///modules/B.sys.mjs";`;
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry('001-infra-a.patch', 1, CREATE_A_DIFF, { 'foo/A.sys.mjs': importerContent }),
        makeEntry('002-infra-b.patch', 2, CREATE_A_DUPLICATE_DIFF, {
          'foo/B.sys.mjs': 'export const B = 1;',
        }),
      ],
    };
    const issues = lintPatchQueue(ctx);
    const checks = issues.map((i) => i.check);
    expect(checks).toContain('duplicate-new-file-creation');
    expect(checks).toContain('forward-import');
  });
});

describe('lintPatchQueueModuleRegistrations', () => {
  const modulePath = 'browser/modules/hominis/HominisThemeLoader.sys.mjs';
  const importer =
    'import { HominisThemeLoader } from "resource:///modules/hominis/HominisThemeLoader.sys.mjs";';

  it('flags an imported new system module with no moz.build registration', () => {
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry('001-infra-loader.patch', 1, '', {
          [modulePath]: 'export const HominisThemeLoader = {};',
          'browser/modules/hominis/Consumer.sys.mjs': importer,
        }),
      ],
    };

    const issues = lintPatchQueueModuleRegistrations(ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      file: modulePath,
      check: 'unregistered-system-module',
      severity: 'error',
    });
    expect(issues[0]?.message).toContain('EXTRA_JS_MODULES');
  });

  it('accepts registration added by any patch in the projected queue', () => {
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry(
          '001-infra-register.patch',
          1,
          '',
          {},
          {
            'browser/modules/hominis/moz.build': '    "HominisThemeLoader.sys.mjs",',
          }
        ),
        makeEntry('002-infra-loader.patch', 2, '', {
          [modulePath]: 'export const HominisThemeLoader = {};',
          'browser/modules/hominis/Consumer.sys.mjs': importer,
        }),
      ],
    };

    expect(lintPatchQueueModuleRegistrations(ctx)).toEqual([]);
  });

  it('does not require registration for an unimported support file', () => {
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry('001-infra-loader.patch', 1, '', {
          [modulePath]: 'export const HominisThemeLoader = {};',
        }),
      ],
    };

    expect(lintPatchQueueModuleRegistrations(ctx)).toEqual([]);
  });
});

describe('collectNewFileCreatorsByPath', () => {
  it('returns every new-file path with its creators, including single-creator entries', () => {
    // status --ownership consumes this map and needs to see every
    // creation, not just duplicates, so `.length > 1` can be filtered
    // at the call site rather than recomputed.
    const createBDiff = [
      'diff --git a/foo/B.sys.mjs b/foo/B.sys.mjs',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/foo/B.sys.mjs',
      '@@ -0,0 +1,1 @@',
      '+export const B = 1;',
    ].join('\n');
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry('001-infra-a.patch', 1, CREATE_A_DIFF),
        makeEntry('002-infra-b.patch', 2, createBDiff),
      ],
    };
    const map = collectNewFileCreatorsByPath(ctx);
    expect(map.get('foo/A.sys.mjs')).toEqual(['001-infra-a.patch']);
    expect(map.get('foo/B.sys.mjs')).toEqual(['002-infra-b.patch']);
  });

  it('records both creators when the same path is created by two patches', () => {
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry('001-infra-a.patch', 1, CREATE_A_DIFF),
        makeEntry('002-infra-b.patch', 2, CREATE_A_DUPLICATE_DIFF),
      ],
    };
    const map = collectNewFileCreatorsByPath(ctx);
    expect(map.get('foo/A.sys.mjs')).toEqual(['001-infra-a.patch', '002-infra-b.patch']);
  });
});

describe('extractImportSpecifiers — adversarial shapes', () => {
  it('captures side-effect imports (`import "..."` with no `from` clause)', () => {
    // Side-effect imports are a valid ES module form Firefox uses for
    // observer-registration modules. The optional `from` group in the
    // regex means this matches, but the review pointed out the lack
    // of an explicit test — add one so a future regression is caught.
    const source = `import "resource:///modules/Side.sys.mjs";\nexport const X = 1;`;
    expect(extractImportSpecifiers(source)).toContain('resource:///modules/Side.sys.mjs');
  });

  it('captures defineESModuleGetters spanning multiple lines with trailing commas', () => {
    // The old regex used `[^}]*` for the getter-map body, which would
    // mismatch when the object spans lines or has trailing commas in
    // unusual places. The new brace-balanced walker should handle
    // either shape.
    const source = `
      ChromeUtils.defineESModuleGetters(
        lazy,
        {
          A: "resource:///modules/A.sys.mjs",
          B: "resource:///modules/B.sys.mjs",
        },
      );
    `;
    const specifiers = extractImportSpecifiers(source);
    expect(specifiers).toContain('resource:///modules/A.sys.mjs');
    expect(specifiers).toContain('resource:///modules/B.sys.mjs');
  });

  it('handles defineESModuleGetters whose values contain nested object literals', () => {
    // Rare in practice but the old `[^}]*` body regex would terminate
    // at the first `}` inside the nested literal and miss the second
    // string. The new brace-balanced walker keeps parsing past it.
    const source = `
      ChromeUtils.defineESModuleGetters(lazy, {
        A: (() => { return "resource:///modules/A.sys.mjs"; })(),
        B: "resource:///modules/B.sys.mjs",
      });
    `;
    const specifiers = extractImportSpecifiers(source);
    expect(specifiers).toContain('resource:///modules/A.sys.mjs');
    expect(specifiers).toContain('resource:///modules/B.sys.mjs');
  });
});

describe('lintPatchQueueForwardImports — suppression marker', () => {
  it('skips matches whose line carries the ignore marker', () => {
    const importerContent =
      `import { B } from "resource:///modules/B.sys.mjs"; // ${FORWARD_IMPORT_IGNORE_MARKER}\n` +
      `export const A = B;\n`;
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry('001-infra-a.patch', 1, CREATE_A_DIFF, { 'foo/A.sys.mjs': importerContent }),
        makeEntry('002-infra-b.patch', 2, CREATE_A_DIFF, {
          'foo/B.sys.mjs': 'export const B = 1;',
        }),
      ],
    };
    expect(lintPatchQueueForwardImports(ctx)).toHaveLength(0);
  });

  it('skips matches on the line immediately after the ignore marker', () => {
    const importerContent =
      `// ${FORWARD_IMPORT_IGNORE_MARKER}\n` +
      `import { B } from "resource:///modules/B.sys.mjs";\n` +
      `export const A = B;\n`;
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry('001-infra-a.patch', 1, CREATE_A_DIFF, { 'foo/A.sys.mjs': importerContent }),
        makeEntry('002-infra-b.patch', 2, CREATE_A_DIFF, {
          'foo/B.sys.mjs': 'export const B = 1;',
        }),
      ],
    };
    expect(lintPatchQueueForwardImports(ctx)).toHaveLength(0);
  });

  it('does not suppress unrelated forward-import matches on other lines', () => {
    // Ensures the suppression is line-scoped: a marker on one line
    // must not silently waive a different forward-import a few lines
    // later.
    const importerContent =
      `// ${FORWARD_IMPORT_IGNORE_MARKER}\n` +
      `import { B } from "resource:///modules/B.sys.mjs";\n` +
      `\n` +
      `import { C } from "resource:///modules/C.sys.mjs";\n`;
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry('001-infra-a.patch', 1, CREATE_A_DIFF, { 'foo/A.sys.mjs': importerContent }),
        makeEntry('002-infra-b.patch', 2, CREATE_A_DIFF, {
          'foo/B.sys.mjs': 'export const B = 1;',
        }),
        makeEntry('003-infra-c.patch', 3, CREATE_A_DIFF, {
          'foo/C.sys.mjs': 'export const C = 1;',
        }),
      ],
    };
    const issues = lintPatchQueueForwardImports(ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('003-infra-c.patch');
  });
});

describe('lintPatchQueueForwardImports — same-patch self-imports', () => {
  it('does not flag a patch that both creates a module and imports it from another file in the same patch', () => {
    // Intentional non-case: a single patch may legitimately create a
    // new `.sys.mjs` module AND, in the same body, modify a pre-existing
    // file to add an import targeting that module. Both sites belong to
    // the same patch, so there is no forward reference across patch
    // boundaries — the creator and the importer commit atomically. The
    // forward-import rule's filter (`owner.order > entry.order ||
    // (owner.order === entry.order && owner.filename > entry.filename)`)
    // excludes the entry from being its own later owner; this test pins
    // that behaviour so a future refactor of the filter cannot regress
    // same-patch self-imports into false positives.
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry(
          '001-infra-self.patch',
          1,
          CREATE_A_DIFF,
          { 'foo/A.sys.mjs': 'export const A = 1;' },
          {
            'browser/base/content/browser.js': 'import { A } from "resource:///modules/A.sys.mjs";',
          }
        ),
      ],
    };
    expect(lintPatchQueueForwardImports(ctx)).toHaveLength(0);
  });

  it('still flags a same-order import when the owner is lexicographically later', () => {
    // Tiebreaker case: two patches happen to share an order but have
    // different filenames. The rule breaks the tie by filename so the
    // forward direction is unambiguous. A patch with the lexicographically
    // earlier filename importing from the lexicographically later one
    // is a forward-import; the reverse is not. This pins the tiebreaker
    // direction so the self-import fix does not accidentally exempt
    // genuine same-order cross-patch forward references.
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry('001-infra-early.patch', 1, CREATE_A_DIFF, {
          'foo/A.sys.mjs': 'import { B } from "resource:///modules/B.sys.mjs";',
        }),
        makeEntry('001-infra-later.patch', 1, CREATE_A_DIFF, {
          'foo/B.sys.mjs': 'export const B = 1;',
        }),
      ],
    };
    const issues = lintPatchQueueForwardImports(ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('001-infra-later.patch');
  });
});

describe('lintPatchQueueDuplicateCreations — delete/recreate in same patch', () => {
  it('still flags the path when a second patch deletes and re-creates it', () => {
    // A patch that deletes an existing file AND creates a new one at
    // the same path emits both `deleted file mode` and
    // `new file mode` markers — the duplicate-creation rule should
    // still see the `new file mode` marker and count the patch as a
    // creator, so two patches both doing this still collide.
    const deleteAndRecreateDiff = [
      'diff --git a/foo/A.sys.mjs b/foo/A.sys.mjs',
      'deleted file mode 100644',
      'index aaaaaaa..0000000',
      '--- a/foo/A.sys.mjs',
      '+++ /dev/null',
      '@@ -1,1 +0,0 @@',
      '-old',
      'diff --git a/foo/A.sys.mjs b/foo/A.sys.mjs',
      'new file mode 100644',
      'index 0000000..2222222',
      '--- /dev/null',
      '+++ b/foo/A.sys.mjs',
      '@@ -0,0 +1,1 @@',
      '+export const A = 2;',
    ].join('\n');
    const ctx: PatchQueueContext = {
      entries: [
        makeEntry('001-infra-a.patch', 1, CREATE_A_DIFF),
        makeEntry('002-infra-b.patch', 2, deleteAndRecreateDiff),
      ],
    };
    const issues = lintPatchQueueDuplicateCreations(ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.file).toBe('foo/A.sys.mjs');
  });
});
