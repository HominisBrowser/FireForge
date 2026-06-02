// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { normalizePatchArtifact } from '../patch-artifact-normalize.js';

describe('normalizePatchArtifact', () => {
  it('removes single-space blank context lines while preserving real context', () => {
    const patch = [
      'diff --git a/foo.js b/foo.js',
      'index 0..1 100644',
      '--- a/foo.js',
      '+++ b/foo.js',
      '@@ -1,3 +1,3 @@',
      ' before',
      ' ',
      '-old',
      '+new',
      ' after',
      '',
    ].join('\n');

    expect(normalizePatchArtifact(patch)).toBe(
      [
        'diff --git a/foo.js b/foo.js',
        'index 0..1 100644',
        '--- a/foo.js',
        '+++ b/foo.js',
        '@@ -1,3 +1,3 @@',
        ' before',
        '',
        '-old',
        '+new',
        ' after',
        '',
      ].join('\n')
    );
  });
});
