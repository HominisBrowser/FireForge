// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { variantCascadeWarnings } from '../token-variant-cascade.js';

const token = '--test-color';
const path = 'browser/themes/shared/test-tokens.css';
const base = ':root {\n  --test-color: black;\n}\n';
const skin = '[data-skin="precision"]';
function warnings(css: string, variant = skin): string[] {
  return variantCascadeWarnings(css.split('\n'), variant, token, path);
}

describe('token variant cascade previews', () => {
  it('names later explicit-theme values that can override a newly inserted skin palette', () => {
    const css =
      base +
      ':root[data-theme="light"] {\n  --test-color: white;\n}\n:root[data-theme="dark"] {\n  --test-color: gray;\n}\n';
    const lines = css.split('\n'),
      before = [...lines];
    const result = variantCascadeWarnings(lines, skin, token, path);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain(path + ':5');
    expect(result[0]).toContain(':root[data-theme="light"]');
    expect(result[1]).toContain(':root[data-theme="dark"]');
    expect(result[0]).toContain('equal-specificity');
    expect(result[0]).toContain('preserves the existing CSS order');
    expect(lines).toEqual(before);
  });

  it('does not call lower/higher specificity or mutually exclusive skin selectors equal-precedence risks', () => {
    const css =
      base +
      ':root {\n  --test-color: red;\n}\n:root[data-theme="light"][data-private] {\n  --test-color: red;\n}\n:root[data-skin="glass"] {\n  --test-color: red;\n}\n';
    expect(warnings(css)).toEqual([]);
  });

  it('retains media/context information instead of asserting that every conditional branch applies', () => {
    const css =
      base +
      '@media (prefers-color-scheme: dark) {\n  :root[data-theme="light"] {\n    --test-color: red;\n  }\n}\n';
    const result = warnings(css);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('@media (prefers-color-scheme: dark) > :root[data-theme="light"]');
    expect(result[0]).toContain('surrounding conditions match');
  });

  it('warns when appending inside an existing empty variant while preserving original source line numbers', () => {
    const css =
      base +
      ':root[data-skin="precision"] {\n}\n:root[data-theme="light"] {\n  --test-color: white;\n}\n';
    expect(warnings(css)[0]).toContain(path + ':7');
    expect(
      warnings(
        css.replace(
          ':root[data-skin="precision"] {\n}',
          ':root[data-skin="precision"] {\n  --test-color: blue;\n}'
        )
      )
    ).toEqual([]);
  });

  it('ignores comments, other token names and declarations earlier than the actual insertion', () => {
    const css =
      base +
      ':root[data-theme="light"] {\n  --test-color: white;\n}\n:root[data-skin="precision"] {\n}\n/* :root[data-theme="dark"] {\n --test-color: red;\n} */\n:root[data-theme="dark"] {\n  --other-color: red;\n}\n';
    expect(warnings(css)).toEqual([]);
  });

  it('handles multi-attribute and qualified selector precedence without changing either selector', () => {
    const css =
      base + ':root[data-theme="light"]:not([data-private]) {\n  --test-color: white;\n}\n';
    expect(warnings(css, '[data-skin="precision"]:not([data-private])')).toHaveLength(1);
    expect(warnings(css, '[data-skin="precision"][data-density="compact"]')).toHaveLength(1);
  });

  it('does not invent precise specificity for unsupported selector syntax, and handles selector lists', () => {
    const unsupported =
      base +
      'html[data-theme="light"] {\n  --test-color: white;\n}\n:root[data-theme~="light"][data-private] {\n  --test-color: white;\n}\n:root:is([data-theme="light"]) {\n  --test-color: white;\n}\n';
    expect(warnings(unsupported)).toEqual([]);
    const list =
      base + ':root[data-skin="glass"], :root[data-theme="light"] {\n  --test-color: white;\n}\n';
    expect(warnings(list)).toHaveLength(1);
  });

  it('counts repeated attribute selectors in specificity while comparing shared attribute values', () => {
    const css =
      base + ':root[data-theme="light"][data-theme="light"] {\n  --test-color: white;\n}\n';
    expect(warnings(css, '[data-skin="precision"][data-density="compact"]')).toHaveLength(1);
    const impossible =
      base + ':root[data-theme="light"][data-theme="dark"] {\n  --test-color: white;\n}\n';
    expect(warnings(impossible, '[data-skin="precision"][data-density="compact"]')).toEqual([]);
    const presence = base + ':root[data-skin="glass"][data-skin] {\n  --test-color: white;\n}\n';
    expect(warnings(presence, '[data-skin="precision"][data-density="compact"]')).toEqual([]);
  });
});
