// SPDX-License-Identifier: EUPL-1.2
/**
 * What a checkout remembers about the negative controls it ran: one record
 * per run, written by the full gate, a feedback run and `test --control`
 * alike, in `.fireforge/gate/controls.json`.
 *
 * A record names the diff by content and path, the declared control when it
 * has an ID, the tests and expected labels, what the run was against (the
 * commit and tree of a clean checkout, and the engine state the test runner
 * judges by), how it came out, and which assertions actually went red. The
 * record informs and never blocks: a file that cannot be read reads as empty,
 * and a write that fails is a warning.
 *
 * The file is bounded: the newest runs of each control, and a cap on all.
 */
import { join, relative, resolve } from 'node:path';

import { resolveRevision, status } from '../git/index.js';
import { toError } from '../kernel/errors.js';
import { isInside, readBytesIfExists, toPosixPath } from '../kernel/fs.js';
import { hash } from '../kernel/hash.js';
import { readJsonIfExists, writeJson } from '../kernel/json.js';
import { withLock } from '../kernel/lock.js';
import { warn } from '../kernel/log.js';
import { type Infer, s } from '../kernel/schema.js';
import type { Project } from '../project/index.js';
import type { ControlResult } from './control.js';

/** Runs of one control that stay in the record. */
const KEPT_PER_CONTROL = 3;
/** Runs the record holds in all. */
const KEPT_RUNS = 200;
const RECORD_VERSION = 1;

const runSchema = s.object({
  at: s.string(),
  /** Which way the control ran. */
  source: s.enum(['gate', 'feedback', 'test']),
  /** The declared control's ID, when it ran as one. */
  id: s.string().optional(),
  diff: s.object({
    /** Project-relative with forward slashes, or absolute for a diff outside the project. */
    path: s.string(),
    /** SHA-256 of the diff's bytes; empty when it could not be read. */
    hash: s.string(),
  }),
  /** The tests as requested (a file, directory or manifest each). */
  tests: s.array(s.string()),
  expect: s.array(s.string()),
  against: s.object({
    /** The checked-out commit and its tree, when the working tree was clean. */
    commit: s.string().optional(),
    tree: s.string().optional(),
    /** The tree of the engine's working tree before the mutation. */
    engine: s.string().optional(),
  }),
  outcome: s.enum(['caught', 'missed', 'wrong-red', 'baseline-red', 'inconclusive']),
  /** The assertions that went red with the mutation, expected or not. */
  red: s.array(s.string()),
  /** The reds no expected label names. */
  unexpected: s.array(s.string()),
  why: s.string().optional(),
});

/** One control run. */
export type ControlRun = Infer<typeof runSchema>;

const fileSchema = s.object({ version: s.int(), runs: s.array(runSchema) });

/**
 * The file holding a checkout's control runs.
 *
 * @param project - The project
 */
function controlRecordPath(project: Pick<Project, 'paths'>): string {
  return join(project.paths.stateDir, 'gate', 'controls.json');
}

/**
 * The control runs this checkout recorded, oldest first. A missing or
 * unreadable record reads as empty.
 *
 * @param project - The project
 */
export async function readControlRuns(project: Pick<Project, 'paths'>): Promise<ControlRun[]> {
  const file = await readJsonIfExists(controlRecordPath(project), fileSchema).catch(
    () => undefined
  );
  return file?.version === RECORD_VERSION ? file.runs : [];
}

/** The identity of a diff as the record keeps it: where it is, and what it holds. */
async function diffIdentity(
  project: Pick<Project, 'root'>,
  diff: string
): Promise<ControlRun['diff']> {
  const absolute = resolve(project.root, diff);
  const bytes = await readBytesIfExists(absolute);
  return {
    path: isInside(project.root, absolute)
      ? toPosixPath(relative(project.root, absolute))
      : toPosixPath(absolute),
    hash: bytes === undefined ? '' : hash(bytes),
  };
}

/** The checked-out commit and tree when the working tree equals it. */
async function cleanCheckout(
  project: Pick<Project, 'checkout'>
): Promise<{ commit: string; tree: string } | undefined> {
  const repository = project.checkout.worktree;
  if (repository === undefined) return undefined;
  const commit = await resolveRevision(repository, 'HEAD', 'commit');
  const tree = commit === undefined ? undefined : await resolveRevision(repository, commit, 'tree');
  if (commit === undefined || tree === undefined) return undefined;
  return (await status(repository)).length === 0 ? { commit, tree } : undefined;
}

/** What {@link recordControlRun} needs to know about a run. */
export interface ControlRunInput {
  source: ControlRun['source'];
  /** The declared control's ID. */
  id?: string | undefined;
  /** The diff as given: absolute, or project-relative. */
  diff: string;
  /** The tests as requested. */
  tests: readonly string[];
  expect: readonly string[];
  result: ControlResult;
  /** The checkout identity, when the caller already holds it; otherwise read when the tree is clean. */
  against?: { commit: string; tree: string } | undefined;
}

/**
 * Appends a control run to the record, dropping the oldest beyond the bounds.
 * Never throws: a record that cannot be written is a warning.
 *
 * @param project - The project
 * @param input - The run
 */
export async function recordControlRun(project: Project, input: ControlRunInput): Promise<void> {
  try {
    const checkout = input.against ?? (await cleanCheckout(project));
    const run: ControlRun = {
      at: new Date().toISOString(),
      source: input.source,
      ...(input.id === undefined ? {} : { id: input.id }),
      diff: await diffIdentity(project, input.diff),
      tests: [...input.tests],
      expect: [...input.expect],
      against: {
        ...(checkout === undefined ? {} : { commit: checkout.commit, tree: checkout.tree }),
        ...(input.result.engine === undefined ? {} : { engine: input.result.engine }),
      },
      outcome: input.result.outcome,
      red: input.result.red ?? [],
      unexpected: input.result.unexpected ?? [],
      ...(input.result.why === undefined ? {} : { why: input.result.why }),
    };
    const path = controlRecordPath(project);
    await withLock(
      join(project.paths.stateDir, 'gate', '.lock-controls'),
      { label: 'control record', waitMs: 10_000 },
      async () => {
        const runs = [...(await readControlRuns(project)), run];
        await writeJson(path, { version: RECORD_VERSION, runs: bound(runs) });
      }
    );
  } catch (error: unknown) {
    warn(`The control record was not updated: ${toError(error).message}`);
  }
}

/** What a run belongs to: the declared ID, else the diff. */
const keyOf = (run: ControlRun): string => run.id ?? `diff:${run.diff.path}`;

/** The newest runs of each control, and the newest of all. */
function bound(runs: readonly ControlRun[]): ControlRun[] {
  const seen = new Map<string, number>();
  const kept: ControlRun[] = [];
  for (const run of [...runs].reverse()) {
    const count = (seen.get(keyOf(run)) ?? 0) + 1;
    seen.set(keyOf(run), count);
    if (count <= KEPT_PER_CONTROL) kept.push(run);
  }
  return kept.slice(0, KEPT_RUNS).reverse();
}
