// SPDX-License-Identifier: EUPL-1.2
/**
 * The new-file + moved-code slice has no path through the two refusal
 * flags, and the working sequence is non-obvious. The refusal must name it.
 */
import { describe, expect, it } from 'vitest';

import { detectMovedCodeOverlaps, formatAdoptThenSplitRemedy } from '../export-moved-code-shape.js';

const MOVED_BODY = [
  'export function computeTabTitle(tab, options) {',
  '  const label = tab.getAttribute("label") ?? "";',
  '  return options.truncate ? label.slice(0, 40) : label;',
  '}',
];

function newFileDiff(path: string, lines: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +${String(lines.length)} @@`,
    ...lines.map((line) => `+${line}`),
    '',
  ].join('\n');
}

function modifiedFileDiff(path: string, lines: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -10,0 +11,4 @@',
    ...lines.map((line) => `+${line}`),
    '',
  ].join('\n');
}

describe('detectMovedCodeOverlaps', () => {
  it('recognizes new-file content the source patch still carries', () => {
    const overlaps = detectMovedCodeOverlaps(
      newFileDiff('browser/modules/TabTitle.sys.mjs', MOVED_BODY),
      [
        {
          filename: '002-ui-tabs.patch',
          diff: modifiedFileDiff('browser/base/tabs.js', MOVED_BODY),
        },
        {
          filename: '005-ui-other.patch',
          diff: modifiedFileDiff('browser/base/other.js', ['+ nothing to do with it at all']),
        },
      ]
    );

    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]?.sourcePatch).toBe('002-ui-tabs.patch');
    expect(overlaps[0]?.files).toEqual(['browser/modules/TabTitle.sys.mjs']);
    expect(overlaps[0]?.sharedLines).toBeGreaterThanOrEqual(3);
  });

  it('does not fire on incidental boilerplate overlap', () => {
    const boilerplate = ['}', '', '  );', 'import x;'];
    expect(
      detectMovedCodeOverlaps(newFileDiff('browser/modules/New.sys.mjs', boilerplate), [
        {
          filename: '002-ui-tabs.patch',
          diff: modifiedFileDiff('browser/base/tabs.js', boilerplate),
        },
      ])
    ).toEqual([]);
  });

  it('does not fire when the queue shares nothing with the pending diff', () => {
    expect(
      detectMovedCodeOverlaps(newFileDiff('browser/modules/TabTitle.sys.mjs', MOVED_BODY), [
        {
          filename: '002-ui-tabs.patch',
          diff: modifiedFileDiff('browser/base/tabs.js', [
            'const unrelatedConstantValue = 42;',
            'function unrelatedHelperFunction() {',
            '  return unrelatedConstantValue * 2;',
          ]),
        },
      ])
    ).toEqual([]);
  });

  it('ranks the strongest overlap first', () => {
    const overlaps = detectMovedCodeOverlaps(
      newFileDiff('browser/modules/TabTitle.sys.mjs', MOVED_BODY),
      [
        {
          filename: '009-weak.patch',
          diff: modifiedFileDiff('browser/base/a.js', MOVED_BODY.slice(0, 3)),
        },
        { filename: '002-strong.patch', diff: modifiedFileDiff('browser/base/b.js', MOVED_BODY) },
      ]
    );
    expect(overlaps[0]?.sourcePatch).toBe('002-strong.patch');
  });
});

describe('formatAdoptThenSplitRemedy', () => {
  it('spells out the adopt-then-split commands with real arguments', () => {
    const lines = formatAdoptThenSplitRemedy(
      [
        {
          sourcePatch: '002-ui-tabs.patch',
          files: ['browser/modules/TabTitle.sys.mjs'],
          sharedLines: 4,
        },
      ],
      '007-ui-tab-title.patch',
      7
    );
    const text = lines.join('\n');
    expect(text).toContain(
      'fireforge re-export 002-ui-tabs.patch --scan --scan-file browser/modules/TabTitle.sys.mjs'
    );
    expect(text).toContain(
      'fireforge patch move-files 002-ui-tabs.patch ui-tab-title --create --order 7 ' +
        '--file browser/modules/TabTitle.sys.mjs'
    );
  });

  it('adds nothing when the shape is absent', () => {
    expect(formatAdoptThenSplitRemedy([], '007-ui-x.patch', 7)).toEqual([]);
  });
});
