// SPDX-License-Identifier: EUPL-1.2
/**
 * The patch queue on disk: reading it, naming a patch in it, and changing it
 * as one transaction.
 *
 * Every change to `patches/` goes through {@link mutateQueue}: the caller
 * edits an in-memory draft and the draft is written under a
 * `kernel/journal` transaction, which writes changed bodies, removes the
 * files of patches that are gone or renamed, and rewrites the manifest.
 * An error, a signal or a crash leaves either the old queue or the new one.
 */
import { basename, join } from 'node:path';

import {
  affectedPaths,
  type FileDiff,
  formatPatch,
  parsePatch,
  type Patch,
} from '../diff/index.js';
import { ExitCode, FireForgeError } from '../kernel/errors.js';
import { listDir, readBytesIfExists, readTextIfExists, writeFile } from '../kernel/fs.js';
import { hash } from '../kernel/hash.js';
import { transaction } from '../kernel/journal.js';
import { parseJson } from '../kernel/json.js';
import { warn } from '../kernel/log.js';
import { nearest } from '../kernel/text.js';
import type { PatchProject } from '../project/index.js';
import {
  categoryOf,
  formatManifest,
  type Manifest,
  MANIFEST_FILE,
  manifestProblems,
  parseManifest,
  type PatchEntry,
  patchFilename,
  type QueueSource,
  type RetiredSlot,
} from './manifest.js';
import { policyProblems } from './placement.js';

/** One patch of a loaded queue. */
export interface QueuePatch extends PatchEntry {
  /** `<order>-<name>.patch`. */
  readonly filename: string;
  /** The first word of the name. */
  readonly category: string;
  /** Position in apply order, from 0. */
  readonly index: number;
  /** Absolute path of the file holding the body. */
  readonly path: string;
  /** The body's bytes. */
  readonly body: Buffer;
  /** The body, parsed. */
  readonly diff: Patch;
  /** Every engine path the body touches, sorted. */
  readonly files: readonly string[];
}

/** A loaded patch queue. */
export interface Queue {
  /** The queue directory. */
  readonly dir: string;
  readonly source: QueueSource | undefined;
  /** The patches in apply order. */
  readonly patches: readonly QueuePatch[];
  readonly retired: readonly RetiredSlot[];
  /** Changes whenever the manifest or any body changes. */
  readonly digest: string;
}

/**
 * A refusal from the queue module: a patch problem (exit code 6) unless the
 * caller names another exit code, such as `INVALID_ARGUMENT` for a bad request.
 *
 * @param code - Stable error code
 * @param message - What is wrong
 * @param hint - What to do about it
 * @param exitCode - Default `PATCH_ERROR`
 */
export function queueError(
  code: string,
  message: string,
  hint?: string,
  exitCode: ExitCode = ExitCode.PATCH_ERROR
): FireForgeError {
  return new FireForgeError(code, message, { exitCode, ...(hint === undefined ? {} : { hint }) });
}

/**
 * Every engine path some of `patches` touch, sorted and unique.
 *
 * @param patches - Patches with their touched files
 */
export function pathsOf(patches: readonly { readonly files: readonly string[] }[]): string[] {
  return [...new Set(patches.flatMap((patch) => patch.files))].sort();
}

function digestOf(manifest: Manifest, patches: readonly QueuePatch[]): string {
  const parts = [formatManifest(manifest)];
  for (const patch of patches) parts.push(`${patch.filename}\0${hash(patch.body)}`);
  return hash(parts.join('\n'));
}

/** The `.patch` files in a queue directory. */
async function patchFiles(dir: string): Promise<string[]> {
  return (await listDir(dir))
    .filter((entry) => entry.kind === 'file' && entry.name.endsWith('.patch'))
    .map((entry) => entry.name);
}

/**
 * Builds the in-memory patch for a manifest row and its body.
 *
 * @param entry - The row
 * @param body - The body's bytes
 * @param where - The queue directory and the body's file there
 */
function toQueuePatch(
  entry: PatchEntry,
  body: Buffer,
  where: { dir: string; file: string; index: number }
): QueuePatch {
  const diff = parsePatch(body);
  return {
    ...entry,
    filename: patchFilename(entry),
    category: categoryOf(entry.name),
    index: where.index,
    path: join(where.dir, where.file),
    body,
    diff,
    files: affectedPaths(diff),
  };
}

/**
 * Reads a queue directory. A directory without a manifest and without patch
 * files is an empty queue.
 *
 * @param dir - The queue directory
 * @throws `queue-manifest-missing`, `queue-manifest-invalid` or `queue-patch-missing` (exit code 6)
 */
export async function readQueue(dir: string): Promise<Queue> {
  const manifestPath = join(dir, MANIFEST_FILE);
  const text = await readTextIfExists(manifestPath);
  if (text === undefined) {
    const strays = await patchFiles(dir);
    if (strays.length > 0) {
      throw queueError(
        'queue-manifest-missing',
        `${dir} holds ${strays.length} patch file(s) but no ${MANIFEST_FILE}.`,
        `Restore ${MANIFEST_FILE} from version control.`
      );
    }
    const empty: Manifest = { patches: [], retired: [] };
    return {
      dir,
      source: undefined,
      patches: [],
      retired: [],
      digest: digestOf(empty, []),
    };
  }
  const raw = parseJson(text, { source: manifestPath, exitCode: ExitCode.PATCH_ERROR });
  const { manifest, files } = parseManifest(raw, manifestPath);
  const patches: QueuePatch[] = [];
  const missing: string[] = [];
  for (const [index, entry] of manifest.patches.entries()) {
    const file = files[index] ?? patchFilename(entry);
    const body = await readBytesIfExists(join(dir, file));
    if (body === undefined) missing.push(file);
    else patches.push(toQueuePatch(entry, body, { dir, file, index }));
  }
  if (missing.length > 0) {
    throw queueError(
      'queue-patch-missing',
      `${MANIFEST_FILE} lists patch file(s) that do not exist: ${missing.join(', ')}`,
      'Restore them from version control, or remove their rows from the manifest.'
    );
  }
  return {
    dir,
    source: manifest.source,
    patches,
    retired: manifest.retired,
    digest: digestOf(manifest, patches),
  };
}

/**
 * Reads the project's patch queue (`patches/`).
 *
 * @param project - A patch-mode project
 */
export function loadQueue(project: PatchProject): Promise<Queue> {
  return readQueue(project.paths.patches);
}

/** The manifest row of a loaded patch. */
export function entryOf(patch: PatchEntry): PatchEntry {
  return {
    order: patch.order,
    name: patch.name,
    description: patch.description,
    firefox: patch.firefox,
    ...(patch.tier === undefined ? {} : { tier: patch.tier }),
    ...(patch.lintIgnore === undefined ? {} : { lintIgnore: patch.lintIgnore }),
    ...(patch.stagedDependencies === undefined
      ? {}
      : { stagedDependencies: patch.stagedDependencies }),
  };
}

/**
 * Finds one patch by an identifier the user typed: an order number (`12`,
 * `012`), a filename with or without `.patch`, a name (`ui-sidebar`), or a
 * name without its category (`sidebar`) when that is unique.
 *
 * @param queue - The queue
 * @param identifier - What the user typed
 * @throws `patch-not-found` or `patch-ambiguous` (exit code 8)
 */
export function resolvePatch(queue: Queue, identifier: string): QueuePatch {
  const id = identifier.trim();
  const exact = queue.patches.filter((patch) =>
    /^\d+$/.test(id)
      ? patch.order === Number(id)
      : patch.name === id || patch.filename === id || patch.filename === `${id}.patch`
  );
  const candidates =
    exact.length > 0
      ? exact
      : queue.patches.filter((patch) => patch.name.slice(patch.category.length + 1) === id);
  const [only] = candidates;
  if (only !== undefined && candidates.length === 1) return only;
  if (candidates.length > 1) {
    throw new FireForgeError(
      'patch-ambiguous',
      `"${identifier}" matches ${candidates.length} patches: ${candidates.map((patch) => patch.filename).join(', ')}`,
      { exitCode: ExitCode.INVALID_ARGUMENT, hint: 'Name the patch by its full name or order.' }
    );
  }
  const suggestion = nearest(
    id,
    queue.patches.map((patch) => patch.name)
  );
  throw new FireForgeError('patch-not-found', `No patch matches "${identifier}".`, {
    exitCode: ExitCode.INVALID_ARGUMENT,
    hint:
      suggestion === undefined
        ? 'Name a patch by order number, filename or name.'
        : `Did you mean "${suggestion}"?`,
  });
}

/**
 * Resolves several identifiers ({@link resolvePatch} each) into a subset of
 * the queue, without duplicates, in apply order.
 *
 * @param queue - The queue
 * @param identifiers - What the user typed
 */
export function selectPatches(queue: Queue, identifiers: readonly string[]): QueuePatch[] {
  const chosen = new Set(identifiers.map((id) => resolvePatch(queue, id).index));
  return queue.patches.filter((patch) => chosen.has(patch.index));
}

/** One patch of a {@link QueueDraft}: its manifest row and its body. */
export interface DraftPatch extends PatchEntry {
  body: Uint8Array;
}

/**
 * The editable copy of a queue that {@link mutateQueue} hands its body.
 * Change it freely: add, remove, rename (change `name`), reorder (change
 * `order`), replace bodies, edit metadata. It is validated and written when
 * the body returns.
 */
export interface QueueDraft {
  patches: DraftPatch[];
  retired: RetiredSlot[];
  source: QueueSource | undefined;
}

/** The manifest a draft describes, or a refusal naming what is inconsistent. */
function manifestOf(draft: QueueDraft): Manifest {
  const manifest: Manifest = {
    ...(draft.source === undefined ? {} : { source: draft.source }),
    patches: draft.patches.map(entryOf).sort((a, b) => a.order - b.order),
    retired: [...draft.retired].sort((a, b) => a.order - b.order),
  };
  const problems = manifestProblems(manifest);
  if (problems.length > 0) {
    throw queueError(
      'queue-invalid',
      `The patch queue change is inconsistent: ${problems.join('; ')}`
    );
  }
  // A round trip through the schema refuses anything the manifest cannot hold.
  parseManifest(parseJson(formatManifest(manifest)), MANIFEST_FILE);
  return manifest;
}

/**
 * The queue a draft describes, in memory: what {@link mutateQueue} would
 * write, for judging a change before it is made.
 *
 * @param dir - The queue directory the draft belongs to
 * @param draft - The draft
 * @throws `queue-invalid` (exit code 6) when the draft is inconsistent
 */
export function queueOfDraft(dir: string, draft: QueueDraft): Queue {
  const manifest = manifestOf(draft);
  const bodies = bodiesByFilename(draft);
  const patches = manifest.patches.map((entry, index) => {
    const file = patchFilename(entry);
    return toQueuePatch(entry, Buffer.from(bodies.get(file) ?? new Uint8Array()), {
      dir,
      file,
      index,
    });
  });
  return {
    dir,
    source: manifest.source,
    patches,
    retired: manifest.retired,
    digest: digestOf(manifest, patches),
  };
}

function bodiesByFilename(draft: QueueDraft): Map<string, Uint8Array> {
  return new Map(draft.patches.map((patch) => [patchFilename(patch), patch.body]));
}

/**
 * Refuses (or, under `mutationMode: "warn"`, reports) the ordering-policy
 * problems a change introduces. Problems the queue already had are left to
 * `verify`, so an old one does not block an unrelated change.
 */
function enforcePolicy(project: PatchProject, queue: Queue, next: Manifest, label: string): void {
  const policy = project.config.patchPolicy;
  if (policy === undefined) return;
  const known = new Set(policyProblems(policy, queue.patches, queue.retired));
  const added = policyProblems(policy, next.patches, next.retired).filter(
    (problem) => !known.has(problem)
  );
  if (added.length === 0) return;
  if (policy.mutationMode === 'warn') {
    for (const problem of added) warn(`patchPolicy: ${problem}`);
    return;
  }
  throw queueError(
    'queue-policy',
    `${label} would break patchPolicy:\n${added.map((problem) => `  ${problem}`).join('\n')}`,
    'Choose an order in the category range (--order, --before, --after), or change patchPolicy.'
  );
}

/** Edits a draft; receives the stored queue the draft was made from. */
type DraftEdit<T> = (draft: QueueDraft, queue: Queue) => T | Promise<T>;

/** Runs `edit` on a draft of the stored queue and validates the result. */
async function prepareChange<T>(
  project: PatchProject,
  label: string,
  edit: DraftEdit<T>
): Promise<{ queue: Queue; draft: QueueDraft; manifest: Manifest; result: T }> {
  const queue = await loadQueue(project);
  const draft: QueueDraft = {
    patches: queue.patches.map((patch) => ({ ...entryOf(patch), body: patch.body })),
    retired: [...queue.retired],
    source: queue.source,
  };
  const result = await edit(draft, queue);
  const manifest = manifestOf(draft);
  enforcePolicy(project, queue, manifest, label);
  return { queue, draft, manifest, result };
}

/**
 * Runs a queue change exactly as {@link mutateQueue} would, validation
 * included, and returns the queue it would write instead of writing it.
 *
 * @param project - A patch-mode project
 * @param label - What is being done, for messages
 * @param edit - Edits the draft; its return value is passed through
 */
export async function previewQueue<T>(
  project: PatchProject,
  label: string,
  edit: DraftEdit<T>
): Promise<{ result: T; queue: Queue }> {
  const { queue, draft, result } = await prepareChange(project, label, edit);
  return { result, queue: queueOfDraft(queue.dir, draft) };
}

/**
 * Changes the project's patch queue as one transaction.
 *
 * The caller holds the engine lock exclusively (see `withEngineLock`). The
 * journal lives in the project state directory. A change that breaks the
 * ordering half of `patchPolicy` is refused (see `placement.ts`).
 *
 * @param project - A patch-mode project
 * @param label - What is being done, for messages: "the patch rename"
 * @param edit - Edits the draft, given the stored queue it was made from;
 *   its return value is passed through
 * @returns What `edit` returned, once the new queue is written
 */
export async function mutateQueue<T>(
  project: PatchProject,
  label: string,
  edit: DraftEdit<T>
): Promise<T> {
  const { queue, draft, manifest, result } = await prepareChange(project, label, edit);
  const bodies = bodiesByFilename(draft);
  const before = new Map(queue.patches.map((patch) => [patch.path, patch.body]));
  const manifestPath = join(queue.dir, MANIFEST_FILE);
  const text = formatManifest(manifest);
  const journal = join(project.paths.stateDir, 'queue.journal');
  await transaction(journal, label, async (tx) => {
    for (const [filename, body] of bodies) {
      const path = join(queue.dir, filename);
      if (before.get(path)?.equals(body) !== true) await tx.write(path, body);
    }
    for (const path of before.keys()) {
      if (!bodies.has(basename(path))) await tx.remove(path);
    }
    if ((await readTextIfExists(manifestPath)) !== text) await tx.write(manifestPath, text);
  });
  return result;
}

/** What {@link writeQueue} writes: a complete queue. */
export interface QueuePlan {
  patches: readonly DraftPatch[];
  source?: QueueSource;
}

/**
 * Writes a complete queue (manifest and patch files) into a directory that
 * does not exist or is empty. The manifest is written last, so an
 * interrupted write is not a readable queue.
 *
 * @param dir - The target directory
 * @param plan - The patches and the provenance
 * @returns The queue as written
 * @throws `queue-target-not-empty` (exit code 6) when the directory holds anything
 */
export async function writeQueue(dir: string, plan: QueuePlan): Promise<Queue> {
  if ((await listDir(dir)).length > 0) {
    throw queueError(
      'queue-target-not-empty',
      `${dir} is not empty.`,
      'Write the queue into an empty directory.'
    );
  }
  const draft: QueueDraft = {
    patches: [...plan.patches],
    retired: [],
    source: plan.source,
  };
  const manifest = manifestOf(draft);
  for (const [filename, body] of bodiesByFilename(draft)) {
    await writeFile(join(dir, filename), body, { durable: false });
  }
  await writeFile(join(dir, MANIFEST_FILE), formatManifest(manifest));
  return readQueue(dir);
}

/**
 * The sections of a patch that change one path.
 *
 * @param patch - The patch
 * @param path - Engine path
 */
export function sectionsFor(patch: QueuePatch, path: string): FileDiff[] {
  return patch.diff.files.filter((file) => file.path === path || file.oldPath === path);
}

/**
 * A patch cut down to the sections of some paths, or to the sections of
 * every other path (`keep: false`, which also keeps the preamble). The
 * sections' bytes are unchanged.
 *
 * @param patch - The patch
 * @param paths - Engine paths
 * @param keep - Keep the sections of `paths` (true) or drop them (false)
 */
export function slicePatch(
  patch: QueuePatch,
  paths: ReadonlySet<string>,
  keep: boolean
): { filename: string; body: Buffer; diff: Patch } {
  const files = patch.diff.files.filter(
    (file) => (paths.has(file.path) || paths.has(file.oldPath)) === keep
  );
  const diff: Patch = { ...patch.diff, preamble: keep ? [] : patch.diff.preamble, files };
  return { filename: patch.filename, body: formatPatch(diff), diff };
}
