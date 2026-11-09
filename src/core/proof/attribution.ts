// SPDX-License-Identifier: EUPL-1.2
/**
 * Which commits in a plan's range touched what a red reads: best effort, bounded,
 * and never part of a verdict. A gate's base can hold commits other sessions
 * landed on the main branch since the verified ref, so a red in their inputs is
 * reported against them rather than left for the reader to work out.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ProofConfig } from '../../types/config.js';
import { matchesAnyGlob } from '../../utils/path-glob.js';
import { sourceGitStatus } from '../authored/git.js';
import type { AuthoredSnapshot } from '../authored/types.js';
import { readLogRange } from '../jobs/job-view.js';
import type { JobRecord } from '../jobs/schema.js';
import { readJournal } from '../jobs/store.js';
import type { TestResultsDocument } from '../test-results-document.js';
import type { ObligationStatus } from './evidence.js';
import { componentDirectory } from './plan-consumers.js';
import { stepFingerprint } from './plan-steps.js';
import { mainBranch } from './snapshot.js';
import type { Obligation, ProofPlan } from './types.js';
import { isAncestor, resolveCommit } from './verified.js';

/** Reds attributed in one report. */
const MAX_REDS = 20;
/** Commits listed against one red. */
const MAX_COMMITS = 5;
/** Files one red step's log may name. */
const MAX_FILES = 10;
/** How much of a red step's log is read, from its end. */
const LOG_TAIL = 262_144;
/** Commits of the range on the main branch that are told apart from this change's own. */
const MAX_MAIN_COMMITS = 2_000;

/** The commits between a plan's base and the checkout's `HEAD`. */
export interface ProofRange {
  base: string;
  head: string;
  /** The base as the plan names it. */
  label: string;
  /** The main branch the range is told apart by, when there is one. */
  main?: string;
  /** Commits in the range. */
  total: number;
  /** Commits in the range already on the main branch: other sessions' work, not this change's. */
  onMain: number;
  /** Those commits, to mark each one. Not reported. */
  mainCommits: ReadonlySet<string>;
}

/** One commit that touched a red's inputs. */
export interface RedCommit {
  commit: string;
  subject: string;
  author: string;
  /** This change's own commit, rather than one already on the main branch. */
  own: boolean;
}

export interface RedAttribution {
  obligation: string;
  /** The failing test or reported file, engine-relative or at the project root. */
  path?: string;
  line?: number;
  /** What the commits were looked up by: paths, directories and declared globs. */
  inputs: string[];
  /**
   * `touched`: commits in the range touched the inputs. `uncommitted`: only this
   * capture's uncommitted change did. `predates`: nothing in the range did, so the
   * red is older than the range or environmental. `unlocated`: the red named no
   * file, so `commits` is the range itself.
   */
  verdict: 'touched' | 'uncommitted' | 'predates' | 'unlocated';
  commits: RedCommit[];
  /** More commits matched than are listed. */
  more?: true;
}

const lines = (bytes: Buffer): string[] => bytes.toString('utf8').split('\n').filter(Boolean);

/**
 * The plan's range, or undefined when its base is not an ancestor of `HEAD`.
 *
 * @param root - The checkout whose `HEAD` ends the range
 * @param plan - The plan whose base starts it
 * @param proof - The declaration that names the main branch, when it does
 */
export async function proofRange(
  root: string,
  plan: Pick<ProofPlan, 'base'>,
  proof: ProofConfig | undefined
): Promise<ProofRange | undefined> {
  const head = await resolveCommit(root, 'HEAD');
  const base = plan.base.commit;
  if (head === undefined || !(await isAncestor(root, base, head))) return undefined;
  const count = async (range: string): Promise<number> =>
    Number((await sourceGitStatus(root, ['rev-list', '--count', range])).stdout.toString().trim());
  const range: ProofRange = {
    base,
    head,
    label: plan.base.label,
    total: await count(`${base}..${head}`),
    onMain: 0,
    mainCommits: new Set(),
  };
  for (const name of (await mainBranch(root, proof)).names) {
    const tip = await resolveCommit(root, `refs/heads/${name}`);
    if (tip === undefined) continue;
    const fork = await sourceGitStatus(root, ['merge-base', tip, head]);
    const shared = fork.stdout.toString().trim();
    if (fork.code !== 0 || !(await isAncestor(root, base, shared))) return { ...range, main: name };
    const listed = await sourceGitStatus(root, [
      'rev-list',
      `--max-count=${String(MAX_MAIN_COMMITS)}`,
      `${base}..${shared}`,
    ]);
    const commits = lines(listed.stdout);
    return {
      ...range,
      main: name,
      onMain: await count(`${base}..${shared}`),
      mainCommits: new Set(commits),
    };
  }
  return range;
}

/** The line a gate prints before it runs, when its base holds commits that are not this change's. */
export function rangeWarning(plan: Pick<ProofPlan, 'tier'>, range: ProofRange): string | undefined {
  if (
    plan.tier !== 'gate' ||
    range.onMain === 0 ||
    !range.label.endsWith('refs/fireforge/verified')
  )
    return undefined;
  return `${range.main ?? 'main'} has ${String(range.onMain)} commit${range.onMain === 1 ? '' : 's'} since the verified ref (${range.base.slice(0, 12)}); reds in their inputs may not be yours`;
}

/** What a red reads, in the paths a capture names. */
interface Subject {
  path?: string;
  line?: number;
  inputs: string[];
}

/** Captured paths, to recognise one in a log or a results file however it is spelled. */
class KnownPaths {
  private readonly engine: Set<string>;
  private readonly root: Set<string>;

  constructor(snapshot: Pick<AuthoredSnapshot, 'files' | 'inputs'>) {
    this.engine = new Set(snapshot.files.map((file) => file.path));
    this.root = new Set(snapshot.inputs.map((input) => input.path));
  }

  /** The longest captured path a token ends with: absolute, slot-relative or engine-relative. */
  find(token: string): string | undefined {
    const parts = token.replace(/^\.\//, '').split('/').filter(Boolean);
    for (let index = 0; index < parts.length; index += 1) {
      const candidate = parts.slice(index).join('/');
      if (this.engine.has(candidate)) return candidate;
      if (index === 0 && this.root.has(candidate)) return candidate;
    }
    return undefined;
  }
}

/** Lines of a lint, type or check log that report a problem. */
const PROBLEM = /\b(?:error|warning|ERROR|WARN)\b|\[[\w/.-]+\]|✖/;
const PATH_TOKEN = /((?:[\w@.+-]+\/)*[\w@.+-]+\.[A-Za-z][A-Za-z0-9]*)(?:(?::|\()(\d+))?/g;

/** The captured files a red step's log reports, with a line where it gives one. */
export function reportedFiles(
  log: string,
  known: Pick<KnownPaths, 'find'>
): Array<{ path: string; line?: number }> {
  const found = new Map<string, number | undefined>();
  for (const text of log.split('\n')) {
    if (!PROBLEM.test(text)) continue;
    for (const match of text.matchAll(PATH_TOKEN)) {
      const path = known.find(match[1] ?? '');
      if (path === undefined || found.has(path)) continue;
      const line = match[2] ?? /\bLine (\d+)/i.exec(text)?.[1];
      found.set(path, line === undefined ? undefined : Number(line));
      if (found.size >= MAX_FILES) break;
    }
    if (found.size >= MAX_FILES) break;
  }
  return [...found].map(([path, line]) => (line === undefined ? { path } : { path, line }));
}

/** The tests a results file says failed or never finished, by the roster's own paths. */
export function failedTests(
  document: TestResultsDocument,
  roster: readonly string[],
  known: Pick<KnownPaths, 'find'>
): string[] {
  const ids = [
    ...document.files
      .filter((file) => file.unexpected)
      .flatMap((file) =>
        file.file !== undefined ? [file.file] : (file.shardFiles ?? [file.test])
      ),
    ...document.unfinished.map((entry) => entry.test),
  ];
  const failed = new Set<string>();
  for (const id of ids) {
    const listed = roster.find(
      (path) => path === id || path.endsWith(`/${id}`) || id.endsWith(`/${path}`)
    );
    const path = listed ?? known.find(id);
    if (path !== undefined) failed.add(path);
  }
  return [...failed].slice(0, MAX_FILES);
}

/** The step of a job that ran an obligation. */
function stepIndex(job: JobRecord, obligation: Obligation): number {
  return job.request.steps.findIndex((step) =>
    obligation.fingerprints.includes(
      stepFingerprint({ ...step, quiet: step.quiet ?? job.request.quiet })
    )
  );
}

/** Declared owns of the lanes holding a test, which name what the lane answers for. */
const laneOwns = (proof: ProofConfig | undefined, obligation: string, test?: string): string[] =>
  (proof?.gate?.lanes ?? []).flatMap((lane) =>
    `lane:${lane.id}` === obligation || (test !== undefined && lane.files.includes(test))
      ? (lane.owns ?? [])
      : []
  );

interface SubjectContext {
  namespace: string;
  job: JobRecord;
  index: number;
  obligation: Obligation;
  known: KnownPaths;
  proof: ProofConfig | undefined;
}

/** What one red read: its failing tests, the files its log reports, or its own paths. */
async function subjectsOf(context: SubjectContext): Promise<Subject[]> {
  const { namespace, job, index, obligation, known, proof } = context;
  const step = job.request.steps[index];
  if (step === undefined) return [{ inputs: [] }];
  if (step.command === 'test') {
    const roster = step.expected?.files ?? [];
    const document = await readFile(
      join(namespace, 'artifacts', job.id, `step-${String(index)}-results.json`),
      'utf8'
    ).then(
      (text) => JSON.parse(text) as TestResultsDocument,
      () => undefined
    );
    const failed = document === undefined ? [] : failedTests(document, roster, known);
    const tests = failed.length > 0 ? failed : roster.length <= 3 ? [...roster] : [];
    if (tests.length > 0)
      return tests.map((path) => ({
        path,
        inputs: [...new Set([componentDirectory(path), ...laneOwns(proof, obligation.id, path)])],
      }));
    return [
      {
        inputs: [
          ...new Set([...roster.map(componentDirectory), ...laneOwns(proof, obligation.id)]),
        ].slice(0, 40),
      },
    ];
  }
  const log = await readLogRange(namespace, job.id, 0, LOG_TAIL, {
    step: index,
    tail: true,
    steps: job.request.steps,
  }).then(
    (chunk) => chunk.text,
    () => ''
  );
  const files = reportedFiles(log, known);
  if (files.length > 0) return files.map((file) => ({ ...file, inputs: [file.path] }));
  // A scoped lint names what it read; anything else read the whole source.
  const scoped = step.command === 'lint' ? step.args.filter((arg) => !arg.startsWith('-')) : [];
  return [{ inputs: scoped.filter((arg) => known.find(arg) === arg) }];
}

/** Git pathspecs for capture paths: a source path, its override record, or a root path. */
function pathspecs(
  inputs: readonly string[],
  snapshot: Pick<AuthoredSnapshot, 'config' | 'inputs'>
): string[] {
  const sources = snapshot.config.sources;
  const roots = new Set(snapshot.inputs.map((input) => input.path));
  return inputs.flatMap((input) => {
    if (roots.has(input) || sources === undefined) return [input];
    const overrides = `${sources.metadataRoot}/overrides/${input}`;
    if (/[*?]/.test(input))
      return [`:(glob)${sources.root}/${input}`, `:(glob)${overrides}`, `:(glob)${input}`];
    return [
      `${sources.root}/${input}`,
      /\.[A-Za-z0-9]+$/.test(input) ? `${overrides}.json` : overrides,
    ];
  });
}

/** Whether a changed path is one of these inputs, or under one. */
const covers = (inputs: readonly string[], path: string): boolean =>
  inputs.some((input) =>
    /[*?]/.test(input)
      ? matchesAnyGlob(path, [input])
      : path === input || path.startsWith(`${input}/`)
  );

async function commitsTouching(
  root: string,
  range: ProofRange,
  specs: readonly string[]
): Promise<{ commits: RedCommit[]; more: boolean }> {
  const { code, stdout } = await sourceGitStatus(root, [
    'log',
    '--format=%H%x1f%s%x1f%an',
    `--max-count=${String(MAX_COMMITS + 1)}`,
    `${range.base}..${range.head}`,
    ...(specs.length === 0 ? [] : ['--', ...specs]),
  ]);
  if (code !== 0) return { commits: [], more: false };
  const commits = lines(stdout).map((line) => {
    const [commit = '', subject = '', author = ''] = line.split('\x1f');
    return { commit, subject, author, own: !range.mainCommits.has(commit) };
  });
  return { commits: commits.slice(0, MAX_COMMITS), more: commits.length > MAX_COMMITS };
}

export interface AttributionRequest {
  namespace: string;
  root: string;
  plan: ProofPlan;
  obligations: readonly ObligationStatus[];
  snapshot: Pick<AuthoredSnapshot, 'files' | 'inputs' | 'config'>;
  range: ProofRange;
}

/**
 * Each red, by the failing test or reported file where its results name one,
 * with the commits in the plan's range that touched what it reads.
 */
export async function attributeReds(request: AttributionRequest): Promise<RedAttribution[]> {
  const { namespace, root, plan, snapshot, range } = request;
  const reds = request.obligations.filter((entry) => entry.state === 'red' && entry.job);
  if (reds.length === 0) return [];
  const journal = await readJournal(namespace);
  const known = new KnownPaths(snapshot);
  const attributed: RedAttribution[] = [];
  for (const red of reds) {
    const obligation = plan.obligations.find((entry) => entry.id === red.id);
    const job = journal.get(red.job ?? '');
    if (obligation === undefined || job === undefined) continue;
    const subjects = await subjectsOf({
      namespace,
      job,
      index: stepIndex(job, obligation),
      obligation,
      known,
      proof: snapshot.config.proof,
    });
    for (const subject of subjects) {
      if (attributed.length >= MAX_REDS) return attributed;
      const { commits, more } = await commitsTouching(
        root,
        range,
        pathspecs(subject.inputs, snapshot)
      );
      const verdict: RedAttribution['verdict'] =
        subject.inputs.length === 0
          ? 'unlocated'
          : commits.length > 0
            ? 'touched'
            : plan.changed.some((change) => covers(subject.inputs, change.path))
              ? 'uncommitted'
              : 'predates';
      attributed.push({
        obligation: red.id,
        ...(subject.path === undefined ? {} : { path: subject.path }),
        ...(subject.line === undefined ? {} : { line: subject.line }),
        inputs: subject.inputs,
        verdict,
        commits,
        ...(more ? { more: true as const } : {}),
      });
    }
  }
  return attributed;
}

/** One line per red, then one per further commit, in the report's own voice. */
export function attributionLines(
  range: ProofRange,
  attributions: readonly RedAttribution[]
): string[] {
  const where = (entry: RedAttribution): string =>
    `${entry.path === undefined ? entry.obligation : `${entry.path}${entry.line === undefined ? '' : `:${String(entry.line)}`}`}${entry.path === undefined ? '' : ` (${entry.obligation})`}`;
  const commit = (entry: RedCommit): string =>
    `${entry.commit.slice(0, 12)} ${entry.subject} (${entry.author}, ${entry.own ? 'this change' : `on ${range.main ?? 'main'}`})`;
  const span = `${range.label}..HEAD`;
  return attributions.flatMap((entry) => {
    const head = `red in ${where(entry)}`;
    const [first, ...rest] = entry.commits;
    const tail = [
      ...rest.map((other) => `    and ${commit(other)}`),
      ...(entry.more === true ? ['    and earlier commits'] : []),
    ];
    if (entry.verdict === 'touched' && first !== undefined)
      return [`${head}: touched since ${range.label} by ${commit(first)}`, ...tail];
    if (entry.verdict === 'uncommitted')
      return [`${head}: touched only by this capture's uncommitted change (yours)`];
    if (entry.verdict === 'predates')
      return [
        `${head}: no commit in ${span} touched what it reads, so it predates the range or is environmental`,
      ];
    return [
      `${head}: no file reported; ${span} holds ${String(range.total)} commit${range.total === 1 ? '' : 's'}${first === undefined ? '' : `, newest ${commit(first)}`}`,
      ...tail,
    ];
  });
}
