// SPDX-License-Identifier: EUPL-1.2
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { printStatus } from '../../../commands/prove-report.js';
import { announceRange, attributionOf, sampleRequest } from '../../../commands/prove-support.js';
import { setStdoutSealed } from '../../../utils/logger.js';
import type { AuthoredSnapshot } from '../../authored/types.js';
import { stepMarker } from '../../jobs/job-view.js';
import type { JobRecord, JobStep } from '../../jobs/schema.js';
import type { TestFileResult } from '../../test-results-document.js';
import {
  attributeReds,
  attributionLines,
  failedTests,
  type ProofRange,
  proofRange,
  rangeWarning,
  reportedFiles,
} from '../attribution.js';
import type { ObligationStatus, ProofStatus } from '../evidence.js';
import { stepFingerprint, testStep } from '../plan-steps.js';
import type { Obligation, ProofPlan } from '../types.js';

let directory: string;
let repo: string;
let namespace: string;

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

/** A commit by someone, of these files under the source root. */
async function commit(
  author: string,
  subject: string,
  files: Record<string, string>
): Promise<string> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(repo, 'src', path)), { recursive: true });
    await writeFile(join(repo, 'src', path), text);
  }
  git('add', '-A');
  git(
    '-c',
    `user.name=${author}`,
    '-c',
    'user.email=a@example.invalid',
    'commit',
    '-q',
    '-m',
    subject
  );
  return git('rev-parse', 'HEAD');
}

const PATHS = [
  'browser/x/widget.mjs',
  'browser/x/test/browser_a.js',
  'browser/x/test/browser_b.js',
  'toolkit/y/util.mjs',
  'toolkit/z/test/browser_z.js',
  'toolkit/w/test/browser_w.js',
];

const snapshot = {
  files: PATHS.map((path) => ({ path })),
  inputs: [{ path: 'fireforge.json' }],
  config: { sources: { root: 'src', metadataRoot: '.fireforge-sources' } },
} as unknown as Pick<AuthoredSnapshot, 'files' | 'inputs' | 'config'>;

let base: string;
let peerUtil: string;
let peerWidget: string;
let mine: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'fireforge-attribution-'));
  repo = join(directory, 'repo');
  namespace = join(directory, 'namespace');
  await mkdir(repo);
  await mkdir(join(namespace, 'logs'), { recursive: true });
  git('init', '-q', '-b', 'main');
  base = await commit('origin', 'base', Object.fromEntries(PATHS.map((path) => [path, 'one\n'])));
  peerUtil = await commit('Peer One', 'peer: util', { 'toolkit/y/util.mjs': 'two\n' });
  peerWidget = await commit('Peer Two', 'peer: widget', { 'browser/x/widget.mjs': 'two\n' });
  git('switch', '-q', '-c', 'task');
  mine = await commit('Me', 'mine: test a', { 'browser/x/test/browser_a.js': 'two\n' });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

const LINT: JobStep = { command: 'lint', args: [] };
const CHECK: JobStep = { command: 'check', args: [] };
const LANE = testStep(['browser/x/test/browser_a.js', 'browser/x/test/browser_b.js']);
const OTHER = testStep(['toolkit/z/test/browser_z.js', 'toolkit/w/test/browser_w.js']);

const obligation = (id: string, kind: Obligation['kind'], step: JobStep): Obligation => ({
  id,
  kind,
  reason: '',
  step,
  fingerprints: [stepFingerprint(step)],
});

function gatePlan(overrides: Partial<ProofPlan> = {}): ProofPlan {
  return {
    schemaVersion: 1,
    id: 'p',
    tier: 'gate',
    source: 's',
    base: { commit: base, tree: 't', label: 'refs/fireforge/verified', narrowed: false },
    compiled: 'c',
    controlPaths: [],
    changed: [],
    obligations: [
      obligation('static', 'static', LINT),
      obligation('check', 'check', CHECK),
      obligation('lane:x', 'lane', LANE),
      obligation('lane:other', 'lane', OTHER),
    ],
    notes: [],
    removedTests: [],
    ...overrides,
  };
}

/** A job of these steps whose step logs and results are as given. */
async function job(
  id: string,
  steps: JobStep[],
  logs: Record<number, string>,
  results: Record<number, unknown> = {}
): Promise<void> {
  const record = { schemaVersion: 1, id, request: { steps } } as unknown as JobRecord;
  await writeFile(join(namespace, 'journal.jsonl'), `${JSON.stringify(record)}\n`, { flag: 'a' });
  await writeFile(
    join(namespace, 'logs', `${id}.log`),
    steps.map((step, index) => `${stepMarker(index, step)}${logs[index] ?? ''}\n`).join('')
  );
  for (const [index, document] of Object.entries(results)) {
    await mkdir(join(namespace, 'artifacts', id), { recursive: true });
    await writeFile(
      join(namespace, 'artifacts', id, `step-${index}-results.json`),
      JSON.stringify(document)
    );
  }
}

const red = (id: string, jobId: string): ObligationStatus => ({
  id,
  kind: 'lane',
  state: 'red',
  reason: '',
  reds: 1,
  job: jobId,
});

const file = (test: string, unexpected: boolean): TestFileResult => ({
  test,
  status: unexpected ? 'FAIL' : 'OK',
  expected: 'OK',
  unexpected,
  unexpectedSubtests: 0,
  run: 1,
  shard: test,
  logLine: 1,
});

async function range(): Promise<ProofRange> {
  const found = await proofRange(repo, gatePlan(), undefined);
  if (found === undefined) throw new Error('no range');
  return found;
}

describe('the range a gate stands on', () => {
  it('tells the commits other sessions landed on main apart from this change', async () => {
    const found = await range();
    expect(found).toMatchObject({
      base,
      label: 'refs/fireforge/verified',
      main: 'main',
      total: 3,
      onMain: 2,
    });
    expect([...found.mainCommits].sort()).toEqual([peerUtil, peerWidget].sort());
    expect(rangeWarning(gatePlan(), found)).toBe(
      `main has 2 commits since the verified ref (${base.slice(0, 12)}); reds in their inputs may not be yours`
    );
    expect(rangeWarning({ tier: 'task' }, found)).toBeUndefined();
    expect(rangeWarning(gatePlan(), { ...found, onMain: 0 })).toBeUndefined();
    expect(rangeWarning(gatePlan(), { ...found, onMain: 1 })).toContain('has 1 commit since');
  });

  it('has no range when the base is not an ancestor of HEAD', async () => {
    git('switch', '-q', '--orphan', 'elsewhere');
    await commit('Me', 'unrelated', { 'a/b.mjs': 'x\n' });
    expect(await proofRange(repo, gatePlan(), undefined)).toBeUndefined();
  });

  it('counts nothing as on main without a main branch', async () => {
    git('branch', '-q', '-m', 'main', 'trunk');
    const found = await proofRange(repo, gatePlan(), undefined);
    expect(found).toMatchObject({ total: 3, onMain: 0 });
    expect(found?.main).toBeUndefined();
  });
});

describe('attributing a red to the commits that touched what it reads', () => {
  it('names the peer commit behind a type error, and this change behind a failing test', async () => {
    await job(
      'j1',
      [LINT, CHECK, LANE, OTHER],
      {
        0: 'Linting 6 files\nERROR [checkjs-type-error] toolkit/y/util.mjs: Line 12: Type string is not number\nLint: 1 error(s)',
        1: 'check ran\nno file here failed',
      },
      {
        2: {
          schemaVersion: 1,
          files: [file('browser_a.js', true), file('browser_b.js', false)],
          unfinished: [],
        },
        3: { schemaVersion: 1, files: [file('toolkit/z/test/browser_z.js', true)], unfinished: [] },
      }
    );
    const found = await range();
    const reds = await attributeReds({
      namespace,
      root: repo,
      plan: gatePlan(),
      obligations: ['static', 'check', 'lane:x', 'lane:other'].map((id) => red(id, 'j1')),
      snapshot,
      range: found,
    });
    expect(reds).toEqual([
      {
        obligation: 'static',
        path: 'toolkit/y/util.mjs',
        line: 12,
        inputs: ['toolkit/y/util.mjs'],
        verdict: 'touched',
        commits: [{ commit: peerUtil, subject: 'peer: util', author: 'Peer One', own: false }],
      },
      expect.objectContaining({ obligation: 'check', verdict: 'unlocated', inputs: [] }),
      {
        obligation: 'lane:x',
        path: 'browser/x/test/browser_a.js',
        inputs: ['browser/x'],
        verdict: 'touched',
        commits: [
          { commit: mine, subject: 'mine: test a', author: 'Me', own: true },
          { commit: peerWidget, subject: 'peer: widget', author: 'Peer Two', own: false },
        ],
      },
      {
        obligation: 'lane:other',
        path: 'toolkit/z/test/browser_z.js',
        inputs: ['toolkit/z'],
        verdict: 'predates',
        commits: [],
      },
    ]);
    expect(reds[1]?.commits).toHaveLength(3);
    expect(attributionLines(found, reds)).toEqual([
      `red in toolkit/y/util.mjs:12 (static): touched since refs/fireforge/verified by ${peerUtil.slice(0, 12)} peer: util (Peer One, on main)`,
      `red in check: no file reported; refs/fireforge/verified..HEAD holds 3 commits, newest ${mine.slice(0, 12)} mine: test a (Me, this change)`,
      `    and ${peerWidget.slice(0, 12)} peer: widget (Peer Two, on main)`,
      `    and ${peerUtil.slice(0, 12)} peer: util (Peer One, on main)`,
      `red in browser/x/test/browser_a.js (lane:x): touched since refs/fireforge/verified by ${mine.slice(0, 12)} mine: test a (Me, this change)`,
      `    and ${peerWidget.slice(0, 12)} peer: widget (Peer Two, on main)`,
      'red in toolkit/z/test/browser_z.js (lane:other): no commit in refs/fireforge/verified..HEAD touched what it reads, so it predates the range or is environmental',
    ]);
  });

  it("calls a red only this capture's uncommitted change touched yours", async () => {
    await job(
      'j2',
      [OTHER],
      {},
      {
        0: {
          schemaVersion: 1,
          files: [],
          unfinished: [{ test: 'browser_w.js', run: 1, shard: 'x' }],
        },
      }
    );
    const plan = gatePlan({
      changed: [{ path: 'toolkit/w/w.mjs', tree: 'engine', route: 'source-link', deleted: false }],
    });
    const found = await range();
    const reds = await attributeReds({
      namespace,
      root: repo,
      plan,
      obligations: [red('lane:other', 'j2')],
      snapshot,
      range: found,
    });
    expect(reds).toEqual([
      expect.objectContaining({ path: 'toolkit/w/test/browser_w.js', verdict: 'uncommitted' }),
    ]);
    expect(attributionLines(found, reds)).toEqual([
      "red in toolkit/w/test/browser_w.js (lane:other): touched only by this capture's uncommitted change (yours)",
    ]);
  });

  it('falls back to the roster without results, and lists no more commits than it bounds', async () => {
    for (let index = 0; index < 6; index += 1)
      await commit('Me', `mine: widget ${String(index)}`, {
        'browser/x/widget.mjs': `${String(index)}\n`,
      });
    await job('j3', [LANE], {});
    const found = await range();
    const reds = await attributeReds({
      namespace,
      root: repo,
      plan: gatePlan(),
      obligations: [red('lane:x', 'j3'), { ...red('static', 'j3'), state: 'passed' }],
      snapshot,
      range: found,
    });
    expect(reds.map((entry) => entry.path)).toEqual([
      'browser/x/test/browser_a.js',
      'browser/x/test/browser_b.js',
    ]);
    expect(reds[0]?.commits).toHaveLength(5);
    expect(reds[0]?.more).toBe(true);
    expect(attributionLines(found, reds.slice(0, 1)).at(-1)).toBe('    and earlier commits');
  });

  it('reads nothing when nothing is red, and skips a red whose job is gone', async () => {
    const found = await range();
    const request = { namespace, root: repo, plan: gatePlan(), snapshot, range: found };
    expect(await attributeReds({ ...request, obligations: [] })).toEqual([]);
    expect(await attributeReds({ ...request, obligations: [red('lane:x', 'missing')] })).toEqual(
      []
    );
  });
});

describe('reading a red step', () => {
  const known = { find: (token: string) => PATHS.find((path) => token.endsWith(path)) };

  it('finds captured files a log reports, however a tool spells the path', () => {
    expect(
      reportedFiles(
        [
          '/slots/a/src/toolkit/y/util.mjs(4,2): error TS2322: nope',
          'browser/x/widget.mjs:9:1 - warning unused',
          'node_modules/other.js: error elsewhere',
          'checked toolkit/z/test/browser_z.js',
        ].join('\n'),
        known
      )
    ).toEqual([
      { path: 'toolkit/y/util.mjs', line: 4 },
      { path: 'browser/x/widget.mjs', line: 9 },
    ]);
  });

  it('maps a results file to the roster, including a harness record of a shard', () => {
    expect(
      failedTests(
        {
          schemaVersion: 1,
          files: [
            { ...file('harness', true), shardFiles: ['toolkit/z/test/browser_z.js'] },
            { ...file('harness', true), file: 'browser/x/test/browser_b.js' },
          ],
          unfinished: [],
        },
        ['browser/x/test/browser_b.js'],
        known
      )
    ).toEqual(['toolkit/z/test/browser_z.js', 'browser/x/test/browser_b.js']);
  });
});

describe('the report', () => {
  it('carries the range and the attributed reds in machine output', async () => {
    const found = await range();
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const argv = process.argv;
    process.argv = [...argv, '--json'];
    try {
      const status: ProofStatus = {
        complete: false,
        obligations: [],
        waived: [],
        failures: [],
        finished: 0,
      };
      printStatus(gatePlan(), status, {
        attribution: {
          range: found,
          reds: [{ obligation: 'check', inputs: [], verdict: 'unlocated', commits: [] }],
        },
      });
    } finally {
      process.argv = argv;
      setStdoutSealed(false);
    }
    const document = JSON.parse(writes.join('')) as Record<string, unknown>;
    expect(document['range']).toEqual({
      base,
      head: mine,
      label: 'refs/fireforge/verified',
      main: 'main',
      total: 3,
      onMain: 2,
    });
    expect(document['attribution']).toEqual([
      { obligation: 'check', inputs: [], verdict: 'unlocated', commits: [] },
    ]);
  });
});

describe('what prove says before and after it runs', () => {
  it('warns up front when the verified base holds commits that are not this change', async () => {
    const said: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      said.push(String(chunk));
      return true;
    });
    const plan = gatePlan();
    const found = await announceRange(repo, snapshot as AuthoredSnapshot, plan);
    expect(found?.onMain).toBe(2);
    expect(said).toEqual([
      `main has 2 commits since the verified ref (${base.slice(0, 12)}); reds in their inputs may not be yours\n`,
    ]);
    expect(
      await announceRange(join(directory, 'nothing'), snapshot as AuthoredSnapshot, plan)
    ).toBeUndefined();
    const context = {
      namespace,
      root: repo,
      snapshot: snapshot as AuthoredSnapshot,
      plan,
      range: found,
    };
    const status: ProofStatus = {
      complete: false,
      obligations: [],
      waived: [],
      failures: [],
      finished: 0,
    };
    expect(await attributionOf(context, status)).toEqual({});
    // Attribution never refuses: an unreadable namespace leaves the reds unattributed.
    const reds = { ...status, obligations: [red('lane:x', 'j9')] };
    expect(await attributionOf({ ...context, namespace: join(directory, 'none') }, reds)).toEqual({
      attribution: { range: found, reds: [] },
    });
  });

  it('takes --sample as a positive whole number', () => {
    expect(sampleRequest({})).toEqual({});
    expect(sampleRequest({ sample: '40' })).toEqual({ sample: 40 });
    for (const bad of ['0', '-3', '2.5', 'many'])
      expect(() => sampleRequest({ sample: bad })).toThrow(
        /--sample must be a positive whole number/
      );
  });
});
