// SPDX-License-Identifier: EUPL-1.2
/**
 * Placement-refusal advice: register first when a new module only lacks
 * its moz.build line, and adopt-then-split only when the adopt itself
 * would pass the import-order and size checks.
 */
import { describe, expect, it } from 'vitest';

import type { PatchQueueContext, PatchQueueEntry } from '../../core/patch-lint.js';
import type { PatchLintIssue, PatchMetadata } from '../../types/commands/index.js';
import { describePlacementAdvice, findAdoptBlockers } from '../export-adopt-check.js';
import { projectEntryBody } from '../patch/entry-projection.js';

function newFileDiff(path: string, lines: readonly string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    '',
  ].join('\n');
}

function entry(
  filename: string,
  order: number,
  diff: string,
  extra: Partial<PatchMetadata> = {}
): PatchQueueEntry {
  return {
    filename,
    order,
    metadata: {
      filename,
      order,
      category: 'ui',
      name: 'x',
      description: '',
      createdAt: '',
      sourceEsrVersion: '140.9.0esr',
      filesAffected: [],
      ...extra,
    },
    ...projectEntryBody(diff),
  };
}

const MOVED = [
  'export function computeTabTitle(tab, options) {',
  '  const label = tab.getAttribute("label") ?? "";',
  '  return options.truncate ? label.slice(0, 40) : label;',
];

describe('findAdoptBlockers', () => {
  it('names a forward import the adopt would give the source patch', () => {
    const ctx: PatchQueueContext = {
      entries: [
        entry('002-ui-tabs.patch', 2, newFileDiff('browser/base/tabs.js', MOVED)),
        entry(
          '009-ui-later.patch',
          9,
          newFileDiff('browser/modules/Later.sys.mjs', ['export const L = 1;'])
        ),
      ],
    };
    const pending = newFileDiff('browser/modules/TabTitle.sys.mjs', [
      'import { L } from "resource:///modules/Later.sys.mjs";',
      ...MOVED,
    ]);
    expect(findAdoptBlockers(ctx, '002-ui-tabs.patch', pending)).toEqual([
      'browser/modules/TabTitle.sys.mjs imports "resource:///modules/Later.sys.mjs", created by ' +
        '009-ui-later.patch, which applies after 002-ui-tabs.patch (forward-import)',
    ]);
  });

  it('names the hard size limit unless the source waives large-patch-lines', () => {
    const big = Array.from(
      { length: 3100 },
      (_, index) => `export const value${index} = ${index};`
    );
    const ctx: PatchQueueContext = {
      entries: [entry('002-ui-tabs.patch', 2, newFileDiff('browser/base/tabs.js', big))],
    };
    const pending = newFileDiff('browser/modules/TabTitle.sys.mjs', MOVED);
    const [blocker] = findAdoptBlockers(ctx, '002-ui-tabs.patch', pending);
    expect(blocker).toMatch(/would grow to about \d+ lines, over its general hard limit of \d+/);

    const waived: PatchQueueContext = {
      entries: [
        entry('002-ui-tabs.patch', 2, newFileDiff('browser/base/tabs.js', big), {
          lintIgnore: ['large-patch-lines'],
        }),
      ],
    };
    expect(findAdoptBlockers(waived, '002-ui-tabs.patch', pending)).toEqual([]);
    expect(findAdoptBlockers(waived, '404-missing.patch', pending)).toEqual([]);
  });
});

describe('describePlacementAdvice', () => {
  const plan = { newFilename: '007-ui-tab-title.patch', insertionOrder: 7 };
  const pending = newFileDiff('browser/modules/TabTitle.sys.mjs', MOVED);
  const ctx: PatchQueueContext = {
    entries: [entry('002-ui-tabs.patch', 2, newFileDiff('browser/base/tabs.js', MOVED))],
  };
  const unregistered: PatchLintIssue = {
    file: 'browser/modules/TabTitle.sys.mjs',
    check: 'unregistered-system-module',
    patches: [plan.newFilename],
    message: 'm',
    severity: 'error',
  };

  it('says register first and offers nothing else when that is the only error', () => {
    const text = describePlacementAdvice(ctx, pending, [unregistered], plan).join('\n');
    expect(text).toContain('Register first: browser/modules/TabTitle.sys.mjs');
    expect(text).not.toContain('Working sequence');
  });

  it('keeps adopt-then-split as a fallback when other errors remain', () => {
    const other: PatchLintIssue = { ...unregistered, check: 'duplicate-new-file-creation' };
    const text = describePlacementAdvice(ctx, pending, [unregistered, other], plan).join('\n');
    expect(text).toContain('Register first');
    expect(text).toContain('Only if the export still fails once those modules are registered:');
    expect(text).toContain('Working sequence (adopt, then split):');
  });

  it('returns nothing for an unrelated refusal', () => {
    const unrelated = {
      ...ctx,
      entries: [entry('002-ui-x.patch', 2, newFileDiff('a/b.js', ['let unrelatedValueHere = 1;']))],
    };
    expect(describePlacementAdvice(unrelated, pending, [], plan)).toEqual([]);
  });
});
