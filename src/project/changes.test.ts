// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import {
  type ContentReader,
  createChangeSet,
  netChange,
  type OwnedChange,
  textContent,
} from './index.js';

const bytes =
  (text: string): ContentReader =>
  () =>
    Promise.resolve(new TextEncoder().encode(text));

function create(path: string, group?: string, content = path): OwnedChange {
  return {
    kind: 'create',
    path,
    after: bytes(content),
    mode: '100644',
    binary: false,
    meta: {},
    ...(group === undefined ? {} : { group }),
  };
}

function modify(path: string, group?: string, content = `${path}!`): OwnedChange {
  return {
    kind: 'modify',
    path,
    before: bytes('upstream'),
    after: bytes(content),
    previousMode: '100644',
    mode: '100644',
    binary: false,
    meta: {},
    ...(group === undefined ? {} : { group }),
  };
}

function remove(path: string, group?: string): OwnedChange {
  return {
    kind: 'delete',
    path,
    before: bytes('upstream'),
    previousMode: '100755',
    binary: false,
    meta: {},
    ...(group === undefined ? {} : { group }),
  };
}

const groups = ['001-a.patch', '002-b.patch', '003-c.patch'].map((id) => ({ id, meta: {} }));

async function read(reader: ContentReader | undefined): Promise<string | undefined> {
  return reader === undefined ? undefined : textContent(await reader());
}

describe('netChange', () => {
  it.each([
    [
      'create then modify',
      [create('f', '001-a.patch'), modify('f', '002-b.patch', 'v2')],
      'create',
    ],
    ['create then delete', [create('f', '001-a.patch'), remove('f', '002-b.patch')], undefined],
    ['modify then modify', [modify('f', '001-a.patch'), modify('f', '002-b.patch')], 'modify'],
    ['modify then delete', [modify('f', '001-a.patch'), remove('f', '002-b.patch')], 'delete'],
    ['delete then create', [remove('f', '001-a.patch'), create('f', '002-b.patch')], 'modify'],
  ] as const)('%s nets to %s', (_name, steps, kind) => {
    expect(netChange(steps)?.kind).toBe(kind);
  });

  it('reads the upstream side from the first step and the result from the last', async () => {
    const net = netChange([remove('f', '001-a.patch'), create('f', '002-b.patch', 'new')]);
    if (net?.kind !== 'modify') throw new Error('expected a modify');
    expect(await read(net.before)).toBe('upstream');
    expect(await read(net.after)).toBe('new');
    expect(net.previousMode).toBe('100755');
    expect(net.mode).toBe('100644');
    expect(net.group).toBe('001-a.patch');
  });

  it('is binary when any step is', () => {
    const net = netChange([
      create('f', '001-a.patch'),
      { ...modify('f', '002-b.patch'), binary: true },
    ]);
    expect(net?.binary).toBe(true);
  });
});

describe('createChangeSet', () => {
  const set = createChangeSet({
    groups,
    changes: [
      modify('b.js', '003-c.patch'),
      create('z.css'),
      modify('b.js', '001-a.patch'),
      create('a.js', '002-b.patch'),
      create('gone.js', '001-a.patch'),
      remove('gone.js', '003-c.patch'),
    ],
  });

  it('orders steps by group, ungrouped last, then by path', () => {
    expect(set.changes.map((change) => `${change.group ?? '-'}:${change.path}`)).toEqual([
      '001-a.patch:b.js',
      '001-a.patch:gone.js',
      '002-b.patch:a.js',
      '003-c.patch:b.js',
      '003-c.patch:gone.js',
      '-:z.css',
    ]);
  });

  it('looks steps up by path and by group', () => {
    expect(set.at('b.js').map((change) => change.group)).toEqual(['001-a.patch', '003-c.patch']);
    expect(set.at('nope')).toEqual([]);
    expect(set.inGroup('003-c.patch').map((change) => change.path)).toEqual(['b.js', 'gone.js']);
    expect(set.inGroup('nope')).toEqual([]);
    expect(set.group('002-b.patch')).toEqual({ id: '002-b.patch', meta: {} });
  });

  it('nets each owned path once and drops paths whose steps cancel out', () => {
    expect(set.net().map((change) => `${change.kind}:${change.path}`)).toEqual([
      'create:a.js',
      'modify:b.js',
      'create:z.css',
    ]);
    expect(set.final('gone.js')).toBeUndefined();
    expect(set.final('b.js')?.kind).toBe('modify');
  });

  it('hands out the provider diff function', async () => {
    const withDiff = createChangeSet({
      changes: [create('a')],
      diff: (change) => Promise.resolve(`+${change.path}`),
    });
    expect(await withDiff.diff?.(withDiff.net()[0] as OwnedChange)).toBe('+a');
    expect(set.diff).toBeUndefined();
  });

  it.each([
    ['duplicate group IDs', { groups: [...groups, groups[0]] as typeof groups, changes: [] }],
    ['an unknown group', { groups, changes: [create('a', 'nope')] }],
    [
      'two steps of one group on a path',
      { groups, changes: [create('a', '001-a.patch'), modify('a', '001-a.patch')] },
    ],
    [
      'an ungrouped step beside others',
      { groups, changes: [create('a'), modify('a', '002-b.patch')] },
    ],
    [
      'a modify after a delete',
      { groups, changes: [remove('a', '001-a.patch'), modify('a', '002-b.patch')] },
    ],
    [
      'a create after a create',
      { groups, changes: [create('a', '001-a.patch'), create('a', '002-b.patch')] },
    ],
  ])('refuses %s as a provider bug', (_name, input) => {
    expect(() => createChangeSet(input)).toThrow(
      expect.objectContaining({ code: 'internal' }) as Error
    );
  });
});

describe('textContent', () => {
  it.each([
    ['plain UTF-8', new TextEncoder().encode('héllo'), 'héllo'],
    ['a NUL byte', new Uint8Array([104, 0, 105]), undefined],
    ['invalid UTF-8', new Uint8Array([0xff, 0xfe, 0x41]), undefined],
  ])('decodes %s', (_name, input, expected) => {
    expect(textContent(input)).toBe(expected);
  });
});
