// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { lintSteps } from '../../testing/lint.js';
import { writeTree } from '../../testing/temp.js';
import { useTempDir } from '../../testing/temp.js';
import type { Finding } from '../index.js';

const ranges = [{ from: 1, to: 899, category: 'ui' }];
const rules = ['upstream-allowlist', 'add-only', 'scope', 'policy-document-missing'];

function policy(fields: Record<string, unknown>): Record<string, unknown> {
  return { patchPolicy: { ranges, addOnlyMarker: 'mine', ...fields } };
}

const allowlist = [
  'browser/moz.configure',
  { path: '**/jar.mn', addOnly: true, retiredPaths: ['old.svg'] },
];
const jar = 'browser.jar:\n  content/browser/old.svg (old.svg)\n  content/browser/a.js (a.js)\n';

describe('upstream-allowlist', () => {
  it('names the upstream files a group changes outside the allowlist, not the files it creates', async () => {
    const findings = await lintSteps(
      rules,
      [
        { path: 'browser/moz.configure', group: 'g', before: 'a\n', after: 'b\n' },
        { path: 'dom/base/x.cpp', group: 'g', before: 'a\n', after: 'b\n' },
        { path: 'browser/mine.js', group: 'g', after: 'new\n' },
      ],
      { groups: ['g'], config: policy({ upstreamAllowlist: allowlist }) }
    );
    expect(findings.map((f) => [f.rule, f.group, f.severity])).toEqual([
      ['upstream-allowlist', 'g', 'error'],
    ]);
    expect(findings[0]?.message).toContain('dom/base/x.cpp. Move');
  });

  it('reports at warning severity under mutationMode warn', async () => {
    const findings = await lintSteps(
      rules,
      [{ path: 'dom/x.cpp', group: 'g', before: 'a\n', after: 'b\n' }],
      { groups: ['g'], config: policy({ upstreamAllowlist: allowlist, mutationMode: 'warn' }) }
    );
    expect(findings.map((f) => f.severity)).toEqual(['warning']);
  });

  it('holds an exception to the files its entry lists, and to a list that is current', async () => {
    const reservedRanges = [
      {
        from: 900,
        to: 999,
        allowed: [
          {
            filename: '900-x.patch',
            files: ['dom/a.cpp', 'dom/stale.cpp', 'dom/mine.cpp'],
            adr: 'adr.md',
          },
        ],
      },
    ];
    const findings = await lintSteps(
      rules,
      [
        { path: 'dom/a.cpp', group: '900-x.patch', before: 'a\n', after: 'b\n' },
        { path: 'dom/b.cpp', group: '900-x.patch', before: 'a\n', after: 'b\n' },
        { path: 'dom/mine.cpp', group: '900-x.patch', after: 'new\n' },
      ],
      { groups: ['900-x.patch'], config: policy({ upstreamAllowlist: allowlist, reservedRanges }) }
    );
    expect(findings.map((f) => f.message)).toEqual([
      '900-x.patch is a reviewed exception, but changes upstream file(s) its entry does not list: dom/b.cpp.',
      "900-x.patch's exception lists upstream file(s) it no longer changes: dom/stale.cpp. Update the entry.",
    ]);
  });
});

describe('add-only', () => {
  const lint = (after: string | undefined): Promise<Finding[]> =>
    lintSteps(rules, [{ path: 'browser/base/jar.mn', group: 'g', before: jar, after }], {
      groups: ['g'],
      config: policy({ upstreamAllowlist: allowlist }),
    });

  it.each([
    [`${jar}  content/browser/b.js (b.js) # MINE\n`, undefined],
    [`${jar}\n`, undefined],
    [jar.replace('  content/browser/old.svg (old.svg)\n', ''), undefined],
    [`${jar}  content/browser/b.js (b.js)\n`, 'adds 1 line(s) without the "mine" marker'],
    [jar.replace('  content/browser/a.js (a.js)\n', ''), 'removes 1 line(s)'],
    [undefined, 'deletes the file'],
  ])('%j', async (after, problem) => {
    const findings = await lint(after);
    expect(findings.map((f) => f.message.split('but ')[1]?.slice(0, problem?.length))).toEqual(
      problem === undefined ? [] : [problem]
    );
  });
});

describe('scope', () => {
  it('limits the groups a rule selects to its globs', async () => {
    const findings = await lintSteps(
      rules,
      [
        { path: 'browser/tests/browser_a.js', group: '100-ui-a-tests.patch', after: 'x\n' },
        { path: 'browser/a.js', group: '100-ui-a-tests.patch', after: 'x\n' },
        { path: 'browser/b.js', group: '101-ui-b.patch', after: 'x\n' },
      ],
      {
        groups: ['100-ui-a-tests.patch', '101-ui-b.patch'],
        config: policy({ scopeRules: [{ group: '-tests\\.patch$', files: ['**/tests/**'] }] }),
      }
    );
    expect(findings.map((f) => [f.rule, f.group])).toEqual([['scope', '100-ui-a-tests.patch']]);
    expect(findings[0]?.message).toContain('but touches: browser/a.js.');
  });
});

describe('policy-document-missing', () => {
  const dir = useTempDir();

  it('requires the documents of exceptions to exist when verifyDocumentPaths is on', async () => {
    await writeTree(dir(), { 'docs/adr.md': '# ADR\n' });
    const reservedRanges = [
      {
        from: 900,
        to: 999,
        allowed: [{ filename: '900-x.patch', adr: 'docs/adr.md', documentation: 'docs/gone.md' }],
      },
    ];
    const config = policy({ reservedRanges, verifyDocumentPaths: true });
    const findings = await lintSteps(rules, [], { config, projectRoot: dir() });
    expect(findings.map((f) => f.message)).toEqual([
      '900-x.patch\'s exception names documentation "docs/gone.md", which does not exist. Restore it or correct the path.',
    ]);
  });
});
