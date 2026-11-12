// SPDX-License-Identifier: EUPL-1.2
/**
 * The source tree as the owned-change model: one step per owned path
 * against its pristine blob, in the groups an export would write. Lint,
 * policy, typecheck scope, `status` and `verify` read this and never learn
 * the storage.
 */
import { readBytes } from '../kernel/fs.js';
import { mapLimit } from '../kernel/time.js';
import {
  type ChangeGroup,
  type ChangeSet,
  type ContentReader,
  createChangeSet,
  type OwnedChange,
  type SourceProject,
  textContent,
} from '../project/index.js';
import { planGroups } from './groups.js';
import { diffSections, readPristineBlobs, writeDeltaTrees } from './objects.js';
import type { Pristine } from './records.js';
import { readSourceTree, type SourceEntry, type SourceProblem, type SourceTree } from './tree.js';

/** Files read at once while classifying content. */
const READ_CONCURRENCY = 32;

function isBinary(bytes: Uint8Array | undefined): boolean {
  return bytes !== undefined && textContent(bytes) === undefined;
}

function changeMeta(entry: SourceEntry): OwnedChange['meta'] {
  if (entry.kind === 'create') return {};
  return {
    component: entry.component,
    declared: entry.record !== undefined,
    ...(entry.record === undefined
      ? {}
      : {
          classification: entry.record.classification,
          ...(entry.record.adr === undefined ? {} : { adr: entry.record.adr }),
        }),
  };
}

/** The steps of a tree's entries, their binary flag read from both sides once. */
async function changesOf(
  tree: SourceTree,
  groupOf: ReadonlyMap<string, string>
): Promise<OwnedChange[]> {
  const upstreamReader =
    (blob: string): ContentReader =>
    async () =>
      (await readPristineBlobs(tree.pristine, [blob])).get(blob) ?? Buffer.alloc(0);
  const upstreamBlobs = tree.entries.flatMap((entry) =>
    entry.upstream === undefined ? [] : [entry.upstream.blob]
  );
  const upstreamBinary = new Set(
    [...(await readPristineBlobs(tree.pristine, upstreamBlobs))].flatMap(([blob, bytes]) =>
      isBinary(bytes) ? [blob] : []
    )
  );
  return mapLimit(tree.entries, READ_CONCURRENCY, async (entry): Promise<OwnedChange> => {
    const owned = entry.file === undefined ? undefined : await readBytes(entry.file.absolute);
    const group = groupOf.get(entry.path);
    const base = {
      path: entry.path,
      binary:
        isBinary(owned) ||
        (entry.upstream !== undefined && upstreamBinary.has(entry.upstream.blob)),
      meta: changeMeta(entry),
      ...(group === undefined ? {} : { group }),
    };
    const after: ContentReader = () => readBytes(entry.file?.absolute ?? '');
    if (entry.upstream === undefined) {
      return { ...base, kind: 'create', after, mode: entry.file?.mode ?? '100644' };
    }
    const before = upstreamReader(entry.upstream.blob);
    if (entry.file === undefined) {
      return { ...base, kind: 'delete', before, previousMode: entry.upstream.mode };
    }
    return {
      ...base,
      kind: 'modify',
      before,
      after,
      previousMode: entry.upstream.mode,
      mode: entry.file.mode,
    };
  });
}

/**
 * The owned changes of a source-mode checkout: one step per owned path
 * against the pristine blob, in the groups of `groups.ts`: a component of
 * upstream changes, or a group of created files. Paths with a blocking problem are left out; {@link verifySource}
 * reports them. The diff provider produces the bytes an export would write.
 *
 * @param project - A source-mode project
 * @param pristine - The pinned pristine repository
 * @throws `source-group-name-collision` when two groups would share an ID
 */
export async function sourceChanges(
  project: SourceProject,
  pristine: Pristine
): Promise<ChangeSet> {
  const tree = await readSourceTree(project, pristine);
  const planned = planGroups(tree.entries, project.config.exportQueue);
  const groupOf = new Map(
    planned.flatMap((group) => group.paths.map((path) => [path, group.id] as const))
  );
  const groups: ChangeGroup[] = planned.map((group) => ({
    id: group.id,
    // How created files group shapes an export; it says nothing about scope.
    ...(group.kind === 'created' ? { sized: false as const } : {}),
    meta: { kind: group.kind, description: group.description },
  }));
  let sections: Promise<Map<string, Buffer>> | undefined;
  return createChangeSet({
    groups,
    changes: await changesOf(tree, groupOf),
    diff: async (change) => {
      sections ??= writeDeltaTrees(tree, tree.entries).then(diffSections);
      return (await sections).get(change.path)?.toString('utf8') ?? '';
    },
  });
}

/** One owned path, as `status` lists it. */
export interface OwnedPath {
  readonly path: string;
  readonly kind: 'create' | 'modify' | 'delete';
  /** The ID of the group the path is in. */
  readonly group: string;
}

/** One group, as `status` lists it. */
export interface GroupSummary {
  readonly id: string;
  readonly kind: 'component' | 'created';
  /** How many owned paths it holds. */
  readonly paths: number;
}

/** What `status` reports in source mode. */
export interface SourceStatus {
  readonly owned: readonly OwnedPath[];
  /** The groups of the owned paths, in the order an export applies them. */
  readonly groups: readonly GroupSummary[];
  /** Everything unaccounted for: undeclared edits, stale or orphaned records, refused files. */
  readonly problems: readonly SourceProblem[];
}

/**
 * The owned paths of a source-mode checkout, their groups, and everything
 * unaccounted for.
 *
 * @param project - A source-mode project
 * @param pristine - The pinned pristine repository
 * @throws `source-group-name-collision` when two groups would share an ID
 */
export async function sourceStatus(
  project: SourceProject,
  pristine: Pristine
): Promise<SourceStatus> {
  const tree = await readSourceTree(project, pristine);
  const planned = planGroups(tree.entries, project.config.exportQueue);
  const groupOf = new Map(
    planned.flatMap((group) => group.paths.map((path) => [path, group.id] as const))
  );
  return {
    owned: tree.entries.map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      group: groupOf.get(entry.path) ?? entry.component,
    })),
    groups: planned.map((group) => ({
      id: group.id,
      kind: group.kind,
      paths: group.paths.length,
    })),
    problems: tree.problems,
  };
}

/**
 * The integrity of a source-mode checkout's storage: every override record
 * against the pristine repository, every owned file's kind, path and
 * attributes. Empty when everything holds.
 *
 * @param project - A source-mode project
 * @param pristine - The pinned pristine repository
 */
export async function verifySource(
  project: SourceProject,
  pristine: Pristine
): Promise<readonly SourceProblem[]> {
  return (await readSourceTree(project, pristine)).problems;
}
