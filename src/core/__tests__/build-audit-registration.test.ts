// SPDX-License-Identifier: EUPL-1.2
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureDir, writeText } from '../../utils/fs.js';
import {
  collectSameBasenameCandidates,
  findJarMnEntryForSource,
  findRegisteredTarget,
  parseJarMnEntry,
  resolveArtifactByRegistration,
} from '../build-audit-registration.js';

describe('parseJarMnEntry', () => {
  it('parses a bare entry with a (source) reference', () => {
    expect(parseJarMnEntry('        content/browser/foo.js  (content/foo.js)')).toEqual({
      target: 'content/browser/foo.js',
      source: 'content/foo.js',
    });
  });

  it('parses an asterisk-prefixed (preprocessed) entry', () => {
    expect(parseJarMnEntry('*       content/browser/foo.js  (content/foo.js)')).toEqual({
      target: 'content/browser/foo.js',
      source: 'content/foo.js',
    });
  });

  it('parses a locale-prefixed entry', () => {
    expect(parseJarMnEntry('en-US.jar:        content/foo.ftl  (en-US/content/foo.ftl)')).toEqual({
      target: 'content/foo.ftl',
      source: 'en-US/content/foo.ftl',
    });
  });

  it.each([
    '',
    '# comment',
    '% content browser %content/browser/',
    'browser.jar:',
    '        content/foo.js', // no (source)
  ])('returns undefined for non-entry line %p', (line) => {
    expect(parseJarMnEntry(line)).toBeUndefined();
  });
});

describe('findJarMnEntryForSource', () => {
  it('returns the matching entry when the source appears', () => {
    const jar = `browser.jar:
%  content browser  %content/browser/
        content/browser/foo.js  (content/foo.js)
        content/browser/bar.js  (content/bar.js)
`;
    expect(findJarMnEntryForSource(jar, 'content/foo.js')).toEqual({
      target: 'content/browser/foo.js',
      source: 'content/foo.js',
    });
  });

  it('returns undefined when no entry references the source', () => {
    const jar = `browser.jar:
        content/browser/bar.js  (content/bar.js)
`;
    expect(findJarMnEntryForSource(jar, 'content/foo.js')).toBeUndefined();
  });

  it('normalises Windows separators in the caller-supplied source', () => {
    const jar = `browser.jar:
        content/browser/foo.js  (content/foo.js)
`;
    expect(findJarMnEntryForSource(jar, 'content\\foo.js')).toEqual({
      target: 'content/browser/foo.js',
      source: 'content/foo.js',
    });
  });
});

describe('findRegisteredTarget', () => {
  let engineDir: string;

  beforeEach(async () => {
    engineDir = await mkdtemp(join(tmpdir(), 'ff-regn-'));
  });
  afterEach(async () => {
    await rm(engineDir, { recursive: true, force: true });
  });

  it('walks ancestor directories to find an owning jar.mn', async () => {
    await ensureDir(join(engineDir, 'browser/base/content'));
    await writeText(
      join(engineDir, 'browser/base/jar.mn'),
      `browser.jar:
%  content browser  %content/browser/
        content/browser/mybrowser.js  (content/mybrowser.js)
`
    );
    await writeText(join(engineDir, 'browser/base/content/mybrowser.js'), '');

    const hit = await findRegisteredTarget(engineDir, 'browser/base/content/mybrowser.js');
    expect(hit).toBeDefined();
    expect(hit?.target).toBe('content/browser/mybrowser.js');
    expect(hit?.source).toBe('content/mybrowser.js');
    expect(hit?.jarManifest).toContain(join('browser', 'base', 'jar.mn'));
  });

  it('returns undefined when no ancestor jar.mn claims the source', async () => {
    await ensureDir(join(engineDir, 'browser/defaults/preferences'));
    await writeText(join(engineDir, 'browser/defaults/preferences/mybrowser.js'), '');
    // No jar.mn anywhere.

    const hit = await findRegisteredTarget(engineDir, 'browser/defaults/preferences/mybrowser.js');
    expect(hit).toBeUndefined();
  });

  it('ignores a jar.mn ancestor that does not reference the source', async () => {
    await ensureDir(join(engineDir, 'browser/base/content'));
    await writeText(
      join(engineDir, 'browser/base/jar.mn'),
      `browser.jar:
        content/browser/other.js  (content/other.js)
`
    );
    await writeText(join(engineDir, 'browser/base/content/mybrowser.js'), '');

    const hit = await findRegisteredTarget(engineDir, 'browser/base/content/mybrowser.js');
    expect(hit).toBeUndefined();
  });
});

describe('resolveArtifactByRegistration', () => {
  let engineDir: string;
  let distRoot: string;

  beforeEach(async () => {
    engineDir = await mkdtemp(join(tmpdir(), 'ff-regn-art-'));
    distRoot = join(engineDir, 'obj-debug', 'dist');
  });
  afterEach(async () => {
    await rm(engineDir, { recursive: true, force: true });
  });

  it('prefers the registration target over an unrelated same-basename file', async () => {
    // Source lives under browser/base/content/ and jar.mn maps it to
    // content/browser/mybrowser.js; dist contains that artifact AND an
    // unrelated pref file of the same basename. The basename heuristic
    // cannot distinguish them; registration must.
    await ensureDir(join(engineDir, 'browser/base/content'));
    await writeText(
      join(engineDir, 'browser/base/jar.mn'),
      `browser.jar:
        content/browser/mybrowser.js  (content/mybrowser.js)
`
    );
    await writeText(join(engineDir, 'browser/base/content/mybrowser.js'), '');

    await ensureDir(join(distRoot, 'bin/browser/chrome/browser/content/browser'));
    await ensureDir(join(distRoot, 'bin/browser/defaults/preferences'));
    const correct = join(distRoot, 'bin/browser/chrome/browser/content/browser/mybrowser.js');
    const unrelated = join(distRoot, 'bin/browser/defaults/preferences/mybrowser.js');
    await writeText(correct, '');
    await writeText(unrelated, '');

    const result = await resolveArtifactByRegistration(
      engineDir,
      'browser/base/content/mybrowser.js',
      [distRoot]
    );
    expect(result?.artifact).toBe(correct);
    expect(result?.hit.target).toBe('content/browser/mybrowser.js');
  });

  it('returns undefined when the registration target is absent from dist', async () => {
    // Registration exists, but packaging dropped the file: no dist candidate
    // ends with the target suffix. Callers surface this distinctly from an
    // unregistered miss.
    await ensureDir(join(engineDir, 'browser/base/content'));
    await writeText(
      join(engineDir, 'browser/base/jar.mn'),
      `browser.jar:
        content/browser/mybrowser.js  (content/mybrowser.js)
`
    );
    await writeText(join(engineDir, 'browser/base/content/mybrowser.js'), '');

    // Only the unrelated pref file lives in dist — not the content/browser/ path.
    await ensureDir(join(distRoot, 'bin/browser/defaults/preferences'));
    await writeText(join(distRoot, 'bin/browser/defaults/preferences/mybrowser.js'), '');

    const result = await resolveArtifactByRegistration(
      engineDir,
      'browser/base/content/mybrowser.js',
      [distRoot]
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when no registration exists for the source', async () => {
    await ensureDir(join(engineDir, 'browser/defaults/preferences'));
    await writeText(join(engineDir, 'browser/defaults/preferences/mybrowser.js'), '');
    await ensureDir(distRoot);

    const result = await resolveArtifactByRegistration(
      engineDir,
      'browser/defaults/preferences/mybrowser.js',
      [distRoot]
    );
    expect(result).toBeUndefined();
  });
});

describe('collectSameBasenameCandidates', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ff-regn-cands-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns every same-basename hit across all search roots', async () => {
    const a = join(root, 'a');
    const b = join(root, 'b');
    await ensureDir(a);
    await ensureDir(b);
    await writeText(join(a, 'mybrowser.js'), '');
    await writeText(join(b, 'mybrowser.js'), '');

    const hits = await collectSameBasenameCandidates('browser/base/content/mybrowser.js', [a, b]);
    expect(hits).toHaveLength(2);
    expect(hits.every((h) => h.endsWith('mybrowser.js'))).toBe(true);
  });

  it('returns an empty list when no candidate exists', async () => {
    const hits = await collectSameBasenameCandidates('x/y/z.js', [root]);
    expect(hits).toEqual([]);
  });
});
