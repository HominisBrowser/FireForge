// SPDX-License-Identifier: EUPL-1.2
/**
 * What the gate keeps between invocations.
 *
 * - The result of the last full run on a commit:
 *   `.fireforge/gate/<commit>/result.json`, beside the artifacts of that
 *   run. It belongs to one checkout and stands only for the tree and the
 *   FireForge version it was produced with.
 * - The decisions people recorded for a tree: one git ref per tree,
 *   `refs/fireforge/accepted/<tree>`, pointing at a JSON blob of the
 *   acceptances by ID. Refs are shared by every worktree of the repository.
 * - `refs/fireforge/verified`: the last commit that passed.
 */
import { join } from 'node:path';

import { packageVersion } from '../cli/version.js';
import { readBlobs, resolveRevision, updateRef, writeBlobs } from '../git/index.js';
import { ExitCode, FireForgeError } from '../kernel/errors.js';
import { listDir, pathInfo, remove } from '../kernel/fs.js';
import { hash } from '../kernel/hash.js';
import { parseJson, readJsonIfExists, stringifyJson, writeJson } from '../kernel/json.js';
import {
  acquireLock,
  COMMAND_WAIT_MS,
  type HeldLock,
  readLockStatus,
  tryAcquireLock,
} from '../kernel/lock.js';
import { info, verbose } from '../kernel/log.js';
import { type Infer, s } from '../kernel/schema.js';
import type { Project } from '../project/index.js';

/** The ref a passed gate moves. */
export const VERIFIED_REF = 'refs/fireforge/verified';

const ACCEPTED_REF_PREFIX = 'refs/fireforge/accepted/';

/** Gate runs whose artifacts a checkout keeps. */
const KEPT_RUNS = 5;
/** A run's directory is named after its commit. */
const COMMIT_NAME = /^[0-9a-f]{40,64}$/;

/** Why an entry could not judge the commit, as opposed to judging it red. */
export type Blocked = 'lock-timeout' | 'inconclusive';

const loadSchema = s.object({
  /** Logical CPUs of the host. */
  cpus: s.int({ min: 1 }),
  /** One-minute load average when the entry started. */
  start: s.number({ min: 0 }),
  /** One-minute load average when it ended. */
  end: s.number({ min: 0 }),
  /** The busiest process outside the command's own tree, sampled when the load was above the CPU count. */
  busiest: s
    .object({ pid: s.int({ min: 1 }), name: s.string(), cpu: s.number({ min: 0 }) })
    .optional(),
});

/** What the host was doing while an entry ran, attached to an entry that did not pass. */
export type GateLoad = Infer<typeof loadSchema>;

const entrySchema = s.object({
  /** `check`, `build`, or `kind:id` of a declared lane, stress run, control or run. */
  id: s.string({ min: 1 }),
  status: s.enum(['pass', 'fail', 'skipped']),
  detail: s.string(),
  durationMs: s.number({ min: 0 }),
  /** The entry's directory of logs and outputs, relative to the run's directory. */
  artifacts: s.string().optional(),
  /**
   * Set on a failed entry that could not run or could not be trusted for a
   * reason that says nothing about the commit: a lock that did not come free,
   * or an engine that changed under the run.
   */
  blocked: s.enum(['lock-timeout', 'inconclusive']).optional(),
  /** What to do next, when the error carried it. */
  hint: s.string().optional(),
  /** How a negative control came out. */
  control: s.enum(['caught', 'missed', 'wrong-red', 'baseline-red', 'inconclusive']).optional(),
  /** When the entry ended (ISO). On a reused entry, when it ended in the run it was taken from. */
  ranAt: s.string().optional(),
  /** Set on an entry taken from an earlier run of the same commit by `gate --resume` instead of run. */
  reused: s.boolean().optional(),
  /** The host load around an entry that was red, blocked or interrupted; informs, judges nothing. */
  load: loadSchema.optional(),
});

/** One thing a gate run did and how it ended. */
export type GateEntry = Infer<typeof entrySchema>;

const resultSchema = s.object({
  commit: s.string({ min: 1 }),
  tree: s.string({ min: 1 }),
  /** The FireForge version that produced the result. */
  tool: s.string({ min: 1 }),
  finishedAt: s.string(),
  pass: s.boolean(),
  entries: s.array(entrySchema),
  /** Hash of the gate declaration the run was made under; a resume needs it to match. */
  declaration: s.string().optional(),
});

/** The recorded result of a full gate run. */
export type GateResult = Infer<typeof resultSchema>;

/**
 * The directory holding a commit's gate result and artifacts.
 *
 * @param project - The project
 * @param commit - The commit the gate ran on
 */
export function gateDir(project: Project, commit: string): string {
  return join(project.paths.stateDir, 'gate', commit);
}

/**
 * The recorded result of a commit, when it still stands: produced by this
 * FireForge version for the tree the commit has.
 *
 * @param project - The project
 * @param commit - The commit
 * @param tree - The commit's tree
 */
export async function readResult(
  project: Project,
  commit: string,
  tree: string
): Promise<GateResult | undefined> {
  const path = join(gateDir(project, commit), 'result.json');
  const result = await readJsonIfExists(path, resultSchema).catch(() => undefined);
  return result?.tree === tree && result.tool === (await packageVersion()) ? result : undefined;
}

/**
 * Records the result of a full run.
 *
 * @param project - The project
 * @param result - What ran, without the version, which is this one
 */
export async function writeResult(
  project: Project,
  result: Omit<GateResult, 'tool' | 'finishedAt'>
): Promise<GateResult> {
  const complete = {
    ...result,
    tool: await packageVersion(),
    finishedAt: new Date().toISOString(),
  };
  await writeJson(join(gateDir(project, result.commit), 'result.json'), complete);
  return complete;
}

const runSchema = s.object({
  commit: s.string({ min: 1 }),
  tree: s.string({ min: 1 }),
  tool: s.string({ min: 1 }),
  declaration: s.string(),
  /** The process running the gate. */
  pid: s.int({ min: 1 }),
  startedAt: s.string(),
  /** Whether the run does all the gate's work; a run of changed controls only is not one to resume. */
  full: s.boolean(),
  /** Entries the run does, the check and the build included. */
  total: s.int({ min: 0 }),
  /** The entry the run is on. */
  current: s.object({ id: s.string(), position: s.int({ min: 1 }), since: s.string() }).optional(),
  /** The entry an interrupt ended, with the host load around it. */
  interrupted: s.object({ id: s.string(), at: s.string(), load: loadSchema.optional() }).optional(),
  /** What has ended so far, in the order it ended. */
  entries: s.array(entrySchema),
});

/** What a gate run keeps while it works, and leaves behind when it is killed. */
export type RunRecord = Infer<typeof runSchema>;

const RUN_RECORD = 'progress.json';
const runRecordPath = (project: Project, commit: string): string =>
  join(gateDir(project, commit), RUN_RECORD);

/**
 * A short hash of what the gate declares. A run is resumed only under the
 * declaration it was made under.
 *
 * @param gate - The `gate` section of the configuration
 */
export function declarationHash(gate: unknown): string {
  return hash(stringifyJson(gate ?? null, { sortKeys: true })).slice(0, 16);
}

/** What a run records as it goes. Every write is advisory: one that fails is dropped. */
export interface RunRecorder {
  /** The run is starting this entry. */
  begin(id: string): Promise<void>;
  /** This entry ended. */
  complete(entry: GateEntry): Promise<void>;
  /** An interrupt ended the entry it was on. */
  interrupted(id: string, load: GateLoad | undefined): Promise<void>;
  /** The run ended and its result is recorded: the record of the work in flight goes. */
  close(): Promise<void>;
}

/** What a run tells {@link openRunRecord} about itself. */
export interface RunPlan {
  commit: string;
  tree: string;
  declaration: string;
  /** Whether the run does all the gate's work. */
  full: boolean;
  /** Every entry the run reports, in order. */
  order: readonly string[];
  /** Entries taken from an earlier run, already ended. */
  carried: readonly GateEntry[];
}

/**
 * Starts the record of a run: `progress.json` beside its artifacts, rewritten
 * atomically each time an entry starts or ends. It is what `gate status` reads
 * to say which entry a running gate is on, and what `gate --resume` reads
 * after the run is killed. It never blocks or fails the run.
 *
 * @param project - The project
 * @param plan - See {@link RunPlan}
 */
export async function openRunRecord(project: Project, plan: RunPlan): Promise<RunRecorder> {
  const path = runRecordPath(project, plan.commit);
  const record: RunRecord = {
    commit: plan.commit,
    tree: plan.tree,
    tool: await packageVersion().catch(() => 'unknown'),
    declaration: plan.declaration,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    full: plan.full,
    total: plan.order.length,
    entries: [...plan.carried],
  };
  const save = async (): Promise<void> => {
    try {
      await writeJson(path, record);
    } catch (error: unknown) {
      verbose(`The progress of the gate run was not recorded: ${String(error)}`);
    }
  };
  await save();
  return {
    async begin(id) {
      record.current = {
        id,
        position: Math.max(1, plan.order.indexOf(id) + 1),
        since: new Date().toISOString(),
      };
      await save();
    },
    async complete(entry) {
      delete record.current;
      record.entries.push(entry);
      await save();
    },
    async interrupted(id, load) {
      delete record.current;
      record.interrupted = {
        id,
        at: new Date().toISOString(),
        ...(load === undefined ? {} : { load }),
      };
      await save();
    },
    async close() {
      await remove(path).catch(() => undefined);
    },
  };
}

/** Where a running gate is, from its record. */
export interface RunPosition {
  /** The entry it is on. */
  id: string;
  /** Its place among the entries of the run, from 1. */
  position: number;
  total: number;
  /** When the entry started. */
  since: string;
}

/**
 * Which entry the gate run of `pid` on `commit` is on, when its record says.
 * A record another process wrote does not count.
 *
 * @param project - The project
 * @param commit - The commit being gated
 * @param pid - The process holding the run
 */
export async function readRunPosition(
  project: Project,
  commit: string,
  pid: number
): Promise<RunPosition | undefined> {
  const record = await readJsonIfExists(runRecordPath(project, commit), runSchema).catch(
    () => undefined
  );
  if (record?.pid !== pid || record.commit !== commit || record.current === undefined) {
    return undefined;
  }
  return { ...record.current, total: record.total };
}

/** The entries of an earlier full run of the commit that `--resume` may take passes from. */
export interface Resumable {
  entries: GateEntry[];
  /** What the run was: `finished`, or `interrupted` when it was killed before its result. */
  how: 'finished' | 'interrupted';
  /** When it ended (finished) or started (interrupted). */
  at: string;
}

/**
 * The recorded full run of a commit that `gate --resume` may continue, or why
 * there is none: it must be for this commit's tree, this FireForge version and
 * the same gate declaration.
 *
 * @param project - The project
 * @param commit - The commit
 * @param tree - Its tree
 * @param declaration - {@link declarationHash} of the gate as declared now
 */
export async function readResumable(
  project: Project,
  commit: string,
  tree: string,
  declaration: string
): Promise<Resumable | { why: string }> {
  const tool = await packageVersion();
  const finished = await readJsonIfExists(
    join(gateDir(project, commit), 'result.json'),
    resultSchema
  ).catch(() => undefined);
  const killed = await readJsonIfExists(runRecordPath(project, commit), runSchema).catch(
    () => undefined
  );
  const source =
    finished === undefined
      ? killed === undefined || !killed.full
        ? undefined
        : { ...killed, how: 'interrupted' as const, at: killed.startedAt }
      : { ...finished, how: 'finished' as const, at: finished.finishedAt };
  if (source === undefined)
    return { why: 'no full run of this commit is recorded in this checkout' };
  if (source.tree !== tree) return { why: 'the recorded run is for another tree' };
  if (source.tool !== tool) {
    return { why: `the recorded run was made by FireForge ${source.tool}, this is ${tool}` };
  }
  if (source.declaration !== declaration) {
    return { why: 'the gate declaration changed since the recorded run' };
  }
  return { entries: source.entries, how: source.how, at: source.at };
}

/** Whether a commit's directory still holds the output an entry names. */
export async function hasArtifacts(
  project: Project,
  commit: string,
  entry: GateEntry
): Promise<boolean> {
  return (
    entry.artifacts === undefined ||
    (await pathInfo(join(gateDir(project, commit), entry.artifacts))) !== undefined
  );
}

/**
 * Removes the record of a result that a resumed run is about to replace, once
 * the new run's own record holds everything the old one did.
 *
 * @param project - The project
 * @param commit - The commit
 */
export async function dropResult(project: Project, commit: string): Promise<void> {
  await remove(join(gateDir(project, commit), 'result.json'));
}

const GATE_LOCK_PREFIX = '.lock-';
/** Directories a feedback run can write at once; the first is `feedback/`. */
const FEEDBACK_SLOTS = 4;

const gateRoot = (project: Project): string => join(project.paths.stateDir, 'gate');

/** The slot a commit's runs hold: a run of any commit with the same two leading characters shares it. */
const commitLock = (project: Project, commit: string): string =>
  join(gateRoot(project), `${GATE_LOCK_PREFIX}${commit.slice(0, 2)}`);

/**
 * Runs `body` as the one gate run on a commit in this checkout. A second gate
 * on the same commit waits for the first, and then finds its recorded result,
 * instead of erasing the logs the first is still writing.
 *
 * @param project - The project
 * @param commit - The commit about to be gated
 * @param waitMs - How long to wait for the other run (default as long as a run takes)
 * @param body - The work
 * @throws `lock-timeout` (exit code 15) when the other run did not finish in time
 */
export async function withGateRun<T>(
  project: Project,
  commit: string,
  waitMs: number | undefined,
  body: () => Promise<T>
): Promise<T> {
  const slot = commitLock(project, commit);
  const short = commit.slice(0, 12);
  const holder = (await readLockStatus(slot).catch(() => undefined))?.holders[0];
  let label = `gate run of ${short}`;
  if (holder !== undefined) {
    const other = holder.info['commit'];
    const same = other === commit;
    const where = describeRunning(
      holder.pid,
      holder.requestedAt,
      await readRunPosition(project, other ?? commit, holder.pid)
    );
    label = same
      ? `running gate of this same commit (${short})`
      : `running gate of ${other?.slice(0, 12) ?? 'another commit'}, which shares this commit's run slot`;
    info(
      same
        ? `A gate of this commit is already running (${where}); waiting for it and then reading its recorded result.`
        : `A gate of ${other?.slice(0, 12) ?? 'another commit'} is running (${where}) and shares this commit's run slot; waiting for it.`
    );
  }
  const lock = await acquireLock(slot, {
    label,
    waitMs: waitMs ?? COMMAND_WAIT_MS,
    info: { command: 'gate', commit },
  });
  try {
    return await body();
  } finally {
    await lock.release();
  }
}

/**
 * How a running gate reads in a message: its process, since when, and the entry it is on.
 *
 * @param pid - The process
 * @param since - When it asked for the run slot
 * @param position - Its place in the run, when it recorded one
 */
function describeRunning(pid: number, since: string, position: RunPosition | undefined): string {
  const on =
    position === undefined
      ? ''
      : `, on ${position.id} (entry ${position.position} of ${position.total}, since ${position.since})`;
  return `PID ${pid}, since ${since}${on}`;
}

/** A gate run found in the checkout. */
export interface RunningGate {
  pid: number;
  /** When the process asked for the run slot. */
  since: string;
  /** A full run of a commit, or a `--lane` feedback run. */
  kind: 'full' | 'feedback';
  /** The commit a full run judges, when its holder said. */
  commit?: string;
  /** The entry it is on, when it recorded one. */
  entry?: RunPosition;
}

/**
 * The gates running in this checkout right now, read from the locks without
 * taking or changing any.
 *
 * @param project - The project
 */
export async function readRunningGates(project: Project): Promise<RunningGate[]> {
  const found: RunningGate[] = [];
  for (const slot of await listDir(gateRoot(project))) {
    if (slot.kind !== 'directory' || !slot.name.startsWith(GATE_LOCK_PREFIX)) continue;
    const status = await readLockStatus(join(gateRoot(project), slot.name)).catch(() => undefined);
    for (const holder of status?.holders ?? []) {
      if (holder.info['command'] !== 'gate') continue;
      const commit = holder.info['commit'];
      const entry =
        commit === undefined ? undefined : await readRunPosition(project, commit, holder.pid);
      found.push({
        pid: holder.pid,
        since: holder.requestedAt,
        kind:
          slot.name === `${GATE_LOCK_PREFIX}feedback` ||
          slot.name.startsWith(`${GATE_LOCK_PREFIX}feedback-`)
            ? 'feedback'
            : 'full',
        ...(commit === undefined ? {} : { commit }),
        ...(entry === undefined ? {} : { entry }),
      });
    }
  }
  return found;
}

/**
 * Runs `body` with a directory for the outputs of a feedback run: `feedback/`,
 * or `feedback-<n>/` while another feedback run holds it. The directory is
 * emptied first; no other run touches it until `body` ends.
 *
 * @param project - The project
 * @param waitMs - How long to wait when every directory is in use (default as long as a run takes)
 * @param body - The work, given the directory
 * @throws `lock-timeout` (exit code 15) when every directory stayed in use
 */
export async function withFeedbackDir<T>(
  project: Project,
  waitMs: number | undefined,
  body: (dir: string) => Promise<T>
): Promise<T> {
  const lockOf = (slot: number): string =>
    join(gateRoot(project), `${GATE_LOCK_PREFIX}feedback${slot === 0 ? '' : `-${slot}`}`);
  const nameOf = (slot: number): string => (slot === 0 ? 'feedback' : `feedback-${slot}`);
  let held: { lock: HeldLock; slot: number } | undefined;
  for (let slot = 0; slot < FEEDBACK_SLOTS && held === undefined; slot += 1) {
    const lock = await tryAcquireLock(lockOf(slot), {
      label: 'feedback outputs',
      info: { command: 'gate' },
    });
    if (lock !== undefined) held = { lock, slot };
  }
  held ??= {
    lock: await acquireLock(lockOf(0), {
      label: 'feedback outputs',
      waitMs: waitMs ?? COMMAND_WAIT_MS,
      info: { command: 'gate' },
    }),
    slot: 0,
  };
  try {
    const dir = join(gateRoot(project), nameOf(held.slot));
    await remove(dir);
    return await body(dir);
  } finally {
    await held.lock.release();
  }
}

/**
 * Empties the directory a run on `commit` writes to and drops the oldest
 * other runs past the number a checkout keeps. Call it inside
 * {@link withGateRun}; a run another gate still holds is never dropped.
 *
 * @param project - The project
 * @param commit - The commit about to be gated
 * @param options - `keep` leaves the commit's own directory as it is, for a run that resumes one
 */
export async function prepareGateDir(
  project: Project,
  commit: string,
  options: { keep?: boolean } = {}
): Promise<string> {
  const root = gateRoot(project);
  const dated: { name: string; mtimeMs: number }[] = [];
  for (const entry of await listDir(root)) {
    if (entry.kind !== 'directory' || entry.name === commit || !COMMIT_NAME.test(entry.name)) {
      continue;
    }
    dated.push({
      name: entry.name,
      mtimeMs: (await pathInfo(join(root, entry.name)))?.mtimeMs ?? 0,
    });
  }
  dated.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const stale of dated.slice(KEPT_RUNS - 1)) {
    const slot = commitLock(project, stale.name);
    // The slot this run holds covers every commit sharing it; another is free only when it can be taken.
    const lock = slot === commitLock(project, commit) ? undefined : await tryAcquireLock(slot);
    if (lock === undefined && slot !== commitLock(project, commit)) continue;
    try {
      await remove(join(root, stale.name));
    } finally {
      await lock?.release();
    }
  }
  if (options.keep !== true) await remove(gateDir(project, commit));
  return gateDir(project, commit);
}

const acceptanceSchema = s.object({
  /** Who decided: the repository's `user.name`, else the login name. */
  by: s.string(),
  at: s.string(),
  note: s.string(),
  /** The commit that was checked out when the decision was recorded. */
  commit: s.string(),
});

/** One recorded decision. */
export type Acceptance = Infer<typeof acceptanceSchema>;

const acceptancesSchema = s.record(acceptanceSchema);

async function readAcceptanceBlob(
  repository: string,
  tree: string
): Promise<{ blob: string | undefined; accepted: Record<string, Acceptance> }> {
  const blob = await resolveRevision(repository, `${ACCEPTED_REF_PREFIX}${tree}`);
  if (blob === undefined) return { blob, accepted: {} };
  const content = (await readBlobs(repository, [blob])).get(blob);
  const source = `${ACCEPTED_REF_PREFIX}${tree}`;
  return {
    blob,
    accepted: acceptancesSchema.parse(parseJson(content?.toString('utf8') ?? '{}', { source }), {
      source,
    }),
  };
}

/**
 * The decisions recorded for a tree, by acceptance ID.
 *
 * @param repository - The repository's top directory
 * @param tree - The tree
 */
export async function readAcceptances(
  repository: string,
  tree: string
): Promise<Record<string, Acceptance>> {
  return (await readAcceptanceBlob(repository, tree)).accepted;
}

/**
 * Records a decision for a tree, replacing an earlier one with the same ID.
 *
 * @param repository - The repository's top directory
 * @param tree - The tree the decision is about
 * @param id - The acceptance ID
 * @param acceptance - Who, when, and their note
 * @throws `gate-accept-raced` (exit code 4) when another decision for the
 *   tree was recorded at the same moment
 */
export async function recordAcceptance(
  repository: string,
  tree: string,
  id: string,
  acceptance: Acceptance
): Promise<void> {
  const { blob, accepted } = await readAcceptanceBlob(repository, tree);
  const text = stringifyJson({ ...accepted, [id]: acceptance });
  const [next] = await writeBlobs(repository, [Buffer.from(text)]);
  const moved =
    next !== undefined &&
    (await updateRef(repository, `${ACCEPTED_REF_PREFIX}${tree}`, next, { expect: blob ?? null }));
  if (!moved) {
    throw new FireForgeError(
      'gate-accept-raced',
      'Another acceptance for this tree was recorded at the same moment.',
      { exitCode: ExitCode.GIT_ERROR, hint: 'Run the command again.' }
    );
  }
}
