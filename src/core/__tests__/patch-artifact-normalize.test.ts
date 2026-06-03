// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { normalizePatchArtifact } from '../patch-artifact-normalize.js';

describe('normalizePatchArtifact', () => {
  it('preserves single-space blank context lines inside hunks', () => {
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

    expect(normalizePatchArtifact(patch)).toBe(patch);
    expect(normalizePatchArtifact(patch)).toContain('\n \n-old');
  });

  it('leaves ordinary empty lines and trailing newlines unchanged', () => {
    const patch = [
      'diff --git a/foo.js b/foo.js',
      'index 0..1 100644',
      '',
      '--- a/foo.js',
      '+++ b/foo.js',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '',
    ].join('\n');

    expect(normalizePatchArtifact(patch)).toBe(patch);
  });
});
