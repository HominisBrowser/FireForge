// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { describeEngineGenerationDelta } from '../engine-session-lock.js';

/** Builds a generation token the way `snapshotEngineGeneration` does. */
function token(head: string, records: string[]): string {
  return `${head}\0${records.map((record) => `${record}\0`).join('')}`;
}

describe('describeEngineGenerationDelta', () => {
  it('reports nothing when the tokens are identical', () => {
    const same = token('abc123', [' M browser/base/content/browser.js']);
    expect(describeEngineGenerationDelta(same, same)).toEqual([]);
  });

  it('names a HEAD move by both SHAs', () => {
    expect(describeEngineGenerationDelta(token('aaa', []), token('bbb', []))).toEqual([
      'HEAD moved: aaa -> bbb',
    ]);
  });

  it('names an entry that appeared', () => {
    const lines = describeEngineGenerationDelta(
      token('aaa', []),
      token('aaa', ['?? browser/base/content/scratch.tmp'])
    );
    expect(lines).toEqual([
      'Working-tree entries that appeared: ?? browser/base/content/scratch.tmp',
    ]);
  });

  it('names an entry that went away', () => {
    const lines = describeEngineGenerationDelta(
      token('aaa', ['?? engine-temp.txt']),
      token('aaa', [])
    );
    expect(lines).toEqual(['Working-tree entries that went away: ?? engine-temp.txt']);
  });

  it('consumes both path fields of a rename so later records stay aligned', () => {
    // `-z` puts the ORIGIN path in a second NUL-separated field. Consuming
    // only one desynchronises the parse and turns one rename into a report
    // that everything after it moved.
    const before = token('aaa', []);
    const after = `aaa\0R  new/path.js\0old/path.js\0 M browser/base/content/browser.js\0`;
    expect(describeEngineGenerationDelta(before, after)).toEqual([
      'Working-tree entries that appeared: ' +
        ' M browser/base/content/browser.js, R  old/path.js -> new/path.js',
    ]);
  });

  it('truncates a large delta rather than printing every entry', () => {
    const many = Array.from({ length: 9 }, (_, index) => `?? file-${String(index)}.txt`);
    const lines = describeEngineGenerationDelta(token('aaa', []), token('aaa', many));
    expect(lines[0]).toContain('(+4 more)');
  });

  it('returns an empty list for tokens it cannot parse, rather than throwing', () => {
    expect(describeEngineGenerationDelta('unparseable', 'unparseable')).toEqual([]);
    expect(() => describeEngineGenerationDelta('', '')).not.toThrow();
  });
});
