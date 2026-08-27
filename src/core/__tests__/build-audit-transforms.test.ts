// SPDX-License-Identifier: EUPL-1.2
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureDir, writeText } from '../../utils/fs.js';
import {
  expectedChromeSuffix,
  resolveArtifactByKnownTransform,
} from '../build-audit-transforms.js';

describe('expectedChromeSuffix', () => {
  it.each([
    ['browser/base/content/mybrowser.js', 'chrome/browser/content/browser/mybrowser.js'],
    [
      'browser/base/content/deep/nested/foo.css',
      'chrome/browser/content/browser/deep/nested/foo.css',
    ],
    [
      'toolkit/content/widgets/moz-preview/moz-preview.mjs',
      'chrome/toolkit/content/global/elements/moz-preview/moz-preview.mjs',
    ],
    ['toolkit/content/about.js', 'chrome/toolkit/content/global/about.js'],
  ])('returns %s for %s', (source, expected) => {
    expect(expectedChromeSuffix(source)).toBe(expected);
  });

  it.each([
    // Sources outside the known transform prefixes do not get rewritten;
    // the scorer falls back to similarity ranking for these.
    ['browser/components/preferences/foo.js'],
    ['browser/app/profile/prefs.js'],
    ['browser/defaults/preferences/mybrowser.js'],
    ['unknown/tree/foo.js'],
  ])('returns undefined for out-of-scope source %s', (source) => {
    expect(expectedChromeSuffix(source)).toBeUndefined();
  });

  it('prefers the more-specific toolkit/content/widgets rule over toolkit/content', () => {
    // The rule order matters — if toolkit/content/ won the first-match race,
    // the widget would end up at chrome/toolkit/content/global/widgets/... rather
    // than the correct /elements/... path.
    expect(expectedChromeSuffix('toolkit/content/widgets/moz-preview.mjs')).toBe(
      'chrome/toolkit/content/global/elements/moz-preview.mjs'
    );
  });
});

describe('resolveArtifactByKnownTransform', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ff-audit-transforms-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('picks the expected chrome artifact even when an unrelated same-basename file exists', async () => {
    // A source at `engine/browser/base/content/mybrowser.js` packages at
    // `chrome/browser/content/browser/mybrowser.js`, but an unrelated
    // `browser/defaults/preferences/mybrowser.js` (a pref file from a
    // separate patch) sits at `bin/browser/defaults/preferences/mybrowser.js`
    // in dist. Without the known-transform lookup the scorer ties both
    // candidates and the structural-relation check rejects both, because
    // every source segment is in the "generic" list.
    const correct = join(root, 'chrome/browser/content/browser/mybrowser.js');
    const wrong = join(root, 'bin/browser/defaults/preferences/mybrowser.js');
    await ensureDir(join(root, 'chrome/browser/content/browser'));
    await ensureDir(join(root, 'bin/browser/defaults/preferences'));
    await writeText(correct, '// content');
    await writeText(wrong, '// pref');

    const resolved = await resolveArtifactByKnownTransform('browser/base/content/mybrowser.js', [
      root,
    ]);
    expect(resolved).toBe(correct);
  });

  it('returns undefined when the chrome artifact is absent even if an unrelated basename match exists', async () => {
    // No file exists at the chrome suffix, so the transform does NOT match
    // the unrelated pref file. The caller falls back to the similarity
    // heuristic which will still report the real packaging drop as missing.
    const wrong = join(root, 'bin/browser/defaults/preferences/mybrowser.js');
    await ensureDir(join(root, 'bin/browser/defaults/preferences'));
    await writeText(wrong, '// pref');

    const resolved = await resolveArtifactByKnownTransform('browser/base/content/mybrowser.js', [
      root,
    ]);
    expect(resolved).toBeUndefined();
  });

  it('returns undefined for sources outside the known transforms', async () => {
    // Out-of-scope sources must not trigger any probe — the heuristic
    // fallback continues to own these cases.
    await ensureDir(join(root, 'chrome/browser/content/browser'));
    await writeText(join(root, 'chrome/browser/content/browser/foo.js'), 'x');

    const resolved = await resolveArtifactByKnownTransform(
      'browser/components/preferences/foo.js',
      [root]
    );
    expect(resolved).toBeUndefined();
  });

  it('searches multiple roots in order', async () => {
    const first = join(root, 'first');
    const second = join(root, 'second');
    await ensureDir(first);
    await ensureDir(join(second, 'chrome/browser/content/browser'));
    const correct = join(second, 'chrome/browser/content/browser/mybrowser.js');
    await writeText(correct, '// content');

    const resolved = await resolveArtifactByKnownTransform('browser/base/content/mybrowser.js', [
      first,
      second,
    ]);
    expect(resolved).toBe(correct);
  });
});
