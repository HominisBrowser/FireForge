// SPDX-License-Identifier: EUPL-1.2
/**
 * Capturing engine edits into the queue: `export` records edits no patch
 * owns as a new patch, `re-export` rewrites existing patches from what the
 * engine holds now.
 *
 * Re-export and overlapping patches. When several patches change one file,
 * the engine holds the sum. An edit to that file (the engine differs from
 * what the queue leaves there) goes to the re-exported patch whose lines it
 * touches, when exactly one patch's lines are touched (`attribute.ts`), and
 * otherwise to the last re-exported patch that changes the file. That
 * patch's step is rewritten to end in the engine's content, and every other
 * patch keeps its step. A file still holding what the last import wrote is
 * behind the queue, not edited, and goes to no patch. When that
 * patch is not the last one changing the file, the later patches' sections
 * for it are first taken back out of the engine's content (applied in
 * reverse), so they still apply on top and the queue still ends in exactly
 * what the engine holds; when that is impossible (the edit touches lines a
 * later patch changes) the re-export is refused, naming the later patch to
 * re-export instead. A patch whose files hold no edit keeps its body byte
 * for byte, so re-exporting an unchanged engine changes nothing. A deleted
 * file is captured as a deletion; a file a patch created that the engine no
 * longer has leaves the patch.
 *
 * Every body comes from `regeneratePatchBody`.
 */
import { dirname } from 'node:path';

import { affectedPaths, parsePatch } from '../diff/index.js';
import { captureWorktree, writeTree } from '../git/index.js';
import { ExitCode, type FireForgeError } from '../kernel/errors.js';
import type { ChangeSet, PatchProject } from '../project/index.js';
import {
  applyToTree,
  covers,
  sparseTree,
  statesIn,
  type TreeState,
  unapplyFromTree,
} from './apply.js';
import { attributeEdits } from './attribute.js';
import {
  classifyEngine,
  type EnginePath,
  type Projection,
  projectQueue,
  readApplied,
  regeneratePatchBody,
  sameState,
} from './baseline.js';
import { queueChanges, requireApplies } from './changes.js';
import { categoryOf, sameStamp } from './manifest.js';
import { requireNewName, resolvePlacement } from './operations.js';
import { nextOrder, place, type Placement } from './placement.js';
import {
  loadQueue,
  mutateQueue,
  previewQueue,
  type Queue,
  type QueueDraft,
  queueError,
  type QueuePatch,
  selectPatches,
  slicePatch,
} from './queue.js';
import { requireNoSession, stampOf } from './session.js';

function usage(message: string): FireForgeError {
  return queueError('invalid-argument', message, undefined, ExitCode.INVALID_ARGUMENT);
}

/**
 * Runs a queue change, or with `dryRun` only previews it. Returns the queue
 * as written (or as it would be), and for a preview its owned changes.
 */
async function commit<T>(
  project: PatchProject,
  label: string,
  dryRun: boolean,
  edit: (draft: QueueDraft) => T
): Promise<{ result: T; queue: Queue; changes?: ChangeSet }> {
  if (!dryRun) {
    const result = await mutateQueue(project, label, edit);
    return { result, queue: await loadQueue(project) };
  }
  const preview = await previewQueue(project, label, edit);
  return { ...preview, changes: await queueChanges(project, preview.queue) };
}

/** How {@link exportPatch} creates the patch. */
export interface ExportOptions {
  /** Engine files or directories whose unowned edits to capture. */
  paths?: readonly string[];
  /** Capture every unowned edit in the engine. */
  all?: boolean;
  /** The new patch's name; its first word is the category. */
  name: string;
  description?: string;
  /** Place the patch at this order (default: after the last patch, inside its category's range). */
  order?: number;
  /** Place it right before this patch. */
  before?: string;
  /** Place it right after this patch. */
  after?: string;
  tier?: 'branding';
  /** Change nothing; return the would-be queue's owned changes for judging. */
  dryRun?: boolean;
}

/** What {@link exportPatch} created. */
export interface ExportResult {
  /** The new patch, as written (or as it would be written). */
  readonly patch: QueuePatch;
  /** The engine paths it captures. */
  readonly files: readonly string[];
  /** With `dryRun`: the queue with the new patch, as owned changes. */
  readonly changes?: ChangeSet;
}

function placementOf(options: ExportOptions): Placement | undefined {
  const given: Placement[] = [];
  if (options.order !== undefined) given.push({ order: options.order });
  if (options.before !== undefined) given.push({ before: options.before });
  if (options.after !== undefined) given.push({ after: options.after });
  if (given.length > 1) throw usage('Give at most one of order, before and after.');
  return given[0];
}

/**
 * The paths an export captures: every unowned edit the request covers. A
 * named path must cover one; a named file a patch changes is refused.
 */
function exportedPaths(paths: readonly string[], classified: readonly EnginePath[]): string[] {
  const files = classified
    .filter((entry) => entry.state === 'unmanaged')
    .map((entry) => entry.path);
  const owned = classified.filter((entry) => entry.owners.length > 0 && entry.state !== 'clean');
  for (const path of paths) {
    const ownedHere = owned.find((entry) => entry.path === path.replace(/\/+$/, ''));
    if (ownedHere !== undefined) {
      throw queueError(
        'export-owned',
        `${ownedHere.path} is already changed by ${ownedHere.owners.join(', ')}.`,
        `Record the edit there with "fireforge re-export ${ownedHere.owners.at(-1) ?? ''}".`
      );
    }
    if (!files.some((file) => covers(path, file))) {
      throw queueError(
        'export-nothing',
        `${path} holds no edit that no patch owns.`,
        owned.some((entry) => covers(path, entry.path))
          ? 'Its edited files belong to patches; "fireforge re-export" records the edits there.'
          : undefined
      );
    }
  }
  return files;
}

/**
 * Captures engine edits that no patch owns into a new patch: the diff of
 * the named paths (or of every unowned edit, with `all`) against the
 * pristine engine, stamped with the project's pin. A named file another
 * patch already changes is refused; under a named directory such files are
 * left out (they are `re-export`'s).
 *
 * The caller holds the engine lock (shared for a dry run). Linting is the
 * caller's: a dry run returns the would-be queue as owned changes, and the
 * real run writes exactly that queue.
 *
 * @param project - A patch-mode project with an engine
 * @param options - See {@link ExportOptions}
 * @throws `export-nothing` or `export-owned` (exit code 6); `patch-name-invalid` or `patch-exists` (exit code 8)
 */
export async function exportPatch(
  project: PatchProject,
  options: ExportOptions
): Promise<ExportResult> {
  const paths = options.paths ?? [];
  if ((options.all === true) === paths.length > 0) {
    throw usage('Name the paths to export, or export every unowned edit with "all".');
  }
  await requireNoSession(project, 'the export');
  const queue = await loadQueue(project);
  requireNewName(queue, options.name);
  const placement = placementOf(options);
  const resolved = placement === undefined ? undefined : resolvePlacement(queue, placement);
  const projection = await projectQueue(project, queue);
  const scope = options.all === true ? undefined : paths;
  const files = exportedPaths(paths, await classifyEngine(project, projection, scope));
  if (files.length === 0) throw queueError('export-nothing', 'The engine holds no unowned edit.');
  const engine = project.paths.engine;
  const before = await sparseTree(engine, projection.base, files);
  const { body } = await regeneratePatchBody(engine, { before, paths: files });
  const label = `the export of ${options.name}`;
  const done = await commit(project, label, options.dryRun === true, (draft) => {
    draft.patches.push({
      order: nextOrder(project.config.patchPolicy, draft, categoryOf(options.name)),
      name: options.name,
      description: options.description ?? '',
      firefox: stampOf(project),
      ...(options.tier === undefined ? {} : { tier: options.tier }),
      body,
    });
    if (resolved !== undefined) place(draft, options.name, resolved);
  });
  const patch = done.queue.patches.find((candidate) => candidate.name === options.name);
  if (patch === undefined) throw queueError('export-lost', `${options.name} was not written.`);
  return { patch, files, ...(done.changes === undefined ? {} : { changes: done.changes }) };
}

/** How {@link reExport} runs. */
export interface ReExportOptions {
  /** The patches to rewrite (anything `resolvePatch` takes). */
  patches?: readonly string[];
  /** Rewrite every patch. */
  all?: boolean;
  /** Adopt unowned edits in the directories a selected patch's files are in. */
  scan?: boolean;
  /** Change nothing; report, and return the would-be queue's owned changes. */
  dryRun?: boolean;
  /** Stamp the selected patches with the project's pin. */
  stamp?: boolean;
}

/** What {@link reExport} did to one selected patch. */
export interface ReExportedPatch {
  /** The patch's filename. */
  readonly patch: string;
  readonly status: 'rewritten' | 'unchanged';
  /** Files `scan` added to it. */
  readonly adopted: readonly string[];
  /** Files its body no longer touches: the engine holds what the patches before it leave there. */
  readonly dropped: readonly string[];
  /** Its stamp changed to the project's pin. */
  readonly stamped: boolean;
}

/** What {@link reExport} did. */
export interface ReExportResult {
  /** One per selected patch, in queue order. */
  readonly patches: readonly ReExportedPatch[];
  /** With `dryRun`: the queue as it would be, as owned changes. */
  readonly changes?: ChangeSet;
}

/**
 * The unowned edits `scan` adopts, by patch name: a changed path no patch
 * owns, in a directory one of a selected patch's files is in. A path two
 * selected patches could adopt goes to the later one.
 */
async function adoptions(
  project: PatchProject,
  projection: Projection,
  selected: readonly QueuePatch[]
): Promise<Map<string, string[]>> {
  const dirOf = (path: string): string => (dirname(path) === '.' ? '' : dirname(path));
  const dirs = [...new Set(selected.flatMap((patch) => patch.files.map(dirOf)))];
  const found = new Map<string, string[]>();
  for (const entry of await classifyEngine(project, projection, dirs)) {
    if (entry.state !== 'unmanaged') continue;
    const owner = [...selected]
      .reverse()
      .find((patch) => patch.files.some((file) => dirOf(file) === dirOf(entry.path)));
    if (owner !== undefined) found.set(owner.name, [...(found.get(owner.name) ?? []), entry.path]);
  }
  return found;
}

/** The engine's state of every path, the patch that takes each edit, and the state it takes. */
interface Takes {
  /** The patch each edited path goes to. */
  readonly takers: ReadonlyMap<string, QueuePatch>;
  /** The state each taker's step ends in for each path it takes. */
  readonly targets: ReadonlyMap<string, TreeState | null>;
  /** The state every path must end in once the queue is rewritten. */
  readonly expected: ReadonlyMap<string, TreeState | null>;
}

/**
 * Decides which selected patch takes each edit: the one whose lines it
 * touches (see `attribute.ts`), else the default candidate. A path still
 * holding what the last import wrote is behind the queue, not edited.
 */
async function assignEdits(
  project: PatchProject,
  queue: Queue,
  plan: { projection: Projection; start: string; paths: readonly string[] },
  choice: { candidates: ReadonlyMap<string, QueuePatch>; selected: readonly QueuePatch[] }
): Promise<Takes> {
  const engine = project.paths.engine;
  const { projection, start, paths } = plan;
  const worktree = await captureWorktree(engine, { base: start, paths });
  const now = await statesIn(engine, worktree, paths);
  const base = await statesIn(engine, start, paths);
  const applied = await readApplied(project, projection.base);
  const queued = new Set(projection.paths);
  const final = (path: string): TreeState | null =>
    queued.has(path) ? projection.final(path) : (base.get(path) ?? null);
  const edited = (path: string): boolean =>
    !sameState(now.get(path), final(path)) &&
    !(applied.has(path) && sameState(now.get(path), applied.get(path)));
  const takers = new Map([...choice.candidates].filter(([path]) => edited(path)));
  const attributed = await attributeEdits(
    engine,
    projection,
    new Map([...takers.keys()].map((path) => [path, now.get(path) ?? null]))
  );
  for (const [path, filename] of attributed) {
    const owner = choice.selected.find((patch) => patch.filename === filename);
    if (owner?.files.includes(path) === true) takers.set(path, owner);
  }
  let tree = worktree;
  for (const later of [...queue.patches].reverse()) {
    const back = later.files.filter((path) => (takers.get(path)?.index ?? Infinity) < later.index);
    if (back.length === 0) continue;
    const outcome = await unapplyFromTree(engine, tree, slicePatch(later, new Set(back), true));
    if (!outcome.applied) {
      const names = [...new Set(back.map((path) => takers.get(path)?.filename ?? ''))];
      throw queueError(
        're-export-overlap',
        `The edit to ${back.join(', ')} cannot go to ${names.join(', ')}: ${later.filename} changes the same lines after it.`,
        `Re-export ${later.filename} as well, so it can take the edit.`
      );
    }
    tree = outcome.tree;
  }
  const targets = await statesIn(engine, tree, [...takers.keys()]);
  const expected = new Map(
    paths.map((path) => [path, takers.has(path) ? (now.get(path) ?? null) : final(path)])
  );
  return { takers, targets, expected };
}

/**
 * The new bodies: the queue replayed from the pristine engine, each patch
 * that takes an edit rewritten from the tree before it to that tree with
 * its own step applied and the taken paths set to their targets.
 */
async function rewriteBodies(
  project: PatchProject,
  queue: Queue,
  start: string,
  takes: Takes,
  adopted: ReadonlyMap<string, readonly string[]>
): Promise<Map<string, Buffer>> {
  const engine = project.paths.engine;
  const bodies = new Map<string, Buffer>();
  let tree = start;
  for (const patch of queue.patches) {
    const outcome = await applyToTree(engine, tree, patch);
    if (!outcome.applied) {
      throw queueError(
        're-export-overlap',
        `${patch.filename} would no longer apply after the edits before it: ${outcome.message}`,
        `Re-export ${patch.filename} as well.`
      );
    }
    const taken = [...takes.takers].filter(([, taker]) => taker === patch).map(([path]) => path);
    if (taken.length === 0) {
      tree = outcome.tree;
      continue;
    }
    const after = await writeTree(
      engine,
      taken.map((path) => {
        const state = takes.targets.get(path) ?? null;
        return state === null
          ? { path, remove: true as const }
          : { path, oid: state.oid, mode: state.mode };
      }),
      outcome.tree
    );
    const files = [...new Set([...patch.files, ...(adopted.get(patch.name) ?? [])])].sort();
    const { body } = await regeneratePatchBody(engine, { before: tree, after, paths: files });
    if (body.length === 0) {
      throw queueError(
        're-export-empty',
        `${patch.filename} would be left with no change: the engine holds none of its edits.`,
        'Delete or retire it ("fireforge patch delete|retire"), or run "fireforge import" if the engine lost them.'
      );
    }
    bodies.set(patch.name, body);
    tree = after;
  }
  const result = await statesIn(engine, tree, [...takes.expected.keys()]);
  const off = [...takes.expected].filter(([path, state]) => !sameState(result.get(path), state));
  if (off.length > 0) {
    throw queueError(
      're-export-mismatch',
      `The rewritten queue would not reproduce the engine in ${off.map(([path]) => path).join(', ')}.`
    );
  }
  return bodies;
}

/**
 * Rewrites patches from what the engine holds now, so their edits since the
 * last export are recorded (see the module comment for how an edit to a
 * file several patches change is placed). With `scan`, unowned edits in the
 * selected patches' directories are adopted. Metadata is kept; `stamp`
 * restamps the selected patches with the project's pin.
 *
 * The caller holds the engine lock (shared for a dry run).
 *
 * @param project - A patch-mode project with an engine
 * @param options - See {@link ReExportOptions}
 * @throws `re-export-overlap`, `re-export-empty` or `queue-does-not-apply` (exit code 6)
 */
export async function reExport(
  project: PatchProject,
  options: ReExportOptions
): Promise<ReExportResult> {
  const named = options.patches ?? [];
  if ((options.all === true) === named.length > 0) {
    throw usage('Name the patches to re-export, or re-export every patch with "all".');
  }
  await requireNoSession(project, 'the re-export');
  const queue = await loadQueue(project);
  const selected = options.all === true ? [...queue.patches] : selectPatches(queue, named);
  const projection = await projectQueue(project, queue);
  requireApplies(projection);
  const adopted =
    options.scan === true
      ? await adoptions(project, projection, selected)
      : new Map<string, string[]>();
  const candidates = new Map<string, QueuePatch>();
  for (const patch of selected) for (const path of patch.files) candidates.set(path, patch);
  for (const patch of selected) {
    for (const path of adopted.get(patch.name) ?? []) candidates.set(path, patch);
  }
  const engine = project.paths.engine;
  const paths = [...new Set([...projection.paths, ...candidates.keys()])].sort();
  const start = await sparseTree(engine, projection.base, paths);
  const takes = await assignEdits(
    project,
    queue,
    { projection, start, paths },
    { candidates, selected }
  );
  const bodies = await rewriteBodies(project, queue, start, takes, adopted);
  const stamp = stampOf(project);
  const done = await commit(project, 'the re-export', options.dryRun === true, (draft) =>
    selected.map((patch): ReExportedPatch => {
      const row = draft.patches.find((candidate) => candidate.name === patch.name);
      const body = bodies.get(patch.name) ?? patch.body;
      const stamped = options.stamp === true && !sameStamp(patch.firefox, stamp);
      if (row !== undefined) {
        row.body = body;
        if (stamped) row.firefox = stamp;
      }
      const files = new Set(affectedPaths(parsePatch(body)));
      return {
        patch: patch.filename,
        status: body.equals(patch.body) ? 'unchanged' : 'rewritten',
        adopted: (adopted.get(patch.name) ?? []).filter((path) => files.has(path)),
        dropped: patch.files.filter((path) => !files.has(path)),
        stamped,
      };
    })
  );
  return { patches: done.result, ...(done.changes === undefined ? {} : { changes: done.changes }) };
}
