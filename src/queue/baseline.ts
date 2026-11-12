// SPDX-License-Identifier: EUPL-1.2
/**
 * The queue baseline: what every engine path holds when the queue is cleanly
 * applied, and how the engine's actual state compares with it.
 *
 * The projection is the queue replayed index-only onto the engine's HEAD
 * ({@link projectQueue}). It records, for every path the queue touches, the
 * state at the base and after each patch that changes it, so a path is
 * judged against every state the queue can leave it in, binary files
 * included (states are blob ids). It is cached under `.fireforge/` by queue
 * digest and base commit.
 *
 * The engine's state is read through a private index (`captureWorktree`),
 * so judging it never writes the engine's own index.
 *
 * Every write of engine files (import, rebase, discard, reset) is one
 * `kernel/journal` transaction on the engine journal, and records in the
 * project state the state it left each path in (the applied record). A path
 * still holding that state is not an edit: when the queue changes underneath
 * (a pulled patch, another branch of the project), the engine is merely
 * behind, and the next import brings it up to date.
 */
import { basename, dirname, join } from 'node:path';

import {
  captureWorktree,
  diffTrees,
  isRepository,
  readBlobs,
  resolveRevision,
  status,
} from '../git/index.js';
import { ExitCode, FireForgeError } from '../kernel/errors.js';
import { listDir, resolveContained, writeLink } from '../kernel/fs.js';
import type { Transaction } from '../kernel/journal.js';
import { readJsonIfExists, writeJson } from '../kernel/json.js';
import { verbose } from '../kernel/log.js';
import { type Infer, s } from '../kernel/schema.js';
import { defineStateSection, type PatchProject, readState, updateState } from '../project/index.js';
import {
  covers,
  replay,
  type ReplayFailure,
  type ReplayStep,
  sparseTree,
  statesIn,
  type TreeState,
} from './apply.js';
import { pathsOf, type Queue, queueError } from './queue.js';

/**
 * The engine's HEAD commit, the pristine Firefox the queue applies to.
 *
 * @param project - A patch-mode project
 * @throws `engine-missing` (exit code 2) when `engine/` is not a git checkout with a commit
 */
export async function engineHead(project: PatchProject): Promise<string> {
  const engine = project.paths.engine;
  const head = (await isRepository(engine))
    ? await resolveRevision(engine, 'HEAD', 'commit')
    : undefined;
  if (head === undefined) {
    throw new FireForgeError('engine-missing', `${engine} is not a Firefox checkout.`, {
      exitCode: ExitCode.CONFIG_ERROR,
      hint: 'Run "fireforge download" to fetch the pinned Firefox into engine/.',
    });
  }
  return head;
}

/** One state a path takes in a projection. */
export interface PathHistoryEntry {
  /** The patch that left this state, or undefined for the base. */
  readonly patch: string | undefined;
  readonly state: TreeState | null;
}

/** The queue replayed onto the engine's HEAD. */
export interface Projection {
  /** The commit the queue was replayed onto. */
  readonly base: string;
  readonly digest: string;
  /** The base commit cut down to the queue's paths. */
  readonly start: string;
  /** One per patch that applied, in queue order: a prefix of the queue. */
  readonly steps: readonly ReplayStep[];
  /** The first patch that did not apply, when the replay stopped early. */
  readonly failure: ReplayFailure | undefined;
  /** Every path some patch touches, sorted. */
  readonly paths: readonly string[];
  /** The tree after every patch before `index` (the start for 0). */
  treeBefore(index: number): string;
  /** The states a path takes: at the base, then after each patch that changes it. */
  history(path: string): readonly PathHistoryEntry[];
  /** The state after every patch that applied. */
  final(path: string): TreeState | null;
  /** The patches whose bodies touch a path, as filenames in apply order. */
  owners(path: string): readonly string[];
}

const stateSchema = s.object({ oid: s.string({ min: 1 }), mode: s.string({ min: 1 }) });

/** The state the last engine write left each path in, where that differs from HEAD. */
const appliedSchema = s.object({
  /** The engine commit the record belongs to. */
  base: s.string({ min: 1 }),
  states: s.record(s.union(stateSchema, s.literal(null))),
});
const APPLIED = defineStateSection('queueApplied', appliedSchema, 'fireforge reset');

/**
 * The engine journal: one transaction at a time changes engine files, under
 * the engine lock.
 *
 * @param project - A patch-mode project
 */
export function engineJournal(project: PatchProject): string {
  return join(project.paths.stateDir, 'engine.journal');
}

/**
 * The states the last engine write left paths in, for an engine still at
 * `base`. A path not listed holds (or was left at) its HEAD state.
 *
 * @param project - A patch-mode project
 * @param base - The engine's HEAD commit
 */
export async function readApplied(
  project: PatchProject,
  base: string
): Promise<ReadonlyMap<string, TreeState | null>> {
  const record = await readState(project, APPLIED);
  return new Map(record?.base === base ? Object.entries(record.states) : []);
}

/**
 * Records, inside the engine transaction, the states an engine write left
 * paths in. A path left at its HEAD state is dropped from the record.
 *
 * @param tx - The engine transaction
 * @param project - A patch-mode project
 * @param written - `base`, and for each path its new state and its HEAD state
 */
export async function recordApplied(
  tx: Transaction,
  project: PatchProject,
  written: {
    base: string;
    states: ReadonlyMap<string, TreeState | null>;
    head: ReadonlyMap<string, TreeState | null>;
  }
): Promise<void> {
  await tx.change([project.paths.state], async () => {
    await updateState(project, APPLIED, (record) => {
      const states = record?.base === written.base ? { ...record.states } : {};
      for (const [path, state] of written.states) {
        if (sameState(state, written.head.get(path))) Reflect.deleteProperty(states, path);
        else states[path] = state;
      }
      return Object.keys(states).length === 0 ? undefined : { base: written.base, states };
    });
  });
}

/**
 * Forgets paths from the applied record (every path, without `paths`): they
 * are no longer the queue's, and what they hold is the user's to keep or
 * export.
 *
 * @param project - A patch-mode project
 * @param paths - Engine paths; omitted, the whole record
 */
export async function forgetApplied(
  project: PatchProject,
  paths?: readonly string[]
): Promise<void> {
  await updateState(project, APPLIED, (record) => {
    if (record === undefined || paths === undefined) return undefined;
    const states = { ...record.states };
    for (const path of paths) Reflect.deleteProperty(states, path);
    return Object.keys(states).length === 0 ? undefined : { base: record.base, states };
  });
}

const cacheSchema = s.object({
  version: s.literal(1),
  digest: s.string(),
  base: s.string(),
  start: s.string(),
  baseStates: s.record(stateSchema),
  steps: s.array(
    s.object({
      patch: s.string(),
      tree: s.string(),
      fuzz: s.int({ min: 0 }),
      replaced: s.array(s.string()),
      changes: s.array(
        s.object({ path: s.string(), state: s.union(stateSchema, s.literal(null)) })
      ),
    })
  ),
  failure: s
    .object({
      index: s.int({ min: 0 }),
      patch: s.string(),
      conflicts: s.array(
        s.object({ path: s.string(), reason: s.string(), line: s.int().optional() })
      ),
      message: s.string(),
    })
    .optional(),
});
type ProjectionCache = Infer<typeof cacheSchema>;

function cachePath(project: PatchProject): string {
  return join(project.paths.stateDir, 'queue-projection.json');
}

function buildProjection(queue: Queue, cache: ProjectionCache): Projection {
  const owners = new Map<string, string[]>();
  for (const patch of queue.patches) {
    for (const path of patch.files) owners.set(path, [...(owners.get(path) ?? []), patch.filename]);
  }
  const histories = new Map<string, PathHistoryEntry[]>();
  for (const path of owners.keys()) {
    histories.set(path, [{ patch: undefined, state: cache.baseStates[path] ?? null }]);
  }
  for (const step of cache.steps) {
    for (const change of step.changes) {
      histories.get(change.path)?.push({ patch: step.patch, state: change.state });
    }
  }
  return {
    base: cache.base,
    digest: cache.digest,
    start: cache.start,
    steps: cache.steps,
    failure: cache.failure,
    paths: [...owners.keys()].sort(),
    treeBefore: (index) =>
      index === 0 ? cache.start : (cache.steps[index - 1]?.tree ?? cache.start),
    history: (path) => histories.get(path) ?? [{ patch: undefined, state: null }],
    final: (path) => histories.get(path)?.at(-1)?.state ?? null,
    owners: (path) => owners.get(path) ?? [],
  };
}

async function readCache(project: PatchProject): Promise<ProjectionCache | undefined> {
  try {
    return await readJsonIfExists(cachePath(project), cacheSchema);
  } catch (error: unknown) {
    verbose(`Ignoring an unreadable queue projection cache: ${String(error)}`);
    return undefined;
  }
}

/**
 * Replays the queue onto the engine's HEAD (exactly, no reduced context) and
 * records every state each path takes. Cached by queue digest and base.
 *
 * @param project - A patch-mode project
 * @param queue - The project's queue
 * @param options - `cache: false` leaves the cache as it is, for a queue
 *   that is not (yet) the stored one
 */
export async function projectQueue(
  project: PatchProject,
  queue: Queue,
  options: { cache?: boolean } = {}
): Promise<Projection> {
  const engine = project.paths.engine;
  const base = await engineHead(project);
  const cached = await readCache(project);
  if (
    cached?.digest === queue.digest &&
    cached.base === base &&
    (await resolveRevision(engine, cached.steps.at(-1)?.tree ?? cached.start, 'tree')) !== undefined
  ) {
    return buildProjection(queue, cached);
  }
  const paths = pathsOf(queue.patches);
  const start = await sparseTree(engine, base, paths);
  const result = await replay(engine, start, queue.patches);
  const baseStates: Record<string, TreeState> = {};
  for (const [path, state] of await statesIn(engine, start, paths)) {
    if (state !== null) baseStates[path] = state;
  }
  const failure = result.failures[0];
  const cache: ProjectionCache = {
    version: 1,
    digest: queue.digest,
    base,
    start,
    baseStates,
    steps: result.steps.map((step) => ({
      ...step,
      replaced: [...step.replaced],
      changes: [...step.changes],
    })),
    ...(failure === undefined
      ? {}
      : { failure: { ...failure, conflicts: [...failure.conflicts] } }),
  };
  if (options.cache !== false) await writeJson(cachePath(project), cache);
  return buildProjection(queue, cache);
}

/**
 * The engine's current state of each path, read through a private index.
 *
 * @param engine - The engine checkout
 * @param base - A tree holding the paths' expected states (a sparse tree)
 * @param paths - Engine paths
 */
export async function engineStates(
  engine: string,
  base: string,
  paths: readonly string[]
): Promise<Map<string, TreeState | null>> {
  if (paths.length === 0) return new Map();
  const tree = await captureWorktree(engine, { base, paths });
  return statesIn(engine, tree, paths);
}

/** Whether two path states are the same: both absent, or the same blob and mode. */
export function sameState(
  a: TreeState | null | undefined,
  b: TreeState | null | undefined
): boolean {
  return (a ?? null) === null ? (b ?? null) === null : a?.oid === b?.oid && a?.mode === b?.mode;
}

/**
 * How an engine path compares with the queue baseline:
 *  - `clean`: holds what the fully applied queue leaves there.
 *  - `unapplied`: holds the pristine state (absence included), and the queue changes it.
 *  - `outdated`: holds what the last import or rebase left there, and the
 *    queue has changed since (a pulled patch, a removed one). Not an edit;
 *    `import` brings it up to date.
 *  - `modified`: holds something else (an edit not exported yet).
 *  - `missing`: absent, where upstream has a file and the queue leaves one.
 *  - `unmanaged`: differs from HEAD, and no patch touches it.
 */
export type EngineState = 'clean' | 'unapplied' | 'outdated' | 'modified' | 'missing' | 'unmanaged';

/** One classified engine path. */
export interface EnginePath {
  readonly path: string;
  readonly state: EngineState;
  /** The patches touching the path, as filenames in apply order. Empty for `unmanaged`. */
  readonly owners: readonly string[];
}

function inScope(path: string, scope: readonly string[] | undefined): boolean {
  return scope === undefined || scope.some((root) => covers(root, path));
}

/**
 * Compares the engine with the queue baseline: every path the queue touches,
 * and every other path that differs from HEAD.
 *
 * @param project - A patch-mode project
 * @param projection - The queue's projection
 * @param scope - Limit to these engine paths (files or directories)
 * @returns One entry per path, sorted by path
 */
export async function classifyEngine(
  project: PatchProject,
  projection: Projection,
  scope?: readonly string[]
): Promise<EnginePath[]> {
  const engine = project.paths.engine;
  const applied = await readApplied(project, projection.base);
  const owned = projection.paths.filter((path) => inScope(path, scope));
  const ownedSet = new Set(projection.paths);
  const changed = (
    await status(engine, scope === undefined ? {} : { paths: scope.map((root) => root || '.') })
  )
    .map((entry) => entry.path)
    .filter((path) => !ownedSet.has(path));
  const current = await engineStates(engine, projection.start, [
    ...owned,
    ...changed.filter((path) => applied.has(path)),
  ]);
  const outdated = (path: string): boolean =>
    applied.has(path) && sameState(current.get(path), applied.get(path));
  const result: EnginePath[] = [];
  for (const path of owned) {
    const state = current.get(path) ?? null;
    const verdict: EngineState = sameState(state, projection.final(path))
      ? 'clean'
      : sameState(state, projection.history(path)[0]?.state)
        ? 'unapplied'
        : outdated(path)
          ? 'outdated'
          : state === null
            ? 'missing'
            : 'modified';
    result.push({ path, state: verdict, owners: projection.owners(path) });
  }
  for (const path of changed) {
    result.push({ path, state: outdated(path) ? 'outdated' : 'unmanaged', owners: [] });
  }
  return result.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The paths whose current state is none the queue can leave them in, given
 * what each path may hold.
 *
 * @param current - The engine's state of each path
 * @param accepted - The states each path may hold
 */
export function unaccountedPaths(
  current: ReadonlyMap<string, TreeState | null>,
  accepted: (path: string) => ReadonlyArray<TreeState | null>
): string[] {
  return [...current]
    .filter(([path, state]) => !accepted(path).some((candidate) => sameState(candidate, state)))
    .map(([path]) => path)
    .sort();
}

/** The permission bits a regular file of git mode `mode` gets, or 'symlink'. */
function writableMode(path: string, mode: string): number | 'symlink' {
  if (mode === '100755') return 0o755;
  if (mode === '100644') return 0o644;
  if (mode === '120000') return 'symlink';
  throw queueError(
    'queue-unsupported-mode',
    `${path} has git mode ${mode}; only files, executables and symlinks can be written into the engine.`
  );
}

/**
 * An engine path's absolute location, refusing one that leaves the engine
 * or passes through a symlink. The path itself may be a symlink: writes
 * replace it and the journal saves it as a link, never following it.
 *
 * @param engine - The engine checkout
 * @param path - Engine path
 */
export async function locate(engine: string, path: string): Promise<string> {
  const parent = dirname(path);
  return join(await resolveContained(engine, parent === '.' ? '' : parent), basename(path));
}

/**
 * Removes, inside the transaction, the directories above a removed path
 * that are now empty, up to the engine root.
 *
 * @param tx - The engine transaction
 * @param engine - The engine checkout
 * @param path - Engine path of what was removed
 */
export async function pruneEmptyParents(
  tx: Transaction,
  engine: string,
  path: string
): Promise<void> {
  const segments = path.split('/').slice(0, -1);
  while (segments.length > 0) {
    const directory = join(engine, ...segments);
    if ((await listDir(directory)).length > 0) return;
    await tx.remove(directory);
    segments.pop();
  }
}

/**
 * Writes target states into the engine inside a transaction: the blob's
 * bytes and mode, a symlink, or removal (pruning directories that empties).
 * Only paths whose current state differs are touched. Every mode, location
 * and blob is checked before the first write, so a refusal changes nothing.
 *
 * @param tx - The engine transaction
 * @param engine - The engine checkout
 * @param target - The state each path should hold
 * @param current - The state each path holds now
 * @returns The paths written or removed, sorted
 */
export async function writeStates(
  tx: Transaction,
  engine: string,
  target: ReadonlyMap<string, TreeState | null>,
  current: ReadonlyMap<string, TreeState | null>
): Promise<string[]> {
  const changed = [...target]
    .filter(([path, state]) => !sameState(state, current.get(path)))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const blobs = await readBlobs(
    engine,
    changed.flatMap(([, state]) => (state === null ? [] : [state.oid]))
  );
  const plan: Array<{
    path: string;
    absolute: string;
    write: { mode: number | 'symlink'; bytes: Buffer } | undefined;
  }> = [];
  for (const [path, state] of changed) {
    const absolute = await locate(engine, path);
    if (state === null) {
      plan.push({ path, absolute, write: undefined });
      continue;
    }
    const mode = writableMode(path, state.mode);
    const bytes = blobs.get(state.oid);
    if (bytes === undefined) {
      throw new FireForgeError(
        'queue-blob-missing',
        `Blob ${state.oid} for ${path} is missing from the engine.`,
        {
          exitCode: ExitCode.GIT_ERROR,
          hint: 'Run the command again; the queue projection will be recomputed.',
        }
      );
    }
    plan.push({ path, absolute, write: { mode, bytes } });
  }
  for (const { path, absolute, write } of plan) {
    if (write === undefined) {
      await tx.remove(absolute);
      await pruneEmptyParents(tx, engine, path);
    } else if (write.mode === 'symlink') {
      await tx.change([absolute], () => writeLink(absolute, write.bytes.toString('utf8')));
    } else {
      await tx.write(absolute, write.bytes, { mode: write.mode });
    }
  }
  return changed.map(([path]) => path);
}

/**
 * The one way a patch body is produced from an engine: the diff, in the
 * pinned format (`git/diff.ts`), between the state before the patch and the
 * state after it, limited to `paths`. Deleted files, binary files and file
 * modes survive; renames are a deletion and an addition.
 *
 * @param engine - The engine checkout
 * @param options - `before`: a tree holding the paths' states before the
 *   patch. `after`: a tree holding them after; default the working tree,
 *   captured through a private index. `paths`: the paths the body covers
 * @returns The body and the tree it was taken from
 */
export async function regeneratePatchBody(
  engine: string,
  options: { before: string; after?: string; paths: readonly string[] }
): Promise<{ body: Buffer; after: string }> {
  const after =
    options.after ??
    (await captureWorktree(engine, { base: options.before, paths: options.paths }));
  const body =
    options.paths.length === 0
      ? Buffer.alloc(0)
      : await diffTrees(engine, options.before, after, { paths: options.paths });
  return { body, after };
}
