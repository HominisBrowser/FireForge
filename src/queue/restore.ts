// SPDX-License-Identifier: EUPL-1.2
/**
 * Throwing engine edits away: some paths back to the queue baseline
 * (`discard`), or the whole engine back to pristine (`reset`). Both save a
 * recovery snapshot of what they destroy first, and change the engine in
 * one engine transaction.
 */
import { relative, resolve } from 'node:path';

import { restorePaths, saveRecoverySnapshot, status } from '../git/index.js';
import { ExitCode } from '../kernel/errors.js';
import { exists, isInside, toPosixPath } from '../kernel/fs.js';
import { transaction } from '../kernel/journal.js';
import type { PatchProject } from '../project/index.js';
import { statesIn, type TreeState } from './apply.js';
import {
  classifyEngine,
  engineHead,
  engineJournal,
  type EngineState,
  engineStates,
  locate,
  projectQueue,
  pruneEmptyParents,
  recordApplied,
  writeStates,
} from './baseline.js';
import { loadQueue, queueError } from './queue.js';
import { clearSession, resetWorktree } from './session.js';

/** One path {@link discard} put back. */
export interface DiscardedPath {
  readonly path: string;
  /** What the path held: an edit, a queue file not applied or outdated, or an unmanaged edit. */
  readonly was: Exclude<EngineState, 'clean'>;
  /** `queue`: back to what the queue leaves there. `upstream`: back to HEAD, or removed. */
  readonly to: 'queue' | 'upstream';
  readonly owners: readonly string[];
}

/** What {@link discard} did. */
export interface DiscardResult {
  readonly paths: readonly DiscardedPath[];
  /** The recovery snapshot holding what was discarded. */
  readonly snapshot: string | undefined;
}

/**
 * Engine-relative paths for what the user named: absolute, relative to `cwd`
 * when the command runs inside the engine, and engine-relative otherwise.
 * The engine itself is the empty path.
 *
 * @param engine - The engine checkout
 * @param cwd - Where the command runs
 * @param paths - What the user typed
 * @throws `path-outside-engine` (exit code 8) for a path outside the engine
 */
export function enginePaths(engine: string, cwd: string, paths: readonly string[]): string[] {
  const base = isInside(engine, cwd) ? cwd : engine;
  return paths.map((path) => {
    const absolute = resolve(base, path);
    if (!isInside(engine, absolute)) {
      throw queueError(
        'path-outside-engine',
        `${path} is not inside ${engine}.`,
        'Name engine files or directories.',
        ExitCode.INVALID_ARGUMENT
      );
    }
    return toPosixPath(relative(engine, absolute));
  });
}

/**
 * Restores engine paths to the queue baseline: a path the queue touches gets
 * what the queue leaves there (re-created, rewritten or removed); any other
 * changed path goes back to HEAD, and an untracked one is deleted.
 * Directories cover every changed path below them; directories the discard
 * empties are removed.
 *
 * @param project - A patch-mode project
 * @param paths - Engine-relative paths (files or directories; `''` is the whole engine)
 */
export async function discard(
  project: PatchProject,
  paths: readonly string[]
): Promise<DiscardResult> {
  const engine = project.paths.engine;
  const head = await engineHead(project);
  const projection = await projectQueue(project, await loadQueue(project));
  const found = (await classifyEngine(project, projection, paths)).filter(
    (entry): entry is typeof entry & { state: Exclude<EngineState, 'clean'> } =>
      entry.state !== 'clean'
  );
  if (found.length === 0) return { paths: [], snapshot: undefined };
  const all = found.map((entry) => entry.path);
  const snapshot = await saveRecoverySnapshot(engine, { label: 'discard', paths: all });
  const owned = found.filter((entry) => entry.owners.length > 0).map((entry) => entry.path);
  const unowned = found.filter((entry) => entry.owners.length === 0).map((entry) => entry.path);
  const upstream = await statesIn(engine, head, all);
  const queued = new Map(owned.map((path) => [path, projection.final(path)]));
  const target = new Map<string, TreeState | null>([
    ...queued,
    ...unowned.map((path): [string, TreeState | null] => [path, upstream.get(path) ?? null]),
  ]);
  await transaction(engineJournal(project), 'the discard', async (tx) => {
    const absolute = await Promise.all(all.map((path) => locate(engine, path)));
    await tx.change(absolute, () => restorePaths(engine, all));
    await writeStates(tx, engine, queued, await engineStates(engine, projection.start, owned));
    for (const path of unowned) {
      if (upstream.get(path) !== null) continue;
      const file = await locate(engine, path);
      if (!(await exists(file))) continue;
      await tx.remove(file);
      await pruneEmptyParents(tx, engine, path);
    }
    await recordApplied(tx, project, { base: projection.base, states: target, head: upstream });
  });
  return {
    paths: found.map((entry) => ({
      path: entry.path,
      was: entry.state,
      to: entry.owners.length === 0 ? 'upstream' : 'queue',
      owners: entry.owners,
    })),
    snapshot: snapshot?.ref,
  };
}

/** What {@link resetEngine} did. */
export interface ResetResult {
  /** Whether the engine held any change. */
  readonly changed: boolean;
  /** The recovery snapshot holding the discarded state. */
  readonly snapshot: string | undefined;
}

/**
 * Resets the whole engine to pristine Firefox (its HEAD): tracked files
 * restored, untracked files removed, ignored files (build output) kept. A
 * paused import or rebase is dropped with it.
 *
 * @param project - A patch-mode project
 */
export async function resetEngine(project: PatchProject): Promise<ResetResult> {
  const engine = project.paths.engine;
  await engineHead(project);
  const changed = (await status(engine)).length > 0;
  const snapshot = await resetWorktree(project, 'reset');
  await clearSession(project);
  return { changed, snapshot };
}
