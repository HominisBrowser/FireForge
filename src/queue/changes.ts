// SPDX-License-Identifier: EUPL-1.2
/**
 * The patch queue as the owned-change model (`project/changes.ts`).
 *
 * Two change sets describe a patch-mode project:
 *
 *  - {@link queueChanges}: the stored queue. One group per patch, in queue
 *    order; one step per patch per path it changes, relative to what the
 *    earlier patches left. Rules about a patch's own work read this
 *    (`lint --per-patch`, size, waivers).
 *  - {@link engineChanges}: what the engine holds now, relative to HEAD. One
 *    step per changed path. A path the queue touches belongs to the first
 *    patch that touches it; an edit to any other path has no group, which is
 *    how work not yet exported appears. Every change carries `meta.state`,
 *    its {@link EngineState}, so a rule or report can tell exported work from
 *    edits not yet in a patch. Rules about what the engine ends up holding
 *    read this (`lint` by default).
 *
 * Both share the queue's groups, so tier and waivers apply either way.
 */
import { formatPatch } from '../diff/index.js';
import { diffTrees, readBlobs, writeTree } from '../git/index.js';
import { ExitCode, FireForgeError } from '../kernel/errors.js';
import type { JsonObject } from '../kernel/json.js';
import {
  type ChangeGroup,
  type ChangeSet,
  createChangeSet,
  type FileMode,
  type OwnedChange,
  type PatchProject,
  textContent,
} from '../project/index.js';
import { statesIn, type TreeState } from './apply.js';
import {
  classifyEngine,
  engineStates,
  type Projection,
  projectQueue,
  sameState,
} from './baseline.js';
import { loadQueue, type Queue, type QueuePatch, sectionsFor } from './queue.js';

/**
 * Reads blobs on demand, batching the requests made in one turn of the event
 * loop into one `git cat-file --batch`.
 */
function blobReader(repo: string): (oid: string) => Promise<Uint8Array> {
  let pending:
    | Map<string, Array<{ resolve: (bytes: Uint8Array) => void; reject: (error: unknown) => void }>>
    | undefined;
  const flush = async (batch: NonNullable<typeof pending>): Promise<void> => {
    try {
      const blobs = await readBlobs(repo, [...batch.keys()]);
      for (const [oid, waiters] of batch) {
        const bytes = blobs.get(oid);
        for (const waiter of waiters) {
          if (bytes === undefined)
            waiter.reject(new FireForgeError('queue-blob-missing', `Blob ${oid} is missing.`));
          else waiter.resolve(bytes);
        }
      }
    } catch (error: unknown) {
      for (const waiters of batch.values()) for (const waiter of waiters) waiter.reject(error);
    }
  };
  return (oid) =>
    new Promise<Uint8Array>((resolve, reject) => {
      if (pending === undefined) {
        const batch = new Map<
          string,
          Array<{ resolve: (bytes: Uint8Array) => void; reject: (error: unknown) => void }>
        >();
        pending = batch;
        queueMicrotask(() => {
          pending = undefined;
          void flush(batch);
        });
      }
      pending.set(oid, [...(pending.get(oid) ?? []), { resolve, reject }]);
    });
}

/** The change model's mode for a git file mode. */
function changeMode(mode: string): FileMode {
  return mode === '100755' || mode === '120000' ? mode : '100644';
}

/** The group a patch forms, with the facts rules read. */
function groupOf(patch: QueuePatch): ChangeGroup {
  const dependencies = (patch.stagedDependencies ?? []).map(({ file, creates }) => ({
    file,
    creates,
  }));
  const meta: JsonObject = {
    name: patch.name,
    order: patch.order,
    category: patch.category,
    description: patch.description,
    firefox: patch.firefox,
    ...(dependencies.length === 0 ? {} : { stagedDependencies: dependencies }),
  };
  return {
    id: patch.filename,
    ...(patch.tier === undefined ? {} : { tier: patch.tier }),
    ...(patch.lintIgnore === undefined || patch.lintIgnore.length === 0
      ? {}
      : { lintIgnore: patch.lintIgnore as NonNullable<ChangeGroup['lintIgnore']> }),
    meta,
  };
}

function groupsOf(queue: Queue): ChangeGroup[] {
  return queue.patches.map(groupOf);
}

interface StepInput {
  path: string;
  before: TreeState | null;
  after: TreeState | null;
  binary: boolean;
  group?: string;
  meta: JsonObject;
}

/** One change from two states; undefined when they are equal. */
function changeOf(
  input: StepInput,
  read: (oid: string) => Promise<Uint8Array>
): OwnedChange | undefined {
  const { path, before, after, binary, meta } = input;
  const base = { path, binary, ...(input.group === undefined ? {} : { group: input.group }), meta };
  if (before === null && after !== null) {
    return { ...base, kind: 'create', after: () => read(after.oid), mode: changeMode(after.mode) };
  }
  if (before !== null && after === null) {
    return {
      ...base,
      kind: 'delete',
      before: () => read(before.oid),
      previousMode: changeMode(before.mode),
    };
  }
  if (before === null || after === null || sameState(before, after)) return undefined;
  return {
    ...base,
    kind: 'modify',
    before: () => read(before.oid),
    after: () => read(after.oid),
    previousMode: changeMode(before.mode),
    mode: changeMode(after.mode),
  };
}

/** The diff of any change, from its content: two one-file trees, diffed in the pinned format. */
async function diffOfContent(repo: string, change: OwnedChange): Promise<string> {
  const before =
    change.kind === 'create'
      ? []
      : [{ path: change.path, content: await change.before(), mode: change.previousMode }];
  const after =
    change.kind === 'delete'
      ? []
      : [{ path: change.path, content: await change.after(), mode: change.mode }];
  const [from, to] = [await writeTree(repo, before), await writeTree(repo, after)];
  return (await diffTrees(repo, from, to)).toString('utf8');
}

function isBinarySection(patch: QueuePatch, path: string): boolean {
  return sectionsFor(patch, path).some(
    (file) => file.binary !== undefined || file.encoding === 'latin1'
  );
}

/**
 * Refuses a projection that stops before the end of the queue.
 *
 * @param projection - The queue replayed onto the engine's HEAD
 * @throws `queue-does-not-apply` (exit code 6)
 */
export function requireApplies(projection: Projection): void {
  const failure = projection.failure;
  if (failure === undefined) return;
  throw new FireForgeError(
    'queue-does-not-apply',
    `The patch queue does not apply to the engine from ${failure.patch} on: ${failure.message}`,
    {
      exitCode: ExitCode.PATCH_ERROR,
      hint: 'Run "fireforge import" to see the conflict and resolve it, or "fireforge rebase" after a pin change.',
    }
  );
}

/**
 * The stored queue as a change set: one group per patch, one step per patch
 * per path it changes. Content is read from the engine's object store.
 *
 * @param project - A patch-mode project with an engine
 * @param draft - A queue to judge instead of the stored one (see `queueOfDraft`)
 * @throws `queue-does-not-apply` (exit code 6) when the queue does not replay onto the engine's HEAD
 */
export async function queueChanges(project: PatchProject, draft?: Queue): Promise<ChangeSet> {
  const engine = project.paths.engine;
  const queue = draft ?? (await loadQueue(project));
  const projection = await projectQueue(project, queue, { cache: draft === undefined });
  requireApplies(projection);
  const read = blobReader(engine);
  const sections = new Map<OwnedChange, string>();
  const changes: OwnedChange[] = [];
  const current = new Map(
    projection.paths.map((path) => [path, projection.history(path)[0]?.state ?? null])
  );
  for (const [index, step] of projection.steps.entries()) {
    const patch = queue.patches[index];
    if (patch === undefined) continue;
    for (const { path, state } of step.changes) {
      const change = changeOf(
        {
          path,
          before: current.get(path) ?? null,
          after: state,
          binary: isBinarySection(patch, path),
          group: patch.filename,
          meta: {},
        },
        read
      );
      current.set(path, state);
      if (change === undefined) continue;
      const files = sectionsFor(patch, path);
      sections.set(
        change,
        formatPatch({ ...patch.diff, preamble: [], files, finalNewline: true }).toString(
          patch.diff.encoding
        )
      );
      changes.push(change);
    }
  }
  return createChangeSet({
    groups: groupsOf(queue),
    changes,
    diff: async (change) => sections.get(change) ?? diffOfContent(engine, change),
  });
}

/**
 * What the engine holds now, relative to HEAD, as a change set (see the
 * module comment). Edits not yet exported are the changes without a group,
 * and the queue files' edits carry `meta.state: "modified"`.
 *
 * @param project - A patch-mode project with an engine
 */
export async function engineChanges(project: PatchProject): Promise<ChangeSet> {
  const engine = project.paths.engine;
  const queue = await loadQueue(project);
  const projection = await projectQueue(project, queue);
  const classified = await classifyEngine(project, projection);
  const paths = classified.map((entry) => entry.path);
  const now = await engineStates(engine, projection.start, paths);
  const head = await statesIn(engine, projection.base, paths);
  const differing = classified.filter(
    (entry) => !sameState(now.get(entry.path), head.get(entry.path))
  );
  const blobs = await readBlobs(
    engine,
    differing.flatMap((entry) =>
      [now.get(entry.path), head.get(entry.path)].flatMap((state) =>
        state == null ? [] : [state.oid]
      )
    )
  );
  const isText = (state: TreeState | null | undefined): boolean => {
    const bytes = state == null ? undefined : blobs.get(state.oid);
    return bytes === undefined || textContent(bytes) !== undefined;
  };
  const read = blobReader(engine);
  const changes = differing.flatMap((entry) => {
    const before = head.get(entry.path) ?? null;
    const after = now.get(entry.path) ?? null;
    const change = changeOf(
      {
        path: entry.path,
        before,
        after,
        binary: !isText(before) || !isText(after),
        ...(entry.owners[0] === undefined ? {} : { group: entry.owners[0] }),
        meta: { state: entry.state },
      },
      read
    );
    return change === undefined ? [] : [change];
  });
  return createChangeSet({
    groups: groupsOf(queue),
    changes,
    diff: (change) => diffOfContent(engine, change),
  });
}
