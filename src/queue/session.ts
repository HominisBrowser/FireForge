// SPDX-License-Identifier: EUPL-1.2
/**
 * Bringing the queue into the engine, and the one resumable session both
 * `import` and `rebase` run.
 *
 * A run replays patches index-only from a tree (`apply.ts`), checks that
 * the engine holds nothing the run would lose, and writes the resulting
 * states of the queue's paths into the engine. A patch that does not apply
 * pauses the session: the engine gets the state before that patch plus the
 * patch's fitting hunks and `.rej` files, and the session (a project state
 * section) records where it stopped and the tree before the failed patch.
 * After the user finishes the change in the engine, the patch is rewritten
 * from the engine against that tree, so its body is exactly its own work
 * even where other patches touch the same files, and the run continues.
 *
 * `import` replays exactly and writes a resolved patch at once. `rebase`
 * (after the engine has moved to a new pin) adds the reduced-context
 * ladder, rewrites every applied patch from the trees it produced, and
 * stamps them with the new pin, all in one queue transaction at the end;
 * until then the queue is untouched, so `--abort` only has to reset the
 * engine (after a recovery snapshot).
 *
 * Each settling of the engine (its files, the `.rej` files, the session and
 * the applied record) is one engine transaction, so an error, a signal or a
 * crash leaves the engine and the session as they were before it or after.
 */
import { affectedPaths, parsePatch } from '../diff/index.js';
import { cleanPaths, reset, saveRecoverySnapshot, status } from '../git/index.js';
import { defined, ExitCode, FireForgeError } from '../kernel/errors.js';
import { remove, resolveContained } from '../kernel/fs.js';
import { type Transaction, transaction } from '../kernel/journal.js';
import { info, warn } from '../kernel/log.js';
import { type Infer, s } from '../kernel/schema.js';
import { defineStateSection, type PatchProject, readState, updateState } from '../project/index.js';
import { applyWithRejects, replay, sparseTree, statesIn, type TreeState } from './apply.js';
import {
  engineHead,
  engineJournal,
  engineStates,
  forgetApplied,
  locate,
  projectQueue,
  readApplied,
  recordApplied,
  regeneratePatchBody,
  sameState,
  unaccountedPaths,
  writeStates,
} from './baseline.js';
import { type FirefoxStamp, firefoxStamp, sameStamp } from './manifest.js';
import {
  loadQueue,
  mutateQueue,
  pathsOf,
  type Queue,
  queueError,
  type QueuePatch,
  resolvePatch,
} from './queue.js';

const PATCH_STATUSES = [
  'pending',
  'applied-clean',
  'applied-fuzz',
  'failed',
  'resolved',
  'skipped',
] as const;

/** What happened to one patch in a session. */
export type SessionPatchStatus = (typeof PATCH_STATUSES)[number];

const sessionPatch = s.object({
  name: s.string({ min: 1 }),
  status: s.enum(PATCH_STATUSES),
  /** The tree after this patch. */
  tree: s.string().optional(),
  fuzz: s.int({ min: 1 }).optional(),
  replaced: s.array(s.string()).optional(),
  conflicts: s.array(s.string()).optional(),
  rejects: s.array(s.string()).optional(),
  message: s.string().optional(),
});

const sessionSchema = s
  .object({
    kind: s.enum(['import', 'rebase']),
    startedAt: s.string(),
    /** The engine commit the session applies to. */
    base: s.string(),
    /** The base cut down to the queue's paths. */
    start: s.string(),
    /** The tree after every patch before `index`. */
    tree: s.string(),
    /** The next patch to process; the failed one while paused. */
    index: s.int({ min: 0 }),
    /** The last patch to apply. */
    last: s.int({ min: -1 }),
    /** The stamp a rebase gives the patches it rewrites. */
    firefox: firefoxStamp.optional(),
    patches: s.array(sessionPatch),
  })
  .refine((session) =>
    session.index > session.last + 1 || session.last >= session.patches.length
      ? 'must keep index and last within the patch list'
      : undefined
  );

/** A queue session as stored in the project state. */
export type QueueSession = Infer<typeof sessionSchema>;
type SessionPatch = Infer<typeof sessionPatch>;

const REPAIR = 'fireforge reset';
const SESSION = defineStateSection('queueSession', sessionSchema, REPAIR);
/** The same section read without its schema, so a damaged session can still be cleared. */
const RAW_SESSION = defineStateSection('queueSession', s.unknown(), REPAIR);

/**
 * The paused or unfinished import or rebase, if any.
 *
 * @param project - A patch-mode project
 * @throws `state-invalid` (exit code 2) when the stored session is damaged
 */
export function readSession(project: PatchProject): Promise<QueueSession | undefined> {
  return readState(project, SESSION);
}

/** Stores the session (or, for undefined, forgets it) inside an engine transaction. */
async function storeSession(
  tx: Transaction,
  project: PatchProject,
  session: QueueSession | undefined
): Promise<void> {
  await tx.change([project.paths.state], async () => {
    if (session === undefined) await updateState(project, RAW_SESSION, () => undefined);
    else await updateState(project, SESSION, () => session);
  });
}

/** The `.rej` files a session's patches left, engine-relative. */
function rejectsOf(session: QueueSession | undefined): string[] {
  return (session?.patches ?? []).flatMap((entry) => entry.rejects ?? []);
}

/**
 * Forgets the session, damaged or not, and removes the `.rej` files it left.
 *
 * @param project - A patch-mode project
 */
export async function clearSession(project: PatchProject): Promise<void> {
  const session = await readSession(project).catch(() => undefined);
  for (const entry of session?.patches ?? []) await removeRejects(project, entry);
  await updateState(project, RAW_SESSION, () => undefined);
}

async function removeRejects(project: PatchProject, entry: SessionPatch): Promise<void> {
  for (const reject of entry.rejects ?? []) {
    await remove(await resolveContained(project.paths.engine, reject));
  }
}

/** One patch's outcome in a run. */
export interface RunPatch {
  readonly patch: string;
  readonly status: SessionPatchStatus;
  /** Context-reduction steps used, for `applied-fuzz`. */
  readonly fuzz?: number;
  /** Files the engine already had that a new-file section replaced. */
  readonly replaced?: readonly string[];
  /** For a patch that did not apply: the files git named, and why. */
  readonly conflicts?: readonly string[];
}

/** What an import or a rebase run did. */
export interface QueueRun {
  readonly patches: readonly RunPatch[];
  /** Engine paths written or removed. */
  readonly written: readonly string[];
}

function report(session: QueueSession, queue: Queue): RunPatch[] {
  const filenames = new Map(queue.patches.map((patch) => [patch.name, patch.filename]));
  return session.patches.slice(0, session.last + 1).map((entry) => ({
    patch: filenames.get(entry.name) ?? entry.name,
    status: entry.status,
    ...(entry.fuzz === undefined ? {} : { fuzz: entry.fuzz }),
    ...(entry.replaced === undefined ? {} : { replaced: entry.replaced }),
    ...(entry.conflicts === undefined ? {} : { conflicts: entry.conflicts }),
  }));
}

/**
 * The Firefox stamp of the project's pin, which a patch gets when it is
 * written from the engine.
 *
 * @param project - A patch-mode project
 */
export function stampOf(project: PatchProject): FirefoxStamp {
  return { product: project.config.firefox.product, version: project.config.firefox.version };
}

/**
 * Refuses to change the queue while an import or rebase is paused: the
 * session names patches and trees the change would invalidate.
 *
 * @param project - A patch-mode project
 * @param action - What was asked, for the message: "re-export"
 * @throws `session-active` (exit code 6)
 */
export async function requireNoSession(project: PatchProject, action: string): Promise<void> {
  const session = await readSession(project);
  if (session === undefined) return;
  throw new FireForgeError(
    'session-active',
    `An ${session.kind} is paused; ${action} has to wait.`,
    {
      exitCode: ExitCode.PATCH_ERROR,
      hint: `Finish it with "fireforge ${session.kind} --continue", or drop it with "${REPAIR}".`,
    }
  );
}

function unexportedError(paths: readonly string[], kind: QueueSession['kind']): FireForgeError {
  const shown = paths.slice(0, 20).map((path) => `  ${path}`);
  if (paths.length > shown.length) shown.push(`  … and ${paths.length - shown.length} more`);
  return queueError(
    'engine-unexported-edits',
    `The engine holds edits the ${kind} would overwrite:\n${shown.join('\n')}`,
    `Pass --force to overwrite them (a recovery snapshot keeps them), or drop them with ` +
      `"fireforge discard <path>". Only if they are edits you made and want in the queue, ` +
      `record them first with "fireforge re-export" (or "fireforge export" for files no patch ` +
      `changes).`
  );
}

function pausedError(
  session: QueueSession,
  patch: QueuePatch,
  conflicts: readonly string[]
): FireForgeError {
  const named = conflicts.length === 0 ? '' : `: ${conflicts.join('; ')}`;
  const next =
    session.kind === 'import'
      ? 'then run "fireforge resolve" to rewrite the patch, or "fireforge import --continue" to rewrite it and apply the rest.'
      : 'then run "fireforge rebase --continue", or "fireforge rebase --abort" to give up.';
  return new FireForgeError('patch-failed', `${patch.filename} does not apply${named}`, {
    exitCode: ExitCode.PATCH_ERROR,
    hint: `Finish the change in engine/ (hunks that did not fit are in .rej files), ${next}`,
  });
}

interface Settle {
  /** The tree whose states the queue's paths should end in. */
  target: string;
  /** The states each of the queue's paths may hold without anything being lost. */
  accepted: (path: string) => ReadonlyArray<TreeState | null>;
  force: boolean;
  /** `.rej` files an earlier pause left, engine-relative, to remove. */
  dropRejects?: readonly string[];
}

/**
 * Writes the run's result into the engine, as one engine transaction: the
 * queue's paths get the target states, paths an earlier queue wrote and this
 * one no longer touches go back to HEAD, and the session and the applied
 * record are stored. While paused on a failed patch, also leaves its fitting
 * hunks and `.rej` files, and then throws `patch-failed`. A finished import
 * forgets its session; a rebase keeps it for `finishRebase`.
 */
async function settle(
  project: PatchProject,
  queue: Queue,
  session: QueueSession,
  plan: Settle
): Promise<string[]> {
  const engine = project.paths.engine;
  const applied = await readApplied(project, session.base);
  const owned = pathsOf(queue.patches);
  const ownedSet = new Set(owned);
  const earlier = [...applied.keys()].filter((path) => !ownedSet.has(path));
  const paths = [...owned, ...earlier];
  const head = await statesIn(engine, session.base, paths);
  const current = await engineStates(engine, session.start, paths);
  const recorded = (path: string): Array<TreeState | null> =>
    applied.has(path) ? [applied.get(path) ?? null] : [];
  // An earlier queue's output still untouched goes back to HEAD; once edited, it is the user's.
  const behind = earlier.filter((path) =>
    recorded(path).some((state) => sameState(state, current.get(path)))
  );
  const target = new Map([
    ...(await statesIn(engine, plan.target, owned)),
    ...behind.map((path): [string, TreeState | null] => [path, head.get(path) ?? null]),
  ]);
  const unaccounted = unaccountedPaths(
    new Map(owned.map((path) => [path, current.get(path) ?? null])),
    (path) => [...plan.accepted(path), ...recorded(path)]
  );
  if (unaccounted.length > 0) {
    if (!plan.force) throw unexportedError(unaccounted, session.kind);
    const snapshot = await saveRecoverySnapshot(engine, {
      label: session.kind,
      paths: unaccounted,
    });
    if (snapshot !== undefined) warn(`Saved the overwritten edits as ${snapshot.ref}.`);
  }
  const entry = session.patches[session.index];
  const paused =
    entry?.status === 'failed' && session.index <= session.last
      ? queue.patches.find((candidate) => candidate.name === entry.name)
      : undefined;
  const written = await transaction(engineJournal(project), `the ${session.kind}`, async (tx) => {
    for (const reject of plan.dropRejects ?? []) {
      await tx.remove(await resolveContained(engine, reject));
    }
    const changed = await writeStates(tx, engine, target, current);
    if (paused !== undefined && entry !== undefined) {
      const touched = [...paused.files, ...paused.files.map((file) => `${file}.rej`)];
      let rejects: readonly string[] = [];
      await tx.change(
        await Promise.all(touched.map((path) => resolveContained(engine, path))),
        async () => {
          rejects = (await applyWithRejects(engine, paused)).rejects;
        }
      );
      session.patches[session.index] = { ...entry, rejects: [...rejects] };
    }
    const keep = session.kind === 'rebase' || paused !== undefined;
    await storeSession(tx, project, keep ? session : undefined);
    const edited = earlier.filter((path) => !behind.includes(path));
    await recordApplied(tx, project, {
      base: session.base,
      states: new Map([
        ...target,
        ...edited.map((path): [string, TreeState | null] => [path, head.get(path) ?? null]),
      ]),
      head,
    });
    return changed;
  });
  if (paused !== undefined) throw pausedError(session, paused, entry?.conflicts ?? []);
  return written;
}

/**
 * Replays the session's remaining patches from its tree and settles the
 * engine. Pauses (throws) at a patch that does not apply.
 */
async function advance(
  project: PatchProject,
  queue: Queue,
  session: QueueSession,
  options: { fuzz: boolean; force: boolean; dropRejects?: readonly string[] }
): Promise<string[]> {
  const byName = new Map(queue.patches.map((patch) => [patch.name, patch]));
  const todo: Array<{ index: number; patch: QueuePatch }> = [];
  for (let index = session.index; index <= session.last; index++) {
    const entry = session.patches[index];
    if (entry === undefined) continue;
    const patch = byName.get(entry.name);
    if (patch === undefined) session.patches[index] = { name: entry.name, status: 'skipped' };
    else todo.push({ index, patch });
  }
  const startTree = session.tree;
  // New-file sections may replace only what upstream has, not what earlier patches made.
  const result = await replay(
    project.paths.engine,
    startTree,
    todo.map((item) => item.patch),
    { fuzz: options.fuzz, upstream: session.start }
  );
  const later = new Map<string, Array<TreeState | null>>();
  for (const [position, step] of result.steps.entries()) {
    const item = todo[position];
    if (item === undefined) continue;
    session.patches[item.index] = {
      name: item.patch.name,
      status: step.fuzz > 0 ? 'applied-fuzz' : 'applied-clean',
      tree: step.tree,
      ...(step.fuzz > 0 ? { fuzz: step.fuzz } : {}),
      ...(step.replaced.length > 0 ? { replaced: [...step.replaced] } : {}),
    };
    for (const change of step.changes)
      later.set(change.path, [...(later.get(change.path) ?? []), change.state]);
  }
  const failure = result.failures[0];
  const failed = failure === undefined ? undefined : todo[failure.index];
  if (failure !== undefined && failed !== undefined) {
    session.patches[failed.index] = {
      name: failed.patch.name,
      status: 'failed',
      conflicts: failure.conflicts.map((conflict) => `${conflict.path}: ${conflict.reason}`),
      message: failure.message,
    };
  }
  session.tree = result.tree;
  session.index = failed?.index ?? session.last + 1;
  const before = await statesIn(project.paths.engine, startTree, pathsOf(queue.patches));
  return settle(project, queue, session, {
    target: result.tree,
    accepted: (path) => [before.get(path) ?? null, ...(later.get(path) ?? [])],
    force: options.force,
    ...(options.dropRejects === undefined ? {} : { dropRejects: options.dropRejects }),
  });
}

/**
 * Rewrites the failed patch of a paused session from the engine: the diff,
 * over the patch's files, from the tree before it to the engine's working
 * tree. Marks it resolved and moves the in-memory session past it; the
 * caller stores the session and removes the `.rej` files it returns.
 *
 * @returns The new body and the patch's `.rej` files, or undefined when the
 *   session is not paused on a failure
 */
async function resolveFailed(
  project: PatchProject,
  queue: Queue,
  session: QueueSession
): Promise<{ patch: QueuePatch; body: Buffer; rejects: string[] } | undefined> {
  const entry = session.patches[session.index];
  if (entry?.status !== 'failed') return undefined;
  const patch = queue.patches.find((candidate) => candidate.name === entry.name);
  if (patch === undefined) {
    throw new FireForgeError(
      'patch-not-found',
      `The paused patch ${entry.name} is no longer in the queue.`,
      {
        exitCode: ExitCode.PATCH_ERROR,
        hint: `Run "${REPAIR}" to drop the session, then start again.`,
      }
    );
  }
  const { body, after } = await regeneratePatchBody(project.paths.engine, {
    before: session.tree,
    paths: patch.files,
  });
  if (session.kind === 'import') {
    if (body.length === 0) {
      throw new FireForgeError(
        'resolve-empty',
        `The engine holds no change to the files of ${patch.filename}; there is nothing to record.`,
        {
          exitCode: ExitCode.RESOLUTION_ERROR,
          hint: 'Finish the change in engine/ first, or remove the patch from the queue.',
        }
      );
    }
    await mutateQueue(project, `the resolution of ${patch.filename}`, (draft) => {
      const row = draft.patches.find((candidate) => candidate.name === patch.name);
      if (row !== undefined) {
        row.body = body;
        row.firefox = stampOf(project);
      }
    });
  }
  session.patches[session.index] = { name: entry.name, status: 'resolved', tree: after };
  session.tree = after;
  session.index += 1;
  return { patch, body, rejects: entry.rejects ?? [] };
}

/** What {@link resolvePatchFromEngine} rewrote. */
export interface Resolution {
  /** The patch's filename. */
  readonly patch: string;
  /** The engine paths its new body touches. */
  readonly files: readonly string[];
}

/**
 * After a failed `import`: rewrites the failed patch from the engine, where
 * the user has finished the change, and records it as resolved. The rest of
 * the queue is applied by `import --continue`.
 *
 * @param project - A patch-mode project
 * @throws `no-session` when no import is paused on a failed patch
 */
export async function resolvePatchFromEngine(project: PatchProject): Promise<Resolution> {
  const session = await readSession(project);
  if (session !== undefined) await requireSameBase(project, session);
  if (session?.kind !== 'import' || session.patches[session.index]?.status !== 'failed') {
    throw new FireForgeError('no-session', 'No import is paused on a failed patch.', {
      exitCode: ExitCode.RESOLUTION_ERROR,
      hint:
        session?.kind === 'rebase'
          ? 'A rebase is paused; finish it with "fireforge rebase --continue".'
          : 'Run "fireforge import" first.',
    });
  }
  const resolved = defined(
    await resolveFailed(project, await loadQueue(project), session),
    'a session paused on a failed patch resolves it'
  );
  await transaction(engineJournal(project), 'the resolution', async (tx) => {
    for (const reject of resolved.rejects) {
      await tx.remove(await resolveContained(project.paths.engine, reject));
    }
    await storeSession(tx, project, session);
  });
  return {
    patch: resolved.patch.filename,
    files: affectedPaths(parsePatch(resolved.body)),
  };
}

/** Refuses to continue a session whose engine has moved to another commit since it started. */
async function requireSameBase(project: PatchProject, session: QueueSession): Promise<void> {
  if ((await engineHead(project)) === session.base) return;
  throw new FireForgeError(
    'session-stale',
    `engine/ is no longer at the commit the paused ${session.kind} started on.`,
    {
      exitCode: ExitCode.PATCH_ERROR,
      hint:
        session.kind === 'rebase'
          ? 'Run "fireforge rebase --abort" and start the rebase again.'
          : `Run "${REPAIR}" and import again.`,
    }
  );
}

function newSession(
  kind: QueueSession['kind'],
  queue: Queue,
  fields: { base: string; start: string; last: number; firefox?: FirefoxStamp }
): QueueSession {
  return {
    kind,
    startedAt: new Date().toISOString(),
    base: fields.base,
    start: fields.start,
    tree: fields.start,
    index: 0,
    last: fields.last,
    ...(fields.firefox === undefined ? {} : { firefox: fields.firefox }),
    patches: queue.patches.map((patch) => ({ name: patch.name, status: 'pending' as const })),
  };
}

/** How {@link importQueue} runs. */
export interface ImportOptions {
  /** Apply the queue only up to and including this patch (any identifier `resolvePatch` takes). */
  until?: string;
  /** Resume a paused import: rewrite the failed patch from the engine if needed, then apply the rest. */
  continue?: boolean;
  /** Overwrite unexported edits in the queue's files, after a recovery snapshot. */
  force?: boolean;
}

async function continueImport(project: PatchProject, force: boolean): Promise<QueueRun> {
  const session = await readSession(project);
  if (session?.kind !== 'import') {
    throw new FireForgeError('no-session', 'No import is paused.', {
      exitCode: ExitCode.PATCH_ERROR,
      hint:
        session?.kind === 'rebase'
          ? 'A rebase is paused; use "fireforge rebase --continue".'
          : 'Run "fireforge import".',
    });
  }
  await requireSameBase(project, session);
  const dropRejects = rejectsOf(session);
  const resolved = await resolveFailed(project, await loadQueue(project), session);
  if (resolved !== undefined) info(`Rewrote ${resolved.patch.filename} from the engine.`);
  const queue = await loadQueue(project);
  const written = await advance(project, queue, session, { fuzz: false, force, dropRejects });
  return { patches: report(session, queue), written };
}

/**
 * Applies the patch queue to the engine: every path the queue touches ends
 * holding what the queue (up to `until`) leaves there. Other engine edits
 * are kept. Edits in the queue's files that no patch accounts for stop the
 * import unless `force`.
 *
 * A patch that does not apply pauses the import (see the module comment)
 * and throws `patch-failed` (exit code 6).
 *
 * @param project - A patch-mode project
 * @param options - See {@link ImportOptions}
 */
export async function importQueue(
  project: PatchProject,
  options: ImportOptions = {}
): Promise<QueueRun> {
  const force = options.force === true;
  if (options.continue === true) return continueImport(project, force);
  const existing = await readSession(project);
  if (existing?.kind === 'rebase') {
    throw new FireForgeError('session-active', 'A rebase is paused.', {
      exitCode: ExitCode.PATCH_ERROR,
      hint: 'Finish it with "fireforge rebase --continue" or drop it with "fireforge rebase --abort".',
    });
  }
  const queue = await loadQueue(project);
  const pin = stampOf(project);
  const stale = queue.patches.filter((patch) => patch.firefox.version !== pin.version);
  if (stale.length > 0) {
    warn(
      `${stale.length} patch(es) were last verified against another Firefox than ${pin.version}; ` +
        'after a pin change, "fireforge rebase" brings the queue onto it.'
    );
  }
  const last =
    options.until === undefined
      ? queue.patches.length - 1
      : resolvePatch(queue, options.until).index;
  const projection = await projectQueue(project, queue);
  const failure =
    projection.failure !== undefined && projection.failure.index <= last
      ? projection.failure
      : undefined;
  const reached = failure?.index ?? last + 1;
  const session = newSession('import', queue, {
    base: projection.base,
    start: projection.start,
    last,
  });
  for (const [index, step] of projection.steps.slice(0, reached).entries()) {
    session.patches[index] = {
      name: queue.patches[index]?.name ?? '',
      status: 'applied-clean',
      tree: step.tree,
    };
  }
  if (failure !== undefined) {
    session.patches[failure.index] = {
      name: queue.patches[failure.index]?.name ?? '',
      status: 'failed',
      conflicts: failure.conflicts.map((conflict) => `${conflict.path}: ${conflict.reason}`),
      message: failure.message,
    };
  }
  session.tree = projection.treeBefore(reached);
  session.index = reached;
  const written = await settle(project, queue, session, {
    target: session.tree,
    accepted: (path) => projection.history(path).map((entry) => entry.state),
    force,
    dropRejects: rejectsOf(existing),
  });
  return { patches: report(session, queue), written };
}

/** How {@link rebaseQueue} runs. */
export interface RebaseOptions {
  /** Resume a paused rebase: rewrite the failed patch from the engine, then apply the rest. */
  continue?: boolean;
  /** Give up a paused rebase: reset the engine after a recovery snapshot and drop the session. */
  abort?: boolean;
  /** Replay the queue on the engine's HEAD in memory and report, changing nothing. */
  dryRun?: boolean;
  /** Start even though the engine holds edits the queue does not account for (a recovery snapshot keeps them). */
  force?: boolean;
}

/** What a rebase did. */
export interface RebaseResult extends QueueRun {
  readonly status: 'complete' | 'up-to-date' | 'dry-run' | 'aborted';
  /** Patches whose rewritten body is empty: upstream now holds their change. */
  readonly emptied: readonly string[];
}

async function finishRebase(
  project: PatchProject,
  session: QueueSession,
  written: readonly string[]
): Promise<RebaseResult> {
  const engine = project.paths.engine;
  const queue = await loadQueue(project);
  const byName = new Map(queue.patches.map((patch) => [patch.name, patch]));
  const bodies = new Map<string, Buffer>();
  let before = session.start;
  for (const entry of session.patches) {
    const patch = byName.get(entry.name);
    if (entry.tree === undefined || patch === undefined) continue;
    const { body } = await regeneratePatchBody(engine, {
      before,
      after: entry.tree,
      paths: patch.files,
    });
    bodies.set(patch.name, body);
    before = entry.tree;
  }
  const stamp = session.firefox ?? stampOf(project);
  await mutateQueue(project, 'the rebase', (draft) => {
    for (const row of draft.patches) {
      const body = bodies.get(row.name);
      if (body === undefined) continue;
      row.body = body;
      row.firefox = stamp;
    }
  });
  await clearSession(project);
  const emptied = queue.patches
    .filter((patch) => bodies.get(patch.name)?.length === 0)
    .map((patch) => patch.filename);
  for (const filename of emptied) warn(`${filename} is now empty: upstream holds its change.`);
  return { status: 'complete', patches: report(session, queue), written, emptied };
}

async function requireRebaseSession(project: PatchProject): Promise<QueueSession> {
  const session = await readSession(project);
  if (session?.kind !== 'rebase') {
    throw new FireForgeError('no-session', 'No rebase is paused.', {
      exitCode: ExitCode.PATCH_ERROR,
      hint:
        session?.kind === 'import'
          ? 'An import is paused; use "fireforge import --continue".'
          : 'Run "fireforge rebase".',
    });
  }
  return session;
}

/**
 * Resets the whole engine to its HEAD (tracked files restored, untracked
 * files removed, ignored files kept) after saving a recovery snapshot, as
 * one engine transaction that also forgets the applied record.
 *
 * @param project - A patch-mode project
 * @param label - What the reset is for, recorded in the snapshot
 * @returns The snapshot ref, or undefined when there was nothing to save
 */
export async function resetWorktree(
  project: PatchProject,
  label: string
): Promise<string | undefined> {
  const engine = project.paths.engine;
  const snapshot = await saveRecoverySnapshot(engine, { label });
  const changed = (await status(engine)).map((entry) => entry.path);
  await transaction(engineJournal(project), `the ${label}`, async (tx) => {
    const paths = await Promise.all(changed.map((path) => locate(engine, path)));
    await tx.change(paths, async () => {
      await reset(engine, 'HEAD', 'hard');
      await cleanPaths(engine);
    });
    await tx.change([project.paths.state], () => forgetApplied(project));
  });
  return snapshot?.ref;
}

/**
 * Refuses to start a rebase over engine edits the queue does not account
 * for: the rebase resets the engine. A path may hold its HEAD state, any
 * state the queue leaves it in on the engine's HEAD, or the state the last
 * engine write left it in.
 */
async function requireNothingToLose(project: PatchProject, queue: Queue): Promise<void> {
  const engine = project.paths.engine;
  const changed = (await status(engine)).map((entry) => entry.path);
  if (changed.length === 0) return;
  const projection = await projectQueue(project, queue);
  const owned = new Set(projection.paths);
  const applied = await readApplied(project, projection.base);
  const current = await engineStates(engine, projection.start, changed);
  const unaccounted = unaccountedPaths(current, (path) => [
    ...(owned.has(path) ? projection.history(path).map((entry) => entry.state) : []),
    ...(applied.has(path) ? [applied.get(path) ?? null] : []),
  ]);
  if (unaccounted.length > 0) throw unexportedError(unaccounted, 'rebase');
}

async function dryRunRebase(project: PatchProject, queue: Queue): Promise<RebaseResult> {
  const engine = project.paths.engine;
  const start = await sparseTree(engine, await engineHead(project), pathsOf(queue.patches));
  const result = await replay(engine, start, queue.patches, { fuzz: true, keepGoing: true });
  const failed = new Map(result.failures.map((failure) => [failure.index, failure]));
  const applied = [...result.steps];
  const patches = queue.patches.map((patch, index): RunPatch => {
    const failure = failed.get(index);
    if (failure !== undefined) {
      return {
        patch: patch.filename,
        status: 'failed',
        conflicts: failure.conflicts.map((conflict) => `${conflict.path}: ${conflict.reason}`),
      };
    }
    const step = applied.shift();
    const fuzz = step?.fuzz ?? 0;
    return {
      patch: patch.filename,
      status: fuzz > 0 ? 'applied-fuzz' : 'applied-clean',
      ...(fuzz > 0 ? { fuzz } : {}),
      ...(step !== undefined && step.replaced.length > 0 ? { replaced: step.replaced } : {}),
    };
  });
  return { status: 'dry-run', patches, written: [], emptied: [] };
}

/**
 * Moves the queue onto the engine's current HEAD, which the caller has
 * already brought to the new pin (`fireforge download` for the new
 * version). Each patch is applied with the reduced-context ladder; a patch
 * that does not apply pauses the rebase (throws `patch-failed`, exit code
 * 6) for the user to finish in the engine. Once every patch applies, all of
 * them are rewritten from the result and stamped with the configured pin in
 * one queue transaction.
 *
 * A fresh rebase resets the whole engine first, after a recovery snapshot.
 * It refuses an engine holding edits the queue does not account for unless
 * `force` is given.
 *
 * @param project - A patch-mode project
 * @param options - See {@link RebaseOptions}
 */
export async function rebaseQueue(
  project: PatchProject,
  options: RebaseOptions = {}
): Promise<RebaseResult> {
  const engine = project.paths.engine;
  if (options.abort === true) {
    const raw = await readState(project, RAW_SESSION);
    const stored = sessionSchema.validate(raw);
    if (raw === undefined || (stored.ok && stored.value.kind !== 'rebase')) {
      throw new FireForgeError('no-session', 'No rebase is paused.', {
        exitCode: ExitCode.PATCH_ERROR,
        hint: '"fireforge status" shows what the engine and the queue hold.',
      });
    }
    await resetWorktree(project, 'rebase-abort');
    await clearSession(project);
    return { status: 'aborted', patches: [], written: [], emptied: [] };
  }
  if (options.continue === true) {
    const session = await requireRebaseSession(project);
    await requireSameBase(project, session);
    let written: string[] = [];
    if (session.index <= session.last) {
      const dropRejects = rejectsOf(session);
      await resolveFailed(project, await loadQueue(project), session);
      written = await advance(project, await loadQueue(project), session, {
        fuzz: true,
        force: false,
        dropRejects,
      });
    }
    return finishRebase(project, session, written);
  }
  const existing = await readSession(project);
  if (existing !== undefined) {
    throw new FireForgeError('session-active', `An ${existing.kind} is paused.`, {
      exitCode: ExitCode.PATCH_ERROR,
      hint: `Finish it with "fireforge ${existing.kind} --continue", or drop it with "${REPAIR}".`,
    });
  }
  const queue = await loadQueue(project);
  if (queue.patches.length === 0) {
    throw new FireForgeError(
      'queue-empty',
      'The patch queue is empty; there is nothing to rebase.',
      {
        exitCode: ExitCode.PATCH_ERROR,
        hint: 'Capture a change with "fireforge export" first.',
      }
    );
  }
  const stamp = stampOf(project);
  if (queue.patches.every((patch) => sameStamp(patch.firefox, stamp))) {
    return { status: 'up-to-date', patches: [], written: [], emptied: [] };
  }
  if (options.dryRun === true) return dryRunRebase(project, queue);
  const base = await engineHead(project);
  if (options.force !== true) await requireNothingToLose(project, queue);
  await resetWorktree(project, 'rebase');
  const start = await sparseTree(engine, base, pathsOf(queue.patches));
  const session = newSession('rebase', queue, {
    base,
    start,
    last: queue.patches.length - 1,
    firefox: stamp,
  });
  const written = await advance(project, queue, session, { fuzz: true, force: true });
  return finishRebase(project, session, written);
}
