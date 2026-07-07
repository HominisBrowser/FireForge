// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { normalizePatchArtifact } from '../patch-artifact-normalize.js';

describe('normalizePatchArtifact', () => {
  it('preserves blank context markers (single space) byte-for-byte', () => {
    // git renders an empty context line as a single space; re-export
    // round-trips pin this exact form.
    const patch = [
      'diff --git a/foo.js b/foo.js',
      'index 0..1 100644',
      '--- a/foo.js',
      '+++ b/foo.js',
      '@@ -1,3 +1,3 @@',
      ' before',
      ' ',
      ' after',
      '',
    ].join('\n');

    expect(normalizePatchArtifact(patch)).toBe(patch);
  });

  it('preserves whitespace-only payloads byte-for-byte', () => {
    // Finding M2 (2026-07-05 review): Firefox sources contain
    // whitespace-only lines. The historical normalizer truncated
    // `- `/`+ `/`  ` to the bare marker, which broke `git apply --check`
    // on the freshly exported patch (context/removal no longer matched
    // the tree) or silently changed the content a `+` line produces.
    const patch = [
      'diff --git a/foo.js b/foo.js',
      '--- a/foo.js',
      '+++ b/foo.js',
      '@@ -1,4 +1,4 @@',
      ' before',
      '  ', // context line whose payload is one real space
      '- ', // removal of a one-space line
      '+ ', // addition of a one-space line
      '',
    ].join('\n');

    expect(normalizePatchArtifact(patch)).toBe(patch);
  });

  it('preserves nonblank hunk payload whitespace and trailing newlines', () => {
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
