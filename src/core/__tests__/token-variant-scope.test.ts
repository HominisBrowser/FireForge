// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import {
  findVariantBlockDeclaration,
  insertVariantDeclaration,
  variantBlockExists,
} from '../token-variant.js';

const variant = '[data-skin="precision"]';
const declaration = '  --example-color: blue;';

describe('variant selector and declaration identity', () => {
  it.each([
    `@media print {\n  :root${variant} {\n    --example-color: red;\n  }\n}`,
    `:root${variant}:hover {\n  --example-color: red;\n}`,
    `.ancestor :root${variant} {\n  --example-color: red;\n}`,
    `:root${variant}, .other {\n  --example-color: red;\n}`,
  ])('creates the requested top-level block without mutating a different selector: %s', (css) => {
    const lines = [':root {', '  --base: black;', '}', css].join('\n').split('\n');
    expect(variantBlockExists(lines, variant)).toBe(false);
    expect(findVariantBlockDeclaration(lines, variant, '--example-color')).toBeUndefined();
    insertVariantDeclaration(lines, variant, declaration);
    expect(lines.join('\n')).toContain(css);
    expect(lines.join('\n')).toContain(`:root${variant} {\n${declaration}\n}`);
    expect(findVariantBlockDeclaration(lines, variant, '--example-color')).toBeDefined();
  });

  it('never inserts a general variant inside a nested-only base root', () => {
    const css = '@media print {\n  :root {\n    --base: black;\n  }\n}';
    const lines = css.split('\n');
    insertVariantDeclaration(lines, variant, declaration);
    expect(lines.join('\n')).toBe(`${css}\n\n:root${variant} {\n${declaration}\n}`);
  });

  it('matches exact properties with optional whitespace and ignores prefixes, values and comments', () => {
    const lines = [
      `:root${variant} {`,
      '  --prefix--example-color: red;',
      '  --value: "--example-color: red";',
      '  /* --example-color: red; */',
      '  --example-color   : blue;',
      '}',
    ];
    expect(findVariantBlockDeclaration(lines, variant, '--example-color')).toEqual({ line: 5 });
  });

  it('does not treat a declaration nested in a rule as a direct variant declaration', () => {
    const lines = [
      `:root${variant} {`,
      '  @media print {',
      '    --example-color: red;',
      '  }',
      '}',
    ];
    expect(findVariantBlockDeclaration(lines, variant, '--example-color')).toBeUndefined();
  });
});
