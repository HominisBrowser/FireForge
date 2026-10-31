// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { isAnyTypedMemberReference } from '../patch-lint-checkjs-any-import.js';

describe('isAnyTypedMemberReference', () => {
  it('matches a member of the resource:* and chrome:* wildcards', () => {
    expect(
      isAnyTypedMemberReference(
        2694,
        `Namespace '"resource:*"' has no exported member 'LaterType'.`,
        undefined
      )
    ).toBe(true);
    expect(
      isAnyTypedMemberReference(
        2694,
        `Namespace '"chrome:*"' has no exported member 'default'.`,
        undefined
      )
    ).toBe(true);
  });

  it("matches a consumer's shorthand module only when the file's import of it went unresolved", () => {
    const message = `Namespace '"resource:///modules/X.sys.mjs"' has no exported member 'Y'.`;
    expect(
      isAnyTypedMemberReference(2694, message, new Set(['resource:///modules/X.sys.mjs']))
    ).toBe(true);
    expect(isAnyTypedMemberReference(2694, message, new Set())).toBe(false);
  });

  it('keeps a missing member of a resolved module and other codes', () => {
    expect(
      isAnyTypedMemberReference(
        2694,
        `Namespace '"/engine/browser/modules/Owned.sys"' has no exported member 'Missing'.`,
        new Set(['resource:///modules/Other.sys.mjs'])
      )
    ).toBe(false);
    expect(
      isAnyTypedMemberReference(
        2339,
        `Namespace '"resource:*"' has no exported member 'LaterType'.`,
        undefined
      )
    ).toBe(false);
  });
});
