// SPDX-License-Identifier: EUPL-1.2
/**
 * Queue operations: renaming, reordering and splitting patches, moving
 * files between them, removing and retiring them, closing gaps in the
 * numbering, and editing a patch's metadata. Each is one {@link mutateQueue}
 * transaction over the manifest rows, so a failure leaves the queue as it
 * was and filenames follow the rows by themselves.
 *
 * Operations that move work between patches or change the apply order
 * (reorder, split, move-files) must leave what the queue produces exactly as
 * it was. Inside the transaction the new queue is replayed beside the old
 * one, and the state each path ends in must be the same blob; otherwise
 * (two patches that change the same lines swapped, a moved change that no
 * longer fits where it lands) the operation is refused and nothing is
 * written. Removing a patch must leave every other patch applying.
 */
import { defined, ExitCode, type FireForgeError } from '../kernel/errors.js';
import type { PatchProject } from '../project/index.js';
import {
  type ApplicablePatch,
  applyToTree,
  covers,
  replay,
  sparseTree,
  statesIn,
} from './apply.js';
import { engineHead, forgetApplied, regeneratePatchBody, sameState } from './baseline.js';
import {
  isPatchName,
  type LintIgnoreEntry,
  type PatchEntry,
  patchFilename,
  type StagedDependency,
} from './manifest.js';
import { compactOrders, place, type Placement } from './placement.js';
import {
  type DraftPatch,
  entryOf,
  mutateQueue,
  pathsOf,
  type Queue,
  type QueueDraft,
  queueError,
  queueOfDraft,
  type QueuePatch,
  resolvePatch,
  slicePatch,
} from './queue.js';
import { requireNoSession } from './session.js';

/** What a queue operation changed, by patch filename. */
export interface QueueEdit {
  /** Patches whose filename changed: renamed or renumbered. */
  readonly renamed: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  readonly created: readonly string[];
  readonly removed: readonly string[];
  /** Patches (by their new filename) whose body changed. */
  readonly rewritten: readonly string[];
}

/** A removed patch: the queue edit, and the engine files it touched, which no patch owns now. */
export interface Removal extends QueueEdit {
  readonly files: readonly string[];
}

/** A refusal of what was asked (exit code 8). */
function usage(code: string, message: string, hint?: string): FireForgeError {
  return queueError(code, message, hint, ExitCode.INVALID_ARGUMENT);
}

/**
 * Refuses a name that is not a valid patch name or that a patch already has.
 *
 * @param queue - The queue
 * @param name - The candidate
 * @throws `patch-name-invalid` or `patch-exists` (exit code 8)
 */
export function requireNewName(queue: Queue, name: string): void {
  if (!isPatchName(name)) {
    throw usage(
      'patch-name-invalid',
      `"${name}" is not a patch name.`,
      'A patch name is lowercase words joined by hyphens, the first word its category: "ui-sidebar".'
    );
  }
  const holder = queue.patches.find((patch) => patch.name === name);
  if (holder !== undefined) {
    throw usage('patch-exists', `A patch is already named ${name} (${holder.filename}).`);
  }
}

function rowOf(draft: QueueDraft, name: string): DraftPatch {
  const row = draft.patches.find((candidate) => candidate.name === name);
  if (row === undefined) throw queueError('patch-not-found', `${name} left the queue.`);
  return row;
}

/**
 * Runs `edit` as one queue transaction and reports what it changed, by
 * comparing the draft rows before and after.
 */
async function operate(
  project: PatchProject,
  label: string,
  edit: (draft: QueueDraft, queue: Queue) => void | Promise<void>
): Promise<QueueEdit> {
  await requireNoSession(project, label);
  return mutateQueue(project, label, async (draft, queue) => {
    const before = new Map(
      draft.patches.map((row) => [row, { filename: patchFilename(row), body: row.body }])
    );
    await edit(draft, queue);
    const renamed: Array<{ from: string; to: string }> = [];
    const created: string[] = [];
    const rewritten: string[] = [];
    for (const row of [...draft.patches].sort((a, b) => a.order - b.order)) {
      const old = before.get(row);
      const filename = patchFilename(row);
      if (old === undefined) {
        created.push(filename);
        continue;
      }
      if (old.filename !== filename) renamed.push({ from: old.filename, to: filename });
      if (!Buffer.from(old.body).equals(row.body)) rewritten.push(filename);
    }
    const kept = new Set(draft.patches);
    const removed = [...before].filter(([row]) => !kept.has(row)).map(([, old]) => old.filename);
    return { renamed, created, removed, rewritten };
  });
}

/** The sparse start tree for replaying the given queues on the engine's HEAD. */
async function startTree(
  project: PatchProject,
  queues: readonly Queue[]
): Promise<{ engine: string; start: string; paths: string[] }> {
  const engine = project.paths.engine;
  const paths = pathsOf(queues.flatMap((queue) => queue.patches));
  return { engine, start: await sparseTree(engine, await engineHead(project), paths), paths };
}

/**
 * Refuses a draft whose queue does not produce exactly what the stored queue
 * produces: every patch applies, and every path ends in the same state.
 */
async function requireSameResult(
  project: PatchProject,
  queue: Queue,
  draft: QueueDraft,
  label: string
): Promise<void> {
  const next = queueOfDraft(queue.dir, draft);
  const { engine, start, paths } = await startTree(project, [queue, next]);
  const old = await replay(engine, start, queue.patches);
  const oldFailure = old.failures[0];
  if (oldFailure !== undefined) {
    throw queueError(
      'queue-does-not-apply',
      `The patch queue does not apply to the engine from ${oldFailure.patch} on.`,
      'Run "fireforge import" and resolve the failing patch first.'
    );
  }
  const result = await replay(engine, start, next.patches);
  const failure = result.failures[0];
  if (failure !== undefined) {
    throw queueError(
      'queue-operation-conflict',
      `${label} is refused: ${failure.patch} would no longer apply (${failure.message || 'its context changed'}).`,
      'Patches that change the same lines keep their relative order.'
    );
  }
  const was = await statesIn(engine, old.tree, paths);
  const now = await statesIn(engine, result.tree, paths);
  const changed = paths.filter((path) => !sameState(was.get(path), now.get(path)));
  if (changed.length > 0) {
    throw queueError(
      'queue-operation-conflict',
      `${label} is refused: the queue would produce different content in ${changed.join(', ')}.`,
      'Patches that change the same lines keep their relative order.'
    );
  }
}

/**
 * A placement with its patch identifiers (anything `resolvePatch` takes)
 * resolved to names, as `place` reads them.
 *
 * @param queue - The queue
 * @param placement - Where, as the user named it
 */
export function resolvePlacement(queue: Queue, placement: Placement): Placement {
  if ('before' in placement) return { before: resolvePatch(queue, placement.before).name };
  if ('after' in placement) return { after: resolvePatch(queue, placement.after).name };
  return placement;
}

/**
 * Renames a patch. Its order, body and metadata stay; its file follows.
 *
 * @param project - A patch-mode project
 * @param identifier - The patch (anything `resolvePatch` takes)
 * @param name - The new name
 * @throws `patch-name-invalid` or `patch-exists` (exit code 8)
 */
export function renamePatch(
  project: PatchProject,
  identifier: string,
  name: string
): Promise<QueueEdit> {
  return operate(project, 'the rename', (draft, queue) => {
    const patch = resolvePatch(queue, identifier);
    if (patch.name === name) return;
    requireNewName(queue, name);
    rowOf(draft, patch.name).name = name;
  });
}

/**
 * Moves a patch to another place in the apply order: an order number, or
 * right before or after another patch (`placement.ts` describes how the run
 * of orders above an occupied one moves up). Refused when the queue would
 * then produce anything different.
 *
 * @param project - A patch-mode project with an engine
 * @param identifier - The patch
 * @param placement - Where; patches named by any identifier `resolvePatch` takes
 * @throws `queue-operation-conflict` (exit code 6) when patches that change the same lines would swap
 */
export function reorderPatch(
  project: PatchProject,
  identifier: string,
  placement: Placement
): Promise<QueueEdit> {
  return operate(project, 'the reorder', async (draft, queue) => {
    const patch = resolvePatch(queue, identifier);
    place(draft, patch.name, resolvePlacement(queue, placement));
    await requireSameResult(project, queue, draft, `Moving ${patch.filename}`);
  });
}

/** The files of a patch that the user's paths name: files, or everything under a directory. */
function filesNamed(patch: QueuePatch, paths: readonly string[]): string[] {
  const chosen = new Set<string>();
  for (const path of paths) {
    const matches = patch.files.filter((file) => covers(path, file));
    if (matches.length === 0) {
      throw usage('patch-file-not-owned', `${patch.filename} does not touch ${path}.`);
    }
    for (const file of matches) chosen.add(file);
  }
  return [...chosen].sort();
}

/**
 * Gives `receiver` the change `source` makes to `moved`: its new body is the
 * diff, over its old files and the moved ones, from the state the new queue
 * leaves before it to that state with its old body and the moved sections
 * applied in their old relative order.
 */
async function absorb(
  project: PatchProject,
  queue: Queue,
  draft: QueueDraft,
  move: { source: QueuePatch; receiver: DraftPatch; moved: readonly string[]; old?: QueuePatch }
): Promise<void> {
  const { source, receiver, moved, old } = move;
  receiver.body = new Uint8Array();
  const pending = queueOfDraft(queue.dir, draft);
  const { engine, start } = await startTree(project, [queue]);
  const earlier = pending.patches.filter((patch) => patch.order < receiver.order);
  const before = await replay(engine, start, earlier);
  const blocked = before.failures[0];
  if (blocked !== undefined) {
    throw queueError(
      'queue-operation-conflict',
      `${blocked.patch} would no longer apply once ${moved.join(', ')} leave ${source.filename}.`
    );
  }
  const pieces: ApplicablePatch[] = [slicePatch(source, new Set(moved), true)];
  if (old !== undefined) {
    if (old.index < source.index) pieces.unshift(old);
    else pieces.push(old);
  }
  let tree = before.tree;
  for (const piece of pieces) {
    const outcome = await applyToTree(engine, tree, piece);
    if (!outcome.applied) {
      throw queueError(
        'queue-operation-conflict',
        `The change to ${moved.join(', ')} does not fit where it would land: ${outcome.message}`,
        'Move it into a patch next to its source, or place the new patch there.'
      );
    }
    tree = outcome.tree;
  }
  const paths = [...new Set([...(old?.files ?? []), ...moved])].sort();
  const { body } = await regeneratePatchBody(engine, { before: before.tree, after: tree, paths });
  receiver.body = body;
}

/** Sets a row's lint waivers, dropping the field when there are none. */
function setWaivers(row: PatchEntry, list: LintIgnoreEntry[]): void {
  if (list.length === 0) delete row.lintIgnore;
  else row.lintIgnore = list;
}

/** Sets a row's staged dependencies, dropping the field when there are none. */
function setDeclarations(row: PatchEntry, list: StagedDependency[]): void {
  if (list.length === 0) delete row.stagedDependencies;
  else row.stagedDependencies = list;
}

/** Moves the staged dependencies declared on moved files from one row to another. */
function moveDeclarations(from: DraftPatch, to: DraftPatch, moved: ReadonlySet<string>): void {
  const declared = from.stagedDependencies ?? [];
  const going = declared.filter((entry) => moved.has(entry.file));
  if (going.length === 0) return;
  setDeclarations(
    from,
    declared.filter((entry) => !moved.has(entry.file))
  );
  setDeclarations(to, [...(to.stagedDependencies ?? []), ...going]);
}

/** What {@link splitPatch} creates. */
export interface SplitOptions {
  /** Engine files (or directories) of the patch to move into the new one. */
  files: readonly string[];
  /** The new patch's name. */
  name: string;
  description?: string;
  /** Where the new patch goes; default right after the source. */
  placement?: Placement;
}

/**
 * Moves some files of a patch into a new patch, by default placed right
 * after it. The new patch keeps the source's stamp and tier; staged
 * dependencies declared on the moved files go with them. Refused when the
 * queue would then produce anything different.
 *
 * @param project - A patch-mode project with an engine
 * @param identifier - The patch to split
 * @param options - See {@link SplitOptions}
 * @throws `patch-split-all` (exit code 8) when every file would move
 */
export function splitPatch(
  project: PatchProject,
  identifier: string,
  options: SplitOptions
): Promise<QueueEdit> {
  return operate(project, 'the split', async (draft, queue) => {
    const source = resolvePatch(queue, identifier);
    const moved = filesNamed(source, options.files);
    if (moved.length === source.files.length) {
      throw usage(
        'patch-split-all',
        `Splitting every file out of ${source.filename} leaves it empty.`,
        'Rename the patch instead ("fireforge patch rename").'
      );
    }
    requireNewName(queue, options.name);
    const movedSet = new Set(moved);
    const from = rowOf(draft, source.name);
    from.body = slicePatch(source, movedSet, false).body;
    const created: DraftPatch = {
      order: source.order,
      name: options.name,
      description: options.description ?? '',
      firefox: source.firefox,
      ...(source.tier === undefined ? {} : { tier: source.tier }),
      body: new Uint8Array(),
    };
    draft.patches.push(created);
    place(
      draft,
      created.name,
      options.placement === undefined
        ? { after: source.name }
        : resolvePlacement(queue, options.placement)
    );
    moveDeclarations(from, created, movedSet);
    await absorb(project, queue, draft, { source, receiver: created, moved });
    await requireSameResult(project, queue, draft, `Splitting ${source.filename}`);
  });
}

/**
 * Moves files from one patch into another existing patch. Where the target
 * already changes a moved file, the two changes are combined in their old
 * order. A source left with no files is removed. Staged dependencies
 * declared on the moved files go with them. Refused when the queue would
 * then produce anything different.
 *
 * @param project - A patch-mode project with an engine
 * @param from - The patch the files leave
 * @param to - The patch they join
 * @param files - Engine files (or directories) of `from`
 */
export function moveFiles(
  project: PatchProject,
  from: string,
  to: string,
  files: readonly string[]
): Promise<QueueEdit> {
  return operate(project, 'the file move', async (draft, queue) => {
    const source = resolvePatch(queue, from);
    const target = resolvePatch(queue, to);
    if (source.name === target.name) {
      throw usage('invalid-argument', 'The source and target patch are the same.');
    }
    const moved = filesNamed(source, files);
    const movedSet = new Set(moved);
    const sourceRow = rowOf(draft, source.name);
    const targetRow = rowOf(draft, target.name);
    moveDeclarations(sourceRow, targetRow, movedSet);
    if (moved.length === source.files.length) {
      draft.patches = draft.patches.filter((row) => row !== sourceRow);
    } else {
      sourceRow.body = slicePatch(source, movedSet, false).body;
    }
    await absorb(project, queue, draft, { source, receiver: targetRow, moved, old: target });
    await requireSameResult(project, queue, draft, `Moving files to ${target.filename}`);
  });
}

/** The patches that fail to replay, by name, carrying on past each failure. */
async function failing(
  project: PatchProject,
  start: string,
  patches: readonly QueuePatch[]
): Promise<Set<string>> {
  const result = await replay(project.paths.engine, start, patches, { keepGoing: true });
  return new Set(result.failures.map((failure) => patches[failure.index]?.name ?? ''));
}

/**
 * Removes a patch from the queue, keeping its order as a retired slot when
 * `retire` is given. Refused when another patch stops applying without it.
 * The engine is not touched: the files only it changed keep their content
 * and belong to no patch (`fireforge export` captures them, `fireforge
 * discard` puts them back).
 */
async function removePatch(
  project: PatchProject,
  identifier: string,
  retire: { reason?: string } | undefined
): Promise<Removal> {
  let files: readonly string[] = [];
  let released: string[] = [];
  const label = retire === undefined ? 'the deletion' : 'the retirement';
  const edit = await operate(project, label, async (draft, queue) => {
    const patch = resolvePatch(queue, identifier);
    files = patch.files;
    const kept = new Set(pathsOf(queue.patches.filter((other) => other.name !== patch.name)));
    released = patch.files.filter((path) => !kept.has(path));
    draft.patches = draft.patches.filter((row) => row.name !== patch.name);
    if (retire !== undefined) {
      draft.retired.push({
        order: patch.order,
        name: patch.name,
        ...(retire.reason === undefined ? {} : { reason: retire.reason }),
      });
    }
    const { start } = await startTree(project, [queue]);
    const already = await failing(project, start, queue.patches);
    const now = await failing(project, start, queueOfDraft(queue.dir, draft).patches);
    const broken = [...now].filter((name) => !already.has(name));
    if (broken.length > 0) {
      throw queueError(
        'patch-has-dependents',
        `${patch.filename} cannot be removed: ${broken.join(', ')} would no longer apply without it.`,
        'Remove the dependent patches first, or move their changes into another patch.'
      );
    }
  });
  // What the engine holds there is now the user's work, not the queue's output.
  await forgetApplied(project, released);
  return { ...edit, files };
}

/**
 * Deletes a patch: its row and file go. Refused when another patch stops
 * applying without it; the engine is not touched.
 *
 * @param project - A patch-mode project with an engine
 * @param identifier - The patch
 * @throws `patch-has-dependents` (exit code 6) when a later patch needs it
 */
export function deletePatch(project: PatchProject, identifier: string): Promise<Removal> {
  return removePatch(project, identifier, undefined);
}

/**
 * Retires a patch: it is removed like {@link deletePatch}, and its order is
 * kept as a retired slot, so the number is not given to another patch and
 * the gap check sees no gap.
 *
 * @param project - A patch-mode project with an engine
 * @param identifier - The patch
 * @param reason - Recorded with the slot
 */
export function retirePatch(
  project: PatchProject,
  identifier: string,
  reason?: string
): Promise<Removal> {
  return removePatch(project, identifier, reason === undefined ? {} : { reason });
}

/**
 * Closes the gaps in the queue's numbering, keeping the apply order
 * (`compactOrders` in `placement.ts` describes how ranges are handled).
 *
 * @param project - A patch-mode project
 */
export function compactQueue(project: PatchProject): Promise<QueueEdit> {
  return operate(project, 'the compaction', (draft) => {
    compactOrders(project.config.patchPolicy, draft);
  });
}

/** What {@link setPatchMeta} changes; anything left out stays. */
export interface PatchMetaChange {
  description?: string;
  /** `null` clears the tier. */
  tier?: 'branding' | null;
  /** Waivers to add (replacing any entry for the same rule) and rules whose waiver to drop. */
  lintIgnore?: { add?: readonly LintIgnoreEntry[]; remove?: readonly string[] };
  /** Declarations to add (replacing an equal one) and to drop. */
  stagedDependencies?: {
    add?: readonly StagedDependency[];
    remove?: ReadonlyArray<Pick<StagedDependency, 'file' | 'creates'>>;
  };
}

function ruleOf(entry: LintIgnoreEntry): string {
  return typeof entry === 'string' ? entry : entry.rule;
}

function absent(row: PatchEntry, what: string, present: readonly string[]): FireForgeError {
  return usage(
    'patch-meta-absent',
    `${patchFilename(row)} has no ${what}.`,
    `It has: ${present.join(', ') || 'none'}.`
  );
}

function editWaivers(row: DraftPatch, change: NonNullable<PatchMetaChange['lintIgnore']>): void {
  let list = [...(row.lintIgnore ?? [])];
  for (const rule of change.remove ?? []) {
    if (!list.some((entry) => ruleOf(entry) === rule)) {
      throw absent(row, `waiver of "${rule}"`, list.map(ruleOf));
    }
    list = list.filter((entry) => ruleOf(entry) !== rule);
  }
  for (const entry of change.add ?? []) {
    list = [...list.filter((other) => ruleOf(other) !== ruleOf(entry)), entry];
  }
  setWaivers(row, list);
}

/**
 * A staged dependency written `<file>:<creates>`, as `patch set` takes it.
 *
 * @param spec - The text
 * @throws `invalid-argument` (exit code 8) without a `:` between two paths
 */
export function stagedDependencyOf(spec: string): Pick<StagedDependency, 'file' | 'creates'> {
  const colon = spec.indexOf(':');
  const file = spec.slice(0, colon).trim();
  const creates = spec.slice(colon + 1).trim();
  if (colon === -1 || file === '' || creates === '') {
    throw usage(
      'invalid-argument',
      `"${spec}" is not a staged dependency.`,
      'Write it <file>:<creates>, the file in this patch and the file a later patch creates.'
    );
  }
  return { file, creates };
}

function editDeclarations(
  row: DraftPatch,
  change: NonNullable<PatchMetaChange['stagedDependencies']>
): void {
  const key = (entry: Pick<StagedDependency, 'file' | 'creates'>): string =>
    `${entry.file}:${entry.creates}`;
  let list = [...(row.stagedDependencies ?? [])];
  for (const entry of change.remove ?? []) {
    if (!list.some((other) => key(other) === key(entry))) {
      throw absent(row, `staged dependency ${key(entry)}`, list.map(key));
    }
    list = list.filter((other) => key(other) !== key(entry));
  }
  for (const entry of change.add ?? []) {
    list = [...list.filter((other) => key(other) !== key(entry)), entry];
  }
  setDeclarations(row, list);
}

/** What {@link setPatchMeta} wrote. */
export interface PatchMetaResult {
  /** The patch's filename. */
  readonly patch: string;
  /** Its manifest row as written. */
  readonly entry: PatchEntry;
  readonly changed: boolean;
}

/**
 * Edits a patch's metadata (description, tier, lint waivers, staged
 * dependencies) in one transaction. The body is not touched.
 *
 * @param project - A patch-mode project
 * @param identifier - The patch
 * @param change - See {@link PatchMetaChange}
 * @throws `patch-meta-absent` (exit code 8) when asked to drop something the patch does not have
 */
export async function setPatchMeta(
  project: PatchProject,
  identifier: string,
  change: PatchMetaChange
): Promise<PatchMetaResult> {
  let result: PatchMetaResult | undefined;
  await operate(project, 'the metadata edit', (draft, queue) => {
    const row = rowOf(draft, resolvePatch(queue, identifier).name);
    const before = JSON.stringify(entryOf(row));
    if (change.description !== undefined) row.description = change.description;
    if (change.tier === null) delete row.tier;
    else if (change.tier !== undefined) row.tier = change.tier;
    if (change.lintIgnore !== undefined) editWaivers(row, change.lintIgnore);
    if (change.stagedDependencies !== undefined) editDeclarations(row, change.stagedDependencies);
    const entry = entryOf(row);
    result = { patch: patchFilename(entry), entry, changed: JSON.stringify(entry) !== before };
  });
  return defined(result, 'the metadata edit ran');
}
