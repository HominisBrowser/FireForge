// SPDX-License-Identifier: EUPL-1.2
/**
 * Applying a patch to an engine: the one place that does it.
 *
 * Patches are applied to trees, index-only, never to a working tree
 * directly: {@link applyToTree} runs `git apply --cached` on a private index
 * seeded from a tree and returns the resulting tree. A queue is replayed by
 * chaining that ({@link replay}); what the engine should hold is then written
 * out from the final tree by the baseline module. The working tree is
 * patched in place only to leave a failed patch's fitting hunks and `.rej`
 * files for the user ({@link applyWithRejects}).
 *
 * Replays run on sparse trees ({@link sparseTree}): the base commit cut down
 * to the paths the queue touches. `git apply --cached` reads and writes the
 * whole index once per patch, so on a Firefox-sized tree a full index would
 * cost a fraction of a second per patch; a sparse one costs almost nothing,
 * and a path outside the queue cannot change.
 *
 * Policy:
 *  - Exact first. With `fuzz`, then reduced context: `-C2`, `-C1`, `-C0`
 *    (git has no fuzz factor; `-C<n>` matches only n lines of context).
 *  - A section creating a file the tree already has from upstream (the
 *    caller says which paths those are) replaces that file: the path is
 *    dropped from the tree and the patch applied again. A file an earlier
 *    patch created or changed is never replaced. A `Binary files … differ`
 *    section carries no content and is refused.
 *  - A path outside the engine (absolute, `..`, inside `.git`) is refused,
 *    and the working-tree apply refuses a path through a symlink.
 */
import type { FileDiff, Patch } from '../diff/index.js';
import { apply, type ApplyConflict, emptyTree, listTree, writeTree } from '../git/index.js';
import { ExitCode, FireForgeError } from '../kernel/errors.js';
import { resolveContained } from '../kernel/fs.js';
import { pathsOf, readQueue } from './queue.js';

/** What applying needs of a patch. */
export interface ApplicablePatch {
  readonly filename: string;
  readonly body: Uint8Array;
  readonly diff: Patch;
}

/** A path's entry in a tree: its blob and mode. */
export interface TreeState {
  readonly oid: string;
  readonly mode: string;
}

/** A patch that applied to a tree. */
export interface TreeApplied {
  readonly applied: true;
  /** The resulting tree. */
  readonly tree: string;
  /** Context-reduction steps used: 0 exact, k means `-C(3-k)`. */
  readonly fuzz: number;
  /** Paths the tree already had that a new-file section replaced. */
  readonly replaced: readonly string[];
}

/** A patch that did not apply. */
export interface ApplyRefused {
  readonly applied: false;
  /** The files git (or the path checks) named. */
  readonly conflicts: readonly ApplyConflict[];
  /** The explanation, from the exact attempt. */
  readonly message: string;
}

/** The outcome of {@link applyToTree}. */
export type TreeApplyOutcome = TreeApplied | ApplyRefused;

/** `-C` values after the exact attempt: git's default context is three lines. */
const REDUCED_CONTEXT = [2, 1, 0] as const;

/**
 * Whether engine path `path` is `root` or lies under it. The empty root
 * covers every path.
 *
 * @param root - An engine file or directory, a trailing slash allowed
 * @param path - An engine path
 */
export function covers(root: string, path: string): boolean {
  const prefix = root.replace(/\/+$/, '');
  return prefix === '' || path === prefix || path.startsWith(`${prefix}/`);
}

/** Why an engine path in a patch is unsafe to write, or undefined. */
function unsafePath(path: string): string | undefined {
  if (path === '' || path.includes('\0') || path.includes('\\')) return 'is not a valid path';
  if (path.startsWith('/')) return 'is absolute';
  const segments = path.split('/');
  if (segments.some((segment) => segment === '..' || segment === '.' || segment === '')) {
    return 'leaves the engine or is not canonical';
  }
  return segments[0]?.toLowerCase() === '.git' ? 'is inside .git' : undefined;
}

/** Path and content problems that make a patch unappliable before git sees it. */
export function patchProblems(diff: Patch): ApplyConflict[] {
  const problems: ApplyConflict[] = [];
  if (diff.files.length === 0 && diff.preamble.some((line) => line.trim() !== '')) {
    problems.push({ path: '', reason: 'the body holds text but no diff section' });
  }
  for (const file of diff.files) {
    for (const path of new Set([file.oldPath, file.newPath])) {
      const why = unsafePath(path);
      if (why !== undefined) problems.push({ path, reason: `path ${why}` });
    }
    if (file.binary === 'stub') {
      problems.push({
        path: file.path,
        reason: 'binary section carries no content ("Binary files … differ"); re-export the patch',
      });
    }
  }
  return problems;
}

function refused(conflicts: readonly ApplyConflict[], message: string): ApplyRefused {
  return { applied: false, conflicts, message };
}

async function ladder(
  repo: string,
  tree: string,
  body: Uint8Array,
  fuzz: boolean
): Promise<{ tree: string; fuzz: number } | { conflicts: ApplyConflict[]; message: string }> {
  const exact = await apply(repo, body, { target: { tree } });
  if (exact.applied && exact.tree !== undefined) return { tree: exact.tree, fuzz: 0 };
  if (fuzz) {
    for (const [step, context] of REDUCED_CONTEXT.entries()) {
      const reduced = await apply(repo, body, { target: { tree }, context });
      if (reduced.applied && reduced.tree !== undefined) {
        return { tree: reduced.tree, fuzz: step + 1 };
      }
    }
  }
  return { conflicts: exact.conflicts, message: exact.stderr.trim() };
}

/** New-file sections whose target the tree already holds from upstream. */
function occupiedNewFiles(
  diff: Patch,
  conflicts: readonly ApplyConflict[],
  replaceable: ReadonlySet<string>
): FileDiff[] {
  const occupied = new Set(
    conflicts.filter((conflict) => conflict.reason.startsWith('already exists')).map((c) => c.path)
  );
  const sections = diff.files.filter((file) => file.status === 'added' && occupied.has(file.path));
  return sections.every((file) => replaceable.has(file.path)) ? sections : [];
}

/**
 * Applies a patch to a tree, index-only. Nothing in the repository's index
 * or working tree moves.
 *
 * @param repo - The repository holding the tree and the blobs the patch needs
 * @param tree - The tree to apply to
 * @param patch - The patch
 * @param options - `fuzz` allows reduced context after the exact attempt;
 *   `replaceable` names the paths holding upstream content that a new-file
 *   section may replace
 */
export async function applyToTree(
  repo: string,
  tree: string,
  patch: ApplicablePatch,
  options: { fuzz?: boolean; replaceable?: ReadonlySet<string> } = {}
): Promise<TreeApplyOutcome> {
  const problems = patchProblems(patch.diff);
  if (problems.length > 0) {
    return refused(
      problems,
      problems.map((problem) => `${problem.path}: ${problem.reason}`).join('\n')
    );
  }
  const fuzz = options.fuzz === true;
  const first = await ladder(repo, tree, patch.body, fuzz);
  if ('tree' in first) return { applied: true, ...first, replaced: [] };
  const occupied = occupiedNewFiles(patch.diff, first.conflicts, options.replaceable ?? new Set());
  if (occupied.length === 0) return refused(first.conflicts, first.message);
  const cleared = await writeTree(
    repo,
    occupied.map((file) => ({ path: file.path, remove: true as const })),
    tree
  );
  const second = await ladder(repo, cleared, patch.body, fuzz);
  if (!('tree' in second)) return refused(first.conflicts, first.message);
  return { applied: true, ...second, replaced: occupied.map((file) => file.path) };
}

/**
 * Takes a patch back out of a tree, index-only and exactly: the tree the
 * patch, applied, would turn into `tree`.
 *
 * @param repo - The repository holding the tree
 * @param tree - A tree holding the patch's result
 * @param patch - The patch
 */
export async function unapplyFromTree(
  repo: string,
  tree: string,
  patch: ApplicablePatch
): Promise<TreeApplyOutcome> {
  const problems = patchProblems(patch.diff);
  if (problems.length > 0) {
    return refused(
      problems,
      problems.map((problem) => `${problem.path}: ${problem.reason}`).join('\n')
    );
  }
  const result = await apply(repo, patch.body, { target: { tree }, reverse: true });
  return result.applied && result.tree !== undefined
    ? { applied: true, tree: result.tree, fuzz: 0, replaced: [] }
    : refused(result.conflicts, result.stderr.trim());
}

/** What {@link applyWithRejects} left in the working tree. */
export interface RejectOutcome {
  /** Every hunk applied after all. */
  readonly applied: boolean;
  /** `.rej` files written, engine-relative. */
  readonly rejects: readonly string[];
  readonly conflicts: readonly ApplyConflict[];
  readonly message: string;
}

/**
 * Applies the hunks of a patch that fit to the working tree and leaves the
 * rest in `<file>.rej` files, for the user to finish by hand.
 *
 * @param engine - The engine checkout
 * @param patch - The patch that did not apply to a tree
 * @throws `path-escape` (exit code 8) when a path leaves the engine or passes through a symlink
 */
export async function applyWithRejects(
  engine: string,
  patch: ApplicablePatch
): Promise<RejectOutcome> {
  const problems = patchProblems(patch.diff);
  if (problems.length > 0) {
    return {
      applied: false,
      rejects: [],
      conflicts: problems,
      message: problems.map((problem) => `${problem.path}: ${problem.reason}`).join('\n'),
    };
  }
  for (const file of patch.diff.files) {
    for (const path of new Set([file.oldPath, file.newPath])) await resolveContained(engine, path);
  }
  const result = await apply(engine, patch.body, { reject: true });
  return {
    applied: result.applied,
    rejects: result.rejected.map((path) => `${path}.rej`),
    conflicts: result.conflicts,
    message: result.stderr.trim(),
  };
}

/**
 * The tree of `commit` cut down to `paths`: the starting point of a replay.
 *
 * @param repo - The repository
 * @param commit - A commit or tree
 * @param paths - Engine paths; directories are not expected
 */
export async function sparseTree(
  repo: string,
  commit: string,
  paths: readonly string[]
): Promise<string> {
  if (paths.length === 0) return emptyTree(repo);
  const entries = await listTree(repo, commit, { paths });
  return writeTree(
    repo,
    entries
      .filter((entry) => entry.type === 'blob')
      .map((entry) => ({ path: entry.path, oid: entry.oid, mode: entry.mode }))
  );
}

/**
 * The state of each path in a tree; a path the tree lacks maps to null.
 *
 * @param repo - The repository
 * @param tree - The tree
 * @param paths - The paths to look up
 */
export async function statesIn(
  repo: string,
  tree: string,
  paths: readonly string[]
): Promise<Map<string, TreeState | null>> {
  const states = new Map<string, TreeState | null>(paths.map((path) => [path, null]));
  if (paths.length === 0) return states;
  for (const entry of await listTree(repo, tree, { paths })) {
    if (entry.type === 'blob' && states.has(entry.path)) {
      states.set(entry.path, { oid: entry.oid, mode: entry.mode });
    }
  }
  return states;
}

/** One patch a replay applied. */
export interface ReplayStep {
  readonly patch: string;
  /** The tree after this patch. */
  readonly tree: string;
  readonly fuzz: number;
  readonly replaced: readonly string[];
  /** What the patch did to each path it changed: the path's new state, or null when removed. */
  readonly changes: ReadonlyArray<{ path: string; state: TreeState | null }>;
}

/** A patch a replay could not apply. */
export interface ReplayFailure {
  /** Position of the patch in the list replayed. */
  readonly index: number;
  readonly patch: string;
  readonly conflicts: readonly ApplyConflict[];
  readonly message: string;
}

/** The result of {@link replay}. */
export interface ReplayResult {
  /** One per patch that applied, in order. */
  readonly steps: readonly ReplayStep[];
  /** The patches that did not apply. Without `keepGoing`, at most one: the replay stopped there. */
  readonly failures: readonly ReplayFailure[];
  /** The tree after the last patch that applied. */
  readonly tree: string;
}

/**
 * Applies patches in order, each to the tree the previous one produced.
 *
 * @param repo - The repository
 * @param start - The tree to start from (see {@link sparseTree})
 * @param patches - The patches, in apply order
 * @param options - `fuzz` allows reduced context; `keepGoing` continues past
 *   a patch that does not apply, from the tree before it, so later verdicts
 *   are still reported (and may follow from the earlier failure); `upstream`
 *   is the tree holding the upstream files a new-file section may replace,
 *   when `start` already holds earlier patches' work (default `start`)
 */
export async function replay(
  repo: string,
  start: string,
  patches: readonly (ApplicablePatch & { readonly files: readonly string[] })[],
  options: { fuzz?: boolean; keepGoing?: boolean; upstream?: string } = {}
): Promise<ReplayResult> {
  const allPaths = pathsOf(patches);
  const current = await statesIn(repo, start, allPaths);
  const upstream =
    options.upstream === undefined || options.upstream === start
      ? new Map(current)
      : await statesIn(repo, options.upstream, allPaths);
  const steps: ReplayStep[] = [];
  const failures: ReplayFailure[] = [];
  let tree = start;
  for (const [index, patch] of patches.entries()) {
    const replaceable = new Set(
      patch.files.filter((path) => {
        const state = upstream.get(path) ?? null;
        const now = current.get(path) ?? null;
        return state !== null && now?.oid === state.oid && now.mode === state.mode;
      })
    );
    const outcome = await applyToTree(repo, tree, patch, {
      fuzz: options.fuzz === true,
      replaceable,
    });
    if (!outcome.applied) {
      failures.push({
        index,
        patch: patch.filename,
        conflicts: outcome.conflicts,
        message: outcome.message,
      });
      if (options.keepGoing === true) continue;
      break;
    }
    const after = await statesIn(repo, outcome.tree, patch.files);
    const changes: Array<{ path: string; state: TreeState | null }> = [];
    for (const [path, state] of after) {
      const before = current.get(path) ?? null;
      if (before?.oid !== state?.oid || before?.mode !== state?.mode) {
        changes.push({ path, state });
        current.set(path, state);
      }
    }
    steps.push({
      patch: patch.filename,
      tree: outcome.tree,
      fuzz: outcome.fuzz,
      replaced: outcome.replaced,
      changes,
    });
    tree = outcome.tree;
  }
  return { steps, failures, tree };
}

/**
 * Applies the queue stored in a directory onto a commit, index-only, and
 * returns the resulting full tree: what an engine at that commit holds once
 * the queue is applied. Independent of any project.
 *
 * @param repo - A repository holding the commit (a pristine repository)
 * @param commit - The commit to apply onto
 * @param queueDir - A queue directory (manifest and patch files)
 * @returns The tree's id
 * @throws `queue-does-not-apply` (exit code 6) naming the first patch that does not apply
 */
export async function replayQueue(repo: string, commit: string, queueDir: string): Promise<string> {
  const queue = await readQueue(queueDir);
  const paths = pathsOf(queue.patches);
  const result = await replay(repo, await sparseTree(repo, commit, paths), queue.patches);
  const failure = result.failures[0];
  if (failure !== undefined) {
    throw new FireForgeError(
      'queue-does-not-apply',
      `${failure.patch} does not apply to ${commit}: ${failure.message}`,
      {
        exitCode: ExitCode.PATCH_ERROR,
        hint: 'Run "fireforge import", fix the engine where it stops, then "fireforge resolve".',
      }
    );
  }
  const states = await statesIn(repo, result.tree, paths);
  return writeTree(
    repo,
    [...states].map(([path, state]) =>
      state === null ? { path, remove: true as const } : { path, oid: state.oid, mode: state.mode }
    ),
    commit
  );
}
