// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { TOKENS_CSS } from '../testing/tokens.js';
import { addToken, type AddTokenRequest, tokenName } from './add.js';
import { listTokens, tokenValues } from './model.js';

function add(overrides: Partial<AddTokenRequest>, text = TOKENS_CSS): ReturnType<typeof addToken> {
  return addToken(text, {
    name: '--acme-new',
    value: '1px',
    mode: 'static',
    category: 'Spacing',
    ...overrides,
  });
}

describe('addToken in a category', () => {
  it('puts the token after the last one of its category, annotated', () => {
    const { text, changed } = add({});
    expect(changed).toBe(true);
    expect(text).toContain(
      '  --acme-gap: 8px; /* static, fork-specific */\n  --acme-new: 1px; /* static, fork-specific */\n}'
    );
    expect(listTokens(text)[1]?.tokens.map((t) => t.name)).toEqual(['--acme-gap', '--acme-new']);
  });

  it('writes the mode annotation for each kind of value', () => {
    expect(add({ value: 'var(--other)' }).text).toContain('--acme-new: var(--other); /* static */');
    expect(add({ mode: 'auto', value: 'light-dark(red, blue)' }).text).toContain(
      '/* auto (light-dark) */'
    );
    expect(add({ mode: 'auto' }).text).toContain('--acme-new: 1px; /* auto */');
  });

  it('adds a description comment above the declaration', () => {
    expect(add({ description: 'Tight gap' }).text).toContain(
      '  /* Tight gap */\n  --acme-new: 1px;'
    );
  });

  it('does not let a comment containing braces confuse the section', () => {
    const { text } = add({ category: 'Colors' });
    expect(text).toContain(
      '--acme-paper: light-dark(#ffffff, #222222); /* auto (light-dark) */\n  --acme-new: 1px;'
    );
  });

  it('skips a token already in the category and says where', () => {
    const result = add({ name: '--acme-gap' });
    expect(result).toMatchObject({
      changed: false,
      text: TOKENS_CSS,
      existing: { line: 10, where: 'category "Spacing"' },
    });
  });

  it('refuses a token declared in another category, naming it', () => {
    expect(() => add({ name: '--acme-ink', category: 'Spacing' })).toThrow(
      /already declared outside category "Spacing" \(line 6, category "Colors"\)/
    );
  });

  it('refuses an unknown category and lists the known ones, unless asked to create it', () => {
    expect(() => add({ category: 'Motion' })).toThrow(/"Colors", "Spacing"/);
    const created = add({ category: 'Motion', createCategory: true });
    expect(created.categoryCreated).toBe(true);
    expect(created.text).toContain(
      '  --acme-gap: 8px; /* static, fork-specific */\n\n  /* = Motion = */\n  --acme-new: 1px; /* static, fork-specific */\n}'
    );
    expect(listTokens(created.text).at(-1)?.category).toBe('Motion');
  });

  it('does not take a category name that is only a prefix of a banner', () => {
    expect(() => add({ category: 'Color' })).toThrow(/not found/);
  });

  it('refuses a file with no base block', () => {
    expect(() => add({}, '/* empty */\n')).toThrow(/no :root block/);
  });

  it('works on a base block written on one line', () => {
    const { text } = add({ category: 'A', createCategory: true }, ':root { --x: 1; }\n');
    expect(text).toBe(
      ':root {\n  --x: 1;\n\n  /* = A = */\n  --acme-new: 1px; /* static, fork-specific */\n}\n'
    );
  });
});

describe('addToken override', () => {
  const override = {
    name: '--acme-tint',
    category: 'Colors',
    mode: 'override',
    value: '#fff',
    darkValue: '#000',
  } as const;

  it('writes the dark value into the nested :root of the dark media block', () => {
    const { text } = add(override);
    expect(tokenValues(text, '--acme-tint').map((v) => [v.block, v.value])).toEqual([
      [':root', '#fff'],
      ['@media (prefers-color-scheme: dark) > :root', '#000'],
      [':root[data-theme="dark"]', '#000'],
      [':root[data-theme="light"]:not([data-private])', '#fff'],
    ]);
  });

  it('reports the theme blocks it mirrored into, and the qualifier that narrows one', () => {
    const result = add(override);
    expect(result.mirrored).toEqual([
      ':root[data-theme="dark"]',
      ':root[data-theme="light"]:not([data-private])',
    ]);
    expect(result.notes).toEqual([expect.stringContaining('":not([data-private])" qualifier')]);
  });

  it('leaves theme blocks alone when the file has none, and creates a missing dark block', () => {
    const bare = ':root {\n  /* = A = */\n}\n';
    const { text, mirrored } = add({ ...override, category: 'A' }, bare);
    expect(mirrored).toEqual([]);
    expect(text).toContain(
      '@media (prefers-color-scheme: dark) {\n  :root {\n    --acme-tint: #000;\n  }\n}\n'
    );
  });

  it('adds a nested :root when the dark media block has none', () => {
    const bare = ':root {\n  /* = A = */\n}\n@media (prefers-color-scheme: dark) {\n}\n';
    const { text } = add({ ...override, category: 'A' }, bare);
    expect(text).toContain(
      '@media (prefers-color-scheme: dark) {\n  :root {\n    --acme-tint: #000;\n  }\n}'
    );
  });

  it('requires a dark value for override and refuses one otherwise', () => {
    expect(() => add({ mode: 'override' })).toThrow(/needs --dark-value/);
    expect(() => add({ darkValue: '#000' })).toThrow(/override only/);
  });
});

describe('addToken variant', () => {
  const variant = { name: '--acme-gap', value: '2px', variant: '[data-skin=precision]' };

  it('creates the variant block after the base block, with quoted attribute values', () => {
    const { text } = add(variant);
    expect(text).toContain(
      '}\n\n:root[data-skin="precision"] {\n  --acme-gap: 2px; /* static, fork-specific */\n}\n\n:root[data-skin="plain"]'
    );
  });

  it('appends to an existing block and is idempotent', () => {
    const first = add({ ...variant, variant: '[data-skin="plain"]', name: '--acme-ink' });
    expect(first.text).toContain(
      '  --acme-gap: 4px;\n  --acme-ink: 2px; /* static, fork-specific */\n}'
    );
    expect(first.changed).toBe(true);
    const again = add({ ...variant, variant: "[data-skin='plain']" });
    expect(again).toMatchObject({
      changed: false,
      existing: { line: 14, where: ':root[data-skin="plain"]' },
    });
  });

  it('matches the qualifier exactly', () => {
    const { text } = add({ ...variant, variant: '[data-theme="light"]' });
    expect(text).toContain(':root[data-theme="light"] {\n  --acme-gap: 2px;');
    const qualified = add({
      ...variant,
      variant: '[data-theme="light"]:not([data-private])',
      name: '--acme-tint',
    });
    expect(qualified.text).toContain(
      ':root[data-theme="light"]:not([data-private]) {\n  --acme-ink: #111111;\n  --acme-tint: 2px;'
    );
  });

  it('needs no category, but refuses override and create-category', () => {
    expect(() => add({ ...variant, category: undefined })).not.toThrow();
    expect(() => add({ ...variant, mode: 'override', darkValue: '#0' })).toThrow(
      /cannot be combined/
    );
    expect(() => add({ ...variant, createCategory: true })).toThrow(/cannot be combined/);
  });

  it.each([
    '',
    'data-skin',
    '[data skin]',
    '[data-skin="a b"]',
    '[data-skin=x] [data-b]',
    '[data-skin=x]:not(.c)',
    '[data-skin=x]{color:red}',
    '[1x]',
  ])('refuses the selector %j', (selector) => {
    expect(() => add({ ...variant, variant: selector })).toThrow(/--variant/);
  });
});

describe('validation', () => {
  it.each([
    ['a;b', /one declaration|";"/],
    ['a}', /"}"/],
    ['a{', /"\{"/],
    ['a /* c */', /comment/],
    ['a\nb', /single line/],
    ['var(--x', /unbalanced "\("/],
    ['x)', /unbalanced "\)"/],
    ['"open', /unterminated string/],
  ])('refuses the value %j', (value, message) => {
    expect(() => add({ value })).toThrow(message);
  });

  it('accepts a semicolon inside a string or parentheses', () => {
    expect(() => add({ value: '"a;b"' })).not.toThrow();
    expect(() => add({ value: 'url(data:image/png;base64,AA==)' })).not.toThrow();
  });

  it('refuses a description that could end its comment', () => {
    expect(() => add({ description: 'x */ y' })).toThrow(/one line without/);
    expect(() => add({ description: 'x\ny' })).toThrow(/one line without/);
  });

  it('requires a category for a base declaration', () => {
    expect(() => add({ category: undefined })).toThrow(/--category is required/);
    expect(() => add({ category: ' ' })).toThrow(/--category is required/);
  });
});

describe('tokenName', () => {
  it('takes a full name as written and a bare name with the prefix', () => {
    expect(tokenName('--acme-gap', '--acme-')).toBe('--acme-gap');
    expect(tokenName('gap', '--acme-')).toBe('--acme-gap');
    expect(tokenName('gap', undefined)).toBe('--gap');
    expect(tokenName('--gap', undefined)).toBe('--gap');
  });

  it('does not prefix a bare name twice', () => {
    expect(tokenName('acme-gap', '--acme-')).toBe('--acme-gap');
    expect(tokenName('acme', '--acme-')).toBe('--acme');
    expect(tokenName('acmegap', '--acme-')).toBe('--acme-acmegap');
  });

  it.each(['', '--', 'a b', 'a;b', 'a/*b', 'a"b', 'a{b}', 'a(b)', 'a\\b'])(
    'refuses the name %j',
    (name) => {
      expect(() => tokenName(name, undefined)).toThrow();
    }
  );
});
