// SPDX-License-Identifier: EUPL-1.2
/**
 * Unit tests for the `--extend-coverage` anchor and union. The union is
 * pure. The anchor probes run against a real git engine fixture, because
 * "engine HEAD unchanged" and "previously fingerprinted files
 * byte-identical" are exactly the properties a mocked git would not prove.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createTempProject,
  initCommittedRepo,
  removeTempProject,
  runGit,
  writeFiles,
} from '../../test-utils/index.js';
import type { BuildBaseline } from '../build-baseline-types.js';
import {
  checkExtendCoverageAnchor,
  checkExtendMozconfigAnchor,
  formatExtendCoverageRefusal,
  unionTestPackagingCoverage,
} from '../coverage-extend.js';

const DIRTY_FILE = 'browser/app/profile/firefox.js';
const MOZCONFIG = 'mozconfig';

function sha256(content: string): string {
  return createHash('sha256').update(Buffer.from(content)).digest('hex');
}

describe('unionTestPackagingCoverage', () => {
  it('unions two scoped lists, de-duped and sorted', () => {
    expect(unionTestPackagingCoverage(['b/x.js', 'a/y.js'], ['a/y.js', 'c/z.js'])).toEqual([
      'a/y.js',
      'b/x.js',
      'c/z.js',
    ]);
  });

  it('keeps a full claim full — it already covers everything', () => {
    expect(unionTestPackagingCoverage('full', ['a/y.js'])).toBe('full');
  });

  it('treats an absent claim as the historical full coverage', () => {
    expect(unionTestPackagingCoverage(undefined, ['a/y.js'])).toBe('full');
  });

  it('returns the requested paths when the previous list was empty', () => {
    expect(unionTestPackagingCoverage([], ['a/y.js'])).toEqual(['a/y.js']);
  });
});

describe('extend-coverage anchor probes', () => {
  let projectRoot: string;
  let engineDir: string;
  let head: string;

  function baselineFor(overrides: Partial<BuildBaseline> = {}): BuildBaseline {
    return {
      engineHeadSha: head,
      builtAt: '2026-08-11T00:00:00.000Z',
      binaryName: 'mybrowser',
      testInputFingerprints: { [DIRTY_FILE]: sha256('pref("x", true);\n') },
      mozconfigHash: sha256('ac_add_options --enable-application=browser\n'),
      testPackagingCoverage: ['browser/base/content/test/a'],
      ...overrides,
    };
  }

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-extend-anchor-');
    engineDir = join(projectRoot, 'engine');
    await initCommittedRepo(engineDir, { 'README.md': 'engine\n' });
    head = (await runGit(engineDir, ['rev-parse', 'HEAD'])).trim();
    await writeFiles(engineDir, {
      [DIRTY_FILE]: 'pref("x", true);\n',
      [MOZCONFIG]: 'ac_add_options --enable-application=browser\n',
    });
  });

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('accepts an unchanged anchor', async () => {
    await expect(checkExtendCoverageAnchor(engineDir, baselineFor())).resolves.toEqual({
      ok: true,
    });
  });

  it('rejects a legacy packageable-only fingerprint record', async () => {
    const previous = baselineFor();
    previous.packageableFingerprints = previous.testInputFingerprints ?? {};
    delete previous.testInputFingerprints;
    await expect(checkExtendCoverageAnchor(engineDir, previous)).resolves.toMatchObject({
      ok: false,
      reason: 'no-fingerprints',
    });
  });

  it('ignores changed inputs explicitly rebuilt but refuses unchanged-scope fixture drift', async () => {
    const a = 'browser/base/content/test/a/fixture.txt';
    const b = 'browser/base/content/test/b/test_b.js';
    await writeFiles(engineDir, { [a]: 'a', [b]: 'b' });
    const previous = baselineFor({
      testInputFingerprints: {
        [DIRTY_FILE]: sha256('pref("x", true);\n'),
        [a]: sha256('a'),
        [b]: sha256('b'),
      },
    });
    await writeFiles(engineDir, { [b]: 'changed b' });
    await expect(checkExtendCoverageAnchor(engineDir, previous, [b])).resolves.toEqual({
      ok: true,
    });
    await writeFiles(engineDir, { [a]: 'changed a' });
    await expect(checkExtendCoverageAnchor(engineDir, previous, [b])).resolves.toMatchObject({
      ok: false,
      reason: 'fingerprint-diverged',
      detail: [a],
    });
  });

  it('refuses a newly dirty test fixture outside the rebuilt scope', async () => {
    const fixture = 'browser/base/content/test/a/new.txt';
    await writeFiles(engineDir, { [fixture]: 'new fixture' });
    await expect(
      checkExtendCoverageAnchor(engineDir, baselineFor(), ['browser/base/content/test/b'])
    ).resolves.toMatchObject({ ok: false, detail: [fixture] });
  });

  it('refuses when there is no previous baseline', async () => {
    const result = await checkExtendCoverageAnchor(engineDir, undefined);
    expect(result).toEqual({ ok: false, reason: 'no-baseline', detail: [] });
  });

  it('refuses a baseline recorded before the mozconfig anchor existed', async () => {
    const previous = baselineFor();
    delete previous.mozconfigHash;
    const result = await checkExtendCoverageAnchor(engineDir, previous);
    expect(result).toMatchObject({ ok: false, reason: 'no-mozconfig-hash' });
  });

  it('refuses a baseline whose fingerprint probe had failed', async () => {
    const previous = baselineFor();
    delete previous.testInputFingerprints;
    const result = await checkExtendCoverageAnchor(engineDir, previous);
    expect(result).toMatchObject({ ok: false, reason: 'no-fingerprints' });
  });

  it('refuses when engine HEAD advanced since the recorded build', async () => {
    const previous = baselineFor({
      engineHeadSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    });
    const result = await checkExtendCoverageAnchor(engineDir, previous);
    expect(result).toMatchObject({ ok: false, reason: 'head-moved' });
  });

  it('refuses a baseline recorded against an unborn HEAD (nothing to anchor to)', async () => {
    const result = await checkExtendCoverageAnchor(engineDir, baselineFor({ engineHeadSha: '' }));
    expect(result).toEqual({ ok: false, reason: 'head-moved', detail: [] });
  });

  it('propagates a git failure that is not a missing HEAD rather than passing the anchor', async () => {
    // A non-repository engine path is a hard probe failure, not an unborn
    // branch: silently treating it as "no prior state" would let extend
    // proceed on an anchor that was never actually checked.
    await expect(
      checkExtendCoverageAnchor(join(projectRoot, 'not-a-repo'), baselineFor())
    ).rejects.toThrow();
  });

  it('refuses the mozconfig anchor outright when the baseline predates the field', async () => {
    const previous = baselineFor();
    delete previous.mozconfigHash;
    await expect(checkExtendMozconfigAnchor(engineDir, previous)).resolves.toMatchObject({
      ok: false,
      reason: 'no-mozconfig-hash',
    });
  });

  it('refuses when a previously fingerprinted file was edited since the build', async () => {
    await writeFiles(engineDir, { [DIRTY_FILE]: 'pref("x", false);\n' });
    const result = await checkExtendCoverageAnchor(engineDir, baselineFor());
    expect(result).toMatchObject({
      ok: false,
      reason: 'fingerprint-diverged',
      detail: [DIRTY_FILE],
    });
  });

  it('refuses when a previously fingerprinted file disappeared', async () => {
    const previous = baselineFor({
      testInputFingerprints: { 'browser/app/profile/gone.js': sha256('x\n') },
    });
    const result = await checkExtendCoverageAnchor(engineDir, previous);
    expect(result).toMatchObject({ ok: false, reason: 'fingerprint-diverged' });
  });

  it('refuses newly dirty inputs outside the rebuilt scope conservatively', async () => {
    await writeFiles(engineDir, { 'browser/app/profile/new.js': 'pref("new", 1);\n' });
    await expect(checkExtendCoverageAnchor(engineDir, baselineFor())).resolves.toMatchObject({
      ok: false,
      detail: ['browser/app/profile/new.js'],
    });
  });

  it('rejects a previously clean shared fixture outside test-named directories', async () => {
    const fixture = 'browser/shared/fixture.txt';
    await writeFiles(engineDir, { [fixture]: 'changed shared fixture' });
    await expect(
      checkExtendCoverageAnchor(engineDir, baselineFor(), ['browser/base/content/test/b/test_b.js'])
    ).resolves.toMatchObject({ ok: false, detail: [fixture] });
  });

  it('accepts an unchanged mozconfig and refuses a regenerated one', async () => {
    const previous = baselineFor();
    await expect(checkExtendMozconfigAnchor(engineDir, previous)).resolves.toEqual({ ok: true });

    await writeFiles(engineDir, { [MOZCONFIG]: 'ac_add_options --enable-debug\n' });
    await expect(checkExtendMozconfigAnchor(engineDir, previous)).resolves.toMatchObject({
      ok: false,
      reason: 'mozconfig-changed',
    });
  });

  it('refuses the mozconfig anchor when the file cannot be read at all', async () => {
    const bare = await createTempProject('ff-extend-nomoz-');
    try {
      const result = await checkExtendMozconfigAnchor(join(bare, 'engine'), baselineFor());
      expect(result).toMatchObject({ ok: false, reason: 'mozconfig-changed' });
    } finally {
      await removeTempProject(bare);
    }
  });
});

describe('formatExtendCoverageRefusal', () => {
  it('names the remedy on every reason', () => {
    const reasons = [
      'no-baseline',
      'no-fingerprints',
      'no-mozconfig-hash',
      'head-moved',
      'fingerprint-diverged',
      'mozconfig-changed',
    ] as const;
    for (const reason of reasons) {
      expect(formatExtendCoverageRefusal({ reason, detail: [] })).toContain(
        'Re-run without --extend-coverage'
      );
    }
  });

  it('explains the staleness the fingerprint check protects against', () => {
    const message = formatExtendCoverageRefusal({
      reason: 'fingerprint-diverged',
      detail: ['a.js', 'b.js'],
    });
    expect(message).toContain('2 staging input(s)');
    expect(message).toContain('a.js, b.js');
    expect(message).toContain('stale staging');
  });

  it('truncates a long diverged list', () => {
    const detail = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    expect(formatExtendCoverageRefusal({ reason: 'fingerprint-diverged', detail })).toContain(
      '(+2 more)'
    );
  });

  it('says why engine HEAD does not cover the mozconfig', () => {
    expect(formatExtendCoverageRefusal({ reason: 'mozconfig-changed', detail: [] })).toContain(
      'regenerated from configs/*.mozconfig'
    );
  });
});
