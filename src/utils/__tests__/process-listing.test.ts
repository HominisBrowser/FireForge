// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import {
  commandNamesRoot,
  countListingLines,
  parseProcessListing,
  psArguments,
} from '../process-listing.js';

describe('parseProcessListing', () => {
  const BIRTH = ['pid', 'ppid', 'pgid', 'lstart', 'stat'] as const;

  it('reads lstart as epoch seconds, under the fixed locale and zone', () => {
    const [row] = parseProcessListing('  123     1   123 Sat Nov  7 01:53:10 2026     Ss\n', BIRTH);
    expect(row).toEqual({
      pid: 123,
      ppid: 1,
      pgid: 123,
      lstart: String(Date.UTC(2026, 10, 7, 1, 53, 10) / 1000),
      stat: 'Ss',
    });
  });

  it('skips a line that does not fit, which the caller can detect', () => {
    const text = '  123 1 123 Sa. 7 Nov. 01:53:10 2026 Ss\n';
    expect(parseProcessListing(text, BIRTH)).toEqual([]);
    expect(countListingLines(text)).toBe(1);
  });

  it('keeps the rest of the line for a command column', () => {
    expect(
      parseProcessListing('  9 00:01 /bin/a b  c\r\n', ['pid', 'etime', 'command'] as const)
    ).toEqual([{ pid: 9, etime: '00:01', command: '/bin/a b  c' }]);
  });
});

describe('psArguments', () => {
  it('lists every process or only the given ones', () => {
    expect(psArguments(['pid', 'args'])).toEqual(['-axo', 'pid=,args=']);
    expect(psArguments(['pid'], [1, 2])).toEqual(['-o', 'pid=', '-p', '1,2']);
  });

  it('selects every process the BSD way when the environment is wanted, which procps also takes', () => {
    expect(psArguments(['pid', 'command'], undefined, true)).toEqual([
      'axeww',
      '-o',
      'pid=,command=',
    ]);
    expect(psArguments(['pid'], [1], true)).toEqual(['eww', '-o', 'pid=', '-p', '1']);
  });
});

describe('commandNamesRoot', () => {
  it('matches the root as a whole path token or a path under it', () => {
    expect(commandNamesRoot('/a/obj/dist/bin/x -f y', '/a/obj')).toBe(true);
    expect(commandNamesRoot('x --dir=/a/obj', '/a/obj/')).toBe(true);
    expect(commandNamesRoot('x "/a/obj"', '/a/obj')).toBe(true);
  });

  it('does not match a sibling, a longer name, a relative root or no root', () => {
    expect(commandNamesRoot('x /sibling/a/obj/y', '/a/obj')).toBe(false);
    expect(commandNamesRoot('x /a/obj2/y', '/a/obj')).toBe(false);
    expect(commandNamesRoot('x a/obj/y', 'a/obj')).toBe(false);
    expect(commandNamesRoot('x /a/obj/y', undefined)).toBe(false);
  });
});
