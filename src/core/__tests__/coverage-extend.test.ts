// SPDX-License-Identifier: EUPL-1.2
/**
 * Per-path coverage retention for scoped `fireforge test --build`. The
 * probes run against a real git engine fixture, because "this path's own
 * staging inputs are unchanged" is exactly the property a mocked git would
 * not prove.
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
import type { BuildBaseline, CoverageRecord } from '../build-baseline-types.js';
import {
  applyMozconfigAnchor,
  baselineAnchor,
  type CoverageRetentionPlan,
  describeDroppedClaim,
  formatCoverageRetentionNotice,
  formatExtendCoverageRefusal,
  FULL_CLAIM_LABEL,
  planCoverageRetention,
  recordScopedCoverage,
} from '../coverage-extend.js';

const MOZCONFIG = 'ac_add_options --enable-application=browser\n';
const A_TEST = 'browser/a/test/browser_a.js';
const A_HEAD = 'browser/a/test/head.js';
const B_TEST = 'browser/b/test/browser_b.js';
const SHARED = 'browser/shared/fixture.txt';
const PEER = 'unrelated/peer.js';

function sha256(content: string): string {
  return createHash('sha256').update(Buffer.from(content)).digest('hex');
}

describe('per-path coverage retention', () => {
  let projectRoot: string;
  let engineDir: string;
  let head: string;

  function scopedBaseline(overrides: Partial<BuildBaseline> = {}): BuildBaseline {
    return {
      engineHeadSha: head,
      builtAt: '2026-10-01T00:00:00.000Z',
      binaryName: 'mybrowser',
      testInputFingerprints: {},
      mozconfigHash: sha256(MOZCONFIG),
      testPackagingCoverage: [A_TEST],
      ...overrides,
    };
  }

  function recordFor(overrides: Partial<CoverageRecord> = {}): CoverageRecord {
    return {
      engineHeadSha: head,
      mozconfigHash: sha256(MOZCONFIG),
      fingerprints: {},
      inputs: ['browser/a/test', 'browser/shared/fixture.txt'],
      ...overrides,
    };
  }

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-coverage-retain-');
    engineDir = join(projectRoot, 'engine');
    await initCommittedRepo(engineDir, {
      '.gitignore': 'mozconfig\n',
      'browser/a/test/browser.toml':
        '[DEFAULT]\nsupport-files = ["head.js", "../../shared/fixture.txt"]\n\n["browser_a.js"]\n',
      [A_HEAD]: 'head a\n',
      [A_TEST]: 'test a\n',
      'browser/b/test/browser.toml': '["browser_b.js"]\n',
      [B_TEST]: 'test b\n',
      [SHARED]: 'shared\n',
      [PEER]: 'peer\n',
    });
    await writeFiles(engineDir, { mozconfig: MOZCONFIG });
    head = (await runGit(engineDir, ['rev-parse', 'HEAD'])).trim();
  });

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('has nothing to keep or drop without a previous baseline', async () => {
    await expect(planCoverageRetention(engineDir, undefined, [B_TEST])).resolves.toEqual({
      keepFull: false,
      retained: {},
      fullAnchor: undefined,
      narrowedBy: [],
      dropped: [],
    });
  });

  it("keeps an earlier path while a peer edits a file outside that path's inputs", async () => {
    await writeFiles(engineDir, { [PEER]: 'peer edit\n' });
    const plan = await planCoverageRetention(
      engineDir,
      scopedBaseline({ testCoverageRecords: { [A_TEST]: recordFor() } }),
      [B_TEST]
    );
    expect(plan.dropped).toEqual([]);
    expect(Object.keys(plan.retained)).toEqual([A_TEST]);
  });

  it('drops only the path whose own staging input changed, naming the input', async () => {
    await writeFiles(engineDir, { [SHARED]: 'shared edit\n' });
    const plan = await planCoverageRetention(
      engineDir,
      scopedBaseline({
        testPackagingCoverage: [A_TEST, 'browser/b/test'],
        testCoverageRecords: {
          [A_TEST]: recordFor(),
          'browser/b/test': recordFor({ inputs: ['browser/b/test'] }),
        },
      }),
      [PEER]
    );
    expect(plan.dropped).toEqual([{ path: A_TEST, changed: [SHARED] }]);
    expect(Object.keys(plan.retained)).toEqual(['browser/b/test']);
  });

  it('keeps a path whose changed input this build restages, and refreshes its anchor', async () => {
    await writeFiles(engineDir, { [A_HEAD]: 'head a edit\n' });
    const previous = scopedBaseline({ testCoverageRecords: { [A_TEST]: recordFor() } });
    const plan = await planCoverageRetention(engineDir, previous, ['browser/a/test/head.js']);
    expect(plan.dropped).toEqual([]);
    expect(plan.retained[A_TEST]?.fingerprints).toEqual({ [A_HEAD]: sha256('head a edit\n') });
    // The refreshed record proves the restaged content on the next build.
    const next = await planCoverageRetention(
      engineDir,
      scopedBaseline({ testCoverageRecords: plan.retained }),
      [B_TEST]
    );
    expect(Object.keys(next.retained)).toEqual([A_TEST]);
  });

  it("keeps a sibling's claim when a scoped build of one file restages their grown manifest", async () => {
    // The manifest gains an entry for a new test; `test --build` of that one
    // file restages the whole manifest, so the sibling stays covered.
    const A_NEW = 'browser/a/test/browser_new.js';
    await writeFiles(engineDir, {
      'browser/a/test/browser.toml':
        '[DEFAULT]\nsupport-files = ["head.js", "../../shared/fixture.txt"]\n\n["browser_a.js"]\n\n["browser_new.js"]\n',
      [A_NEW]: 'test new\n',
    });
    const plan = await planCoverageRetention(
      engineDir,
      scopedBaseline({ testCoverageRecords: { [A_TEST]: recordFor() } }),
      [A_NEW]
    );
    expect(plan.dropped).toEqual([]);
    expect(Object.keys(plan.retained)).toEqual([A_TEST]);
  });

  it('skips an earlier path this build restages wholesale', async () => {
    const plan = await planCoverageRetention(
      engineDir,
      scopedBaseline({ testCoverageRecords: { [A_TEST]: recordFor() } }),
      ['browser/a/']
    );
    expect(plan.retained).toEqual({});
    expect(plan.dropped).toEqual([]);
  });

  it('tolerates a HEAD move that touches none of the inputs, and drops on one that does', async () => {
    const previous = scopedBaseline({ testCoverageRecords: { [A_TEST]: recordFor() } });
    await writeFiles(engineDir, { [PEER]: 'committed peer\n' });
    await runGit(engineDir, ['commit', '-qam', 'peer']);
    let plan = await planCoverageRetention(engineDir, previous, [B_TEST]);
    expect(Object.keys(plan.retained)).toEqual([A_TEST]);

    await writeFiles(engineDir, { [A_HEAD]: 'committed head\n' });
    await runGit(engineDir, ['commit', '-qam', 'head']);
    plan = await planCoverageRetention(engineDir, previous, [B_TEST]);
    expect(plan.dropped).toEqual([{ path: A_TEST, changed: [A_HEAD] }]);
  });

  it('drops a record whose anchor HEAD is unknown to the engine', async () => {
    const plan = await planCoverageRetention(
      engineDir,
      scopedBaseline({
        testCoverageRecords: { [A_TEST]: recordFor({ engineHeadSha: 'f'.repeat(40) }) },
      }),
      [B_TEST]
    );
    expect(plan.dropped).toEqual([
      {
        path: A_TEST,
        changed: [],
        reason: expect.stringContaining('cannot be compared') as string,
      },
    ]);
  });

  it('anchors a pre-0.50 path without a record to the baseline-wide fingerprints', async () => {
    await writeFiles(engineDir, { [A_HEAD]: 'dirty at build\n', [PEER]: 'peer edit\n' });
    const previous = scopedBaseline({
      testInputFingerprints: { [A_HEAD]: sha256('dirty at build\n'), [PEER]: sha256('peer\n') },
    });
    const plan = await planCoverageRetention(engineDir, previous, [B_TEST]);
    // The peer edit is outside A's inputs, so it no longer voids A's claim.
    expect(plan.dropped).toEqual([]);
    expect(plan.retained[A_TEST]).toMatchObject({
      inputs: ['browser/a/test', 'browser/shared/fixture.txt'],
      fingerprints: { [A_HEAD]: sha256('dirty at build\n') },
    });
  });

  it('cannot anchor a pre-0.50 path when the baseline lacks complete fingerprints', async () => {
    const previous = scopedBaseline();
    delete previous.testInputFingerprints;
    const plan = await planCoverageRetention(engineDir, previous, [B_TEST]);
    expect(plan.dropped).toEqual([
      { path: A_TEST, changed: [], reason: expect.stringContaining('fingerprints') as string },
    ]);
  });

  it('keeps a full claim full when nothing outside the scope moved', async () => {
    const plan = await planCoverageRetention(
      engineDir,
      scopedBaseline({ testPackagingCoverage: 'full' }),
      [B_TEST]
    );
    expect(plan.keepFull).toBe(true);
    expect(plan.narrowedBy).toEqual([]);
  });

  it('narrows a full claim to per-path checks instead of dropping it', async () => {
    await writeFiles(engineDir, { [PEER]: 'peer edit\n' });
    const plan = await planCoverageRetention(
      engineDir,
      scopedBaseline({ testPackagingCoverage: 'full' }),
      [B_TEST]
    );
    expect(plan.keepFull).toBe(false);
    expect(plan.narrowedBy).toEqual([PEER]);
    expect(plan.fullAnchor).toMatchObject({ engineHeadSha: head });
    expect(plan.dropped).toEqual([]);
    expect(formatCoverageRetentionNotice(plan)).toContain(
      `Full packaging coverage is now checked per path: ${PEER} changed outside`
    );
  });

  it('drops a legacy implicit full claim without fingerprints', async () => {
    const previous = scopedBaseline();
    delete previous.testPackagingCoverage;
    delete previous.testInputFingerprints;
    const plan = await planCoverageRetention(engineDir, previous, [B_TEST]);
    expect(plan.dropped).toEqual([
      { path: FULL_CLAIM_LABEL, changed: [], reason: expect.any(String) as string },
    ]);
  });

  it('carries and refreshes a full anchor already carried by a scoped claim', async () => {
    await writeFiles(engineDir, { [B_TEST]: 'test b edit\n' });
    const fullAnchor = { engineHeadSha: head, mozconfigHash: sha256(MOZCONFIG), fingerprints: {} };
    const plan = await planCoverageRetention(
      engineDir,
      scopedBaseline({ testPackagingCoverage: [], fullCoverageAnchor: fullAnchor }),
      [B_TEST]
    );
    expect(plan.fullAnchor?.fingerprints).toEqual({ [B_TEST]: sha256('test b edit\n') });
  });

  it('drops a carried full anchor whose HEAD the engine no longer knows', async () => {
    const plan = await planCoverageRetention(
      engineDir,
      scopedBaseline({
        testPackagingCoverage: [],
        fullCoverageAnchor: {
          engineHeadSha: 'f'.repeat(40),
          mozconfigHash: sha256(MOZCONFIG),
          fingerprints: {},
        },
      }),
      [B_TEST]
    );
    expect(plan.fullAnchor).toBeUndefined();
    expect(plan.dropped.map((claim) => claim.path)).toEqual([FULL_CLAIM_LABEL]);
  });

  it('drops a full claim it cannot compare', async () => {
    const plan = await planCoverageRetention(
      engineDir,
      scopedBaseline({ testPackagingCoverage: 'full', engineHeadSha: 'f'.repeat(40) }),
      [B_TEST]
    );
    expect(plan.dropped.map((claim) => claim.path)).toEqual([FULL_CLAIM_LABEL]);
  });

  it('drops every claim when the engine state cannot be read', async () => {
    const notGit = join(projectRoot, 'not-a-repo');
    await writeFiles(notGit, { 'x.txt': 'x' });
    const plan = await planCoverageRetention(
      notGit,
      scopedBaseline({ testPackagingCoverage: [A_TEST, B_TEST] }),
      [PEER]
    );
    expect(plan.dropped.map((claim) => claim.path)).toEqual([A_TEST, B_TEST]);
    const full = await planCoverageRetention(
      notGit,
      scopedBaseline({ testPackagingCoverage: 'full' }),
      [PEER]
    );
    expect(full.dropped.map((claim) => claim.path)).toEqual([FULL_CLAIM_LABEL]);
  });

  describe('applyMozconfigAnchor', () => {
    function plan(overrides: Partial<CoverageRetentionPlan> = {}): CoverageRetentionPlan {
      return {
        keepFull: false,
        retained: { [A_TEST]: recordFor() },
        fullAnchor: undefined,
        narrowedBy: [],
        dropped: [],
        ...overrides,
      };
    }

    it('keeps records staged under the live mozconfig', async () => {
      await expect(applyMozconfigAnchor(engineDir, plan())).resolves.toMatchObject({
        retained: { [A_TEST]: recordFor() },
        dropped: [],
      });
    });

    it('drops records and the full anchor once the mozconfig was regenerated differently', async () => {
      await writeFiles(engineDir, { mozconfig: 'ac_add_options --enable-debug\n' });
      const fullAnchor = {
        engineHeadSha: head,
        mozconfigHash: sha256(MOZCONFIG),
        fingerprints: {},
      };
      const next = await applyMozconfigAnchor(
        engineDir,
        plan({ keepFull: true, fullAnchor, narrowedBy: [PEER] })
      );
      expect(next.retained).toEqual({});
      expect(next.keepFull).toBe(false);
      expect(next.fullAnchor).toBeUndefined();
      expect(next.dropped.map((claim) => claim.path)).toEqual([A_TEST, FULL_CLAIM_LABEL]);
    });
  });

  describe('recordScopedCoverage', () => {
    it('records a kept full claim as full', async () => {
      await expect(
        recordScopedCoverage(
          engineDir,
          { keepFull: true, retained: {}, fullAnchor: undefined, narrowedBy: [], dropped: [] },
          [B_TEST]
        )
      ).resolves.toEqual({ testPackagingCoverage: 'full' });
    });

    it("records this build's paths with their own inputs, plus kept paths and the full anchor", async () => {
      await writeFiles(engineDir, { [B_TEST]: 'test b edit\n', [PEER]: 'peer edit\n' });
      const fullAnchor = {
        engineHeadSha: head,
        mozconfigHash: sha256(MOZCONFIG),
        fingerprints: {},
      };
      const recorded = await recordScopedCoverage(
        engineDir,
        {
          keepFull: false,
          retained: { [A_TEST]: recordFor() },
          fullAnchor,
          narrowedBy: [],
          dropped: [],
        },
        [B_TEST]
      );
      expect(recorded.testPackagingCoverage).toEqual([A_TEST, B_TEST]);
      expect(recorded.fullCoverageAnchor).toBe(fullAnchor);
      expect(recorded.testCoverageRecords?.[B_TEST]).toEqual({
        engineHeadSha: head,
        mozconfigHash: sha256(MOZCONFIG),
        inputs: ['browser/b/test'],
        fingerprints: { [B_TEST]: sha256('test b edit\n') },
      });
    });

    it('keeps request order and omits empty records when nothing can be anchored', async () => {
      const notGit = join(projectRoot, 'not-a-repo');
      await writeFiles(notGit, { 'x.txt': 'x' });
      await expect(
        recordScopedCoverage(
          notGit,
          { keepFull: false, retained: {}, fullAnchor: undefined, narrowedBy: [], dropped: [] },
          [B_TEST, A_TEST]
        )
      ).resolves.toEqual({ testPackagingCoverage: [B_TEST, A_TEST] });
    });
  });
});

describe('baselineAnchor', () => {
  it('needs both complete fingerprints and the mozconfig hash', () => {
    const baseline: BuildBaseline = {
      engineHeadSha: 'abc',
      builtAt: '2026-10-01T00:00:00.000Z',
      binaryName: 'mybrowser',
      testInputFingerprints: {},
    };
    expect(baselineAnchor(baseline)).toBeUndefined();
    expect(baselineAnchor({ ...baseline, mozconfigHash: 'a'.repeat(64) })).toEqual({
      engineHeadSha: 'abc',
      mozconfigHash: 'a'.repeat(64),
      fingerprints: {},
    });
  });
});

describe('coverage retention copy', () => {
  it('describes a dropped claim by its changed inputs, truncating long lists', () => {
    const changed = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    expect(describeDroppedClaim({ path: 'p', changed })).toBe(
      'p (staging inputs changed: a, b, c, d, e, … (+2 more))'
    );
    expect(describeDroppedClaim({ path: 'p', changed: [], reason: 'why' })).toBe('p (why)');
    expect(describeDroppedClaim({ path: 'p', changed: [] })).toContain('cannot be compared');
  });

  it('says nothing when a plan dropped and narrowed nothing', () => {
    expect(
      formatCoverageRetentionNotice({
        keepFull: true,
        retained: {},
        fullAnchor: undefined,
        narrowedBy: [],
        dropped: [],
      })
    ).toBeUndefined();
  });

  it('names dropped and kept paths in the notice', () => {
    const notice = formatCoverageRetentionNotice({
      keepFull: false,
      retained: { kept: { engineHeadSha: '', mozconfigHash: '', fingerprints: {}, inputs: [] } },
      fullAnchor: undefined,
      narrowedBy: [],
      dropped: [{ path: 'gone', changed: ['gone/head.js'] }],
    });
    expect(notice).toBe(
      'Scoped build drops previous packaging coverage for gone (staging inputs changed: gone/head.js). Kept: kept. Rebuild a dropped path (alone or with this one) before running it without --build.'
    );
  });

  it('refuses --extend-coverage with every dropped claim and the remedy', () => {
    const message = formatExtendCoverageRefusal([
      { path: 'a', changed: ['a/head.js'] },
      { path: FULL_CLAIM_LABEL, changed: [], reason: 'mozconfig' },
    ]);
    expect(message).toContain('--extend-coverage refused');
    expect(message).toContain(
      '2 claim(s): a (staging inputs changed: a/head.js); full coverage (mozconfig)'
    );
    expect(message).toContain('drop the flag');
  });
});
