// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { normalizePatchArtifact } from '../patch-artifact-normalize.js';

describe('normalizePatchArtifact', () => {
  it('normalizes whitespace-only hunk body payloads', () => {
    const patch = [
      'diff --git a/foo.js b/foo.js',
      'index 0..1 100644',
      '--- a/foo.js',
      '+++ b/foo.js',
      '@@ -1,4 +1,4 @@',
      ' before',
      '  ',
      '-old',
      '+ ',
      '- ',
      ' after',
      '',
    ].join('\n');

    expect(normalizePatchArtifact(patch)).toBe(
      [
        'diff --git a/foo.js b/foo.js',
        'index 0..1 100644',
        '--- a/foo.js',
        '+++ b/foo.js',
        '@@ -1,4 +1,4 @@',
        ' before',
        ' ',
        '-old',
        '+',
        '-',
        ' after',
        '',
      ].join('\n')
    );
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

  it('preserves nonblank hunk payload whitespace', () => {
    const patch = [
      'diff --git a/foo.js b/foo.js',
      '--- a/foo.js',
      '+++ b/foo.js',
      '@@ -1,2 +1,2 @@',
      ' context with trailing space ',
      '+added with trailing space ',
      '-removed with trailing space ',
      '',
    ].join('\n');

    expect(normalizePatchArtifact(patch)).toBe(patch);
  });
});
