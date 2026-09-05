// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { DEFAULT_TOKEN_CATEGORIES, generateDefaultTokensCss } from '../token-scaffold.js';

describe('generateDefaultTokensCss', () => {
  it('embeds the Mozilla Public License notice when license is MPL-2.0', () => {
    const css = generateDefaultTokensCss('mybrowser', 'MPL-2.0');
    expect(css).toContain('Mozilla Public');
  });

  it('embeds the EUPL SPDX marker when license is EUPL-1.2', () => {
    const css = generateDefaultTokensCss('mybrowser', 'EUPL-1.2');
    expect(css).toContain('SPDX-License-Identifier: EUPL-1.2');
  });

  it('seeds the canonical category set recognized by assertTokenCategoryExists', () => {
    const css = generateDefaultTokensCss('mybrowser', 'MPL-2.0');
    for (const category of DEFAULT_TOKEN_CATEGORIES) {
      // Single-line /* = Category = */ pattern, matching the single-line
      // form findCategorySection/assertTokenCategoryExists recognise.
      expect(css).toContain(`/* = ${category} = */`);
    }
  });

  it('emits a :root { } block and a prefers-color-scheme: dark overrides block', () => {
    const css = generateDefaultTokensCss('mybrowser', 'MPL-2.0');
    expect(css).toMatch(/:root\s*\{/);
    expect(css).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)/);
  });

  it('inlines the binaryName into the scaffold banner so the file self-identifies', () => {
    const css = generateDefaultTokensCss('freshforge2', 'EUPL-1.2');
    expect(css).toContain('freshforge2');
  });
});
