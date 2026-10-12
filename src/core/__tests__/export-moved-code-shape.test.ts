// SPDX-License-Identifier: EUPL-1.2
/**
 * The new-file + moved-code slice has no path through the two refusal
 * flags, and the working sequence is non-obvious. The refusal must name it.
 */
import { describe, expect, it } from 'vitest';

import {
  detectMovedCodeOverlaps,
  formatMovedCodeAdvice,
  type MovedCodeOverlap,
} from '../export-moved-code-shape.js';

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

  it('does not fire on scattered shared lines that form no contiguous block', () => {
    // The false positive this guards: a large patch sharing many common
    // statements with a new module, none of them adjacent in both.
    const common = [
      'const lazy = XPCOMUtils.declareLazy({});',
      'Services.prefs.getBoolPref("browser.hominis.enabled", false);',
      'this.#listeners = new Set();',
      'window.addEventListener("unload", this);',
    ];
    const pending = common.flatMap((line, index) => [
      line,
      `const uniqueLine${index}ForTheNewFile = ${index};`,
    ]);
    const source = [...common]
      .reverse()
      .flatMap((line, index) => [line, `const otherLine${index}InSource = ${index};`]);
    expect(
      detectMovedCodeOverlaps(newFileDiff('browser/modules/New.sys.mjs', pending), [
        {
          filename: '292-ui-settings-window.patch',
          diff: modifiedFileDiff('browser/base/s.js', source),
        },
      ])
    ).toEqual([]);
  });

  it('reports the matched block with its source file', () => {
    const overlaps = detectMovedCodeOverlaps(
      newFileDiff('browser/modules/TabTitle.sys.mjs', [
        'const headerOfTheNewFile = 1;',
        ...MOVED_BODY,
      ]),
      [
        {
          filename: '002-ui-tabs.patch',
          diff: modifiedFileDiff('browser/base/tabs.js', MOVED_BODY),
        },
      ]
    );
    expect(overlaps[0]?.blocks).toEqual([
      {
        file: 'browser/modules/TabTitle.sys.mjs',
        sourceFile: 'browser/base/tabs.js',
        lines: MOVED_BODY.slice(0, 3).map((line) => line.trim()),
      },
    ]);
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

const OVERLAP: MovedCodeOverlap = {
  sourcePatch: '002-ui-tabs.patch',
  files: ['browser/modules/TabTitle.sys.mjs'],
  sharedLines: 3,
  blocks: [
    {
      file: 'browser/modules/TabTitle.sys.mjs',
      sourceFile: 'browser/base/tabs.js',
      lines: MOVED_BODY.slice(0, 3).map((line) => line.trim()),
    },
  ],
};

describe('formatMovedCodeAdvice', () => {
  it('spells out the adopt-then-split commands and names the matched lines', () => {
    const text = formatMovedCodeAdvice({
      overlaps: [OVERLAP],
      newPatchName: '007-ui-tab-title.patch',
      insertionOrder: 7,
    }).join('\n');
    expect(text).toContain(
      'fireforge re-export 002-ui-tabs.patch --scan --scan-file browser/modules/TabTitle.sys.mjs'
    );
    expect(text).toContain(
      'fireforge patch move-files 002-ui-tabs.patch ui-tab-title --create --order 7 ' +
        '--file browser/modules/TabTitle.sys.mjs'
    );
    expect(text).toContain(
      'browser/modules/TabTitle.sys.mjs ← 002-ui-tabs.patch (browser/base/tabs.js), 3 line(s):'
    );
    expect(text).toContain(`    | ${MOVED_BODY[1]?.trim() ?? ''}`);
    expect(text).not.toContain('Register first');
  });

  it('adds nothing when neither shape is present', () => {
    expect(
      formatMovedCodeAdvice({ overlaps: [], newPatchName: '007-ui-x.patch', insertionOrder: 7 })
    ).toEqual([]);
  });

  it('says register first, and offers adopt-then-split only as a fallback', () => {
    const text = formatMovedCodeAdvice({
      overlaps: [OVERLAP],
      newPatchName: '007-ui-tab-title.patch',
      insertionOrder: 7,
      unregisteredModules: ['browser/modules/TabTitle.sys.mjs'],
    }).join('\n');
    expect(
      text.indexOf('Register first: browser/modules/TabTitle.sys.mjs is a new system module')
    ).toBeLessThan(text.indexOf('Working sequence'));
    expect(text).toContain('Only if the export still fails once those modules are registered:');
  });

  it('drops adopt-then-split entirely when registering is the whole fix', () => {
    const text = formatMovedCodeAdvice({
      overlaps: [OVERLAP],
      newPatchName: '007-ui-tab-title.patch',
      insertionOrder: 7,
      unregisteredModules: ['a/A.sys.mjs', 'a/B.sys.mjs'],
      registrationResolvesAll: true,
    }).join('\n');
    expect(text).toContain('a/A.sys.mjs, a/B.sys.mjs are new system modules');
    expect(text).toContain('need no adoption into another patch');
    expect(text).not.toContain('Working sequence');
  });

  it('names why the adopt would be refused instead of recommending it', () => {
    const text = formatMovedCodeAdvice({
      overlaps: [
        {
          ...OVERLAP,
          blocks: [
            OVERLAP.blocks[0],
            OVERLAP.blocks[0],
            OVERLAP.blocks[0],
            OVERLAP.blocks[0],
          ].filter((b) => b !== undefined),
        },
      ],
      newPatchName: '007-ui-tab-title.patch',
      insertionOrder: 7,
      adoptBlockers: ['002-ui-tabs.patch would grow to about 3100 lines'],
    }).join('\n');
    expect(text).not.toContain('Working sequence');
    expect(text).toContain('would be refused too, so it is not offered');
    expect(text).toContain('  - 002-ui-tabs.patch would grow to about 3100 lines');
    expect(text).toContain('… 1 more block(s)');
  });
});
