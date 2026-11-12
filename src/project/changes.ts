// SPDX-License-Identifier: EUPL-1.2
/**
 * The owned-change model both modes produce and every quality rule consumes.
 *
 * An owned change is one engine path the project creates, modifies or
 * deletes relative to the pin. A provider (the patch queue, or the source
 * tree against the pristine repository) turns its storage into a
 * {@link ChangeSet}; lint, typecheck scope, policy and size rules read the
 * set and never learn which mode produced it.
 *
 * Steps and net changes. A change set is an ordered list of groups (patches
 * in queue order, or components), and each change is one group's step on one
 * path, relative to the state the earlier groups left. In patch mode a path
 * can therefore have several steps: one patch creates a file and a later one
 * modifies it. In source mode every path has exactly one step. A rule about a
 * group's own work (patch size, add-only markers, per-patch waivers) reads
 * the group's steps with {@link ChangeSet.inGroup}; a rule about what the
 * engine ends up holding (file size, JSDoc, strict typing, the set of owned
 * paths) reads one net change per path with {@link ChangeSet.net}.
 *
 * Content is read lazily, so a set over thousands of paths costs nothing
 * until a rule asks for bytes.
 */
import { invariant } from '../kernel/errors.js';
import type { JsonObject } from '../kernel/json.js';

/** Reads one version of a file on demand. Each call reads again; keep the bytes to reuse them. */
export type ContentReader = () => Promise<Uint8Array>;

/** A git file mode: regular, executable, or symbolic link (whose content is the link target). */
export type FileMode = '100644' | '100755' | '120000';

/** What a change does to its path. */
export type ChangeKind = 'create' | 'modify' | 'delete';

/**
 * Provider facts about a change or a group that only some consumers read,
 * such as a source-mode override's classification or a patch's staged
 * dependencies. JSON, so a report or cache can carry it.
 */
export type ChangeMeta = Readonly<JsonObject>;

interface ChangeBase {
  /** Engine-relative POSIX path, no leading `./` or `/`. */
  readonly path: string;
  /** True when either side of the change is not text (not valid UTF-8, or holds NUL). */
  readonly binary: boolean;
  /**
   * The group whose step this is: a patch filename or a component name.
   * Absent for a change no group owns, which can then be the path's only step.
   */
  readonly group?: string;
  readonly meta: ChangeMeta;
}

/** The project adds a path upstream does not have (or that an earlier step deleted). */
export interface CreateChange extends ChangeBase {
  readonly kind: 'create';
  /** The content the project supplies. */
  readonly after: ContentReader;
  readonly mode: FileMode;
}

/** The project changes the content or mode of a path that exists before this step. */
export interface ModifyChange extends ChangeBase {
  readonly kind: 'modify';
  /** The content before this step: upstream bytes, or what an earlier step left. */
  readonly before: ContentReader;
  readonly after: ContentReader;
  readonly previousMode: FileMode;
  readonly mode: FileMode;
}

/** The project removes a path that exists before this step. */
export interface DeleteChange extends ChangeBase {
  readonly kind: 'delete';
  readonly before: ContentReader;
  readonly previousMode: FileMode;
}

/** One step on one engine path. Narrow on `kind` to reach the readers it has. */
export type OwnedChange = CreateChange | ModifyChange | DeleteChange;

/**
 * A waiver of one lint rule for a group: the rule ID, which waives it at any
 * size, or a ceiling, which waives a measured size rule only while its
 * measurement stays at or below `max` (one ceiling per `share` for
 * `large-patch-lines`).
 */
export type LintIgnoreEntry =
  | string
  | {
      readonly rule: string;
      readonly max: number;
      readonly reason: string;
      readonly share?: 'product' | 'test';
      readonly meta?: ChangeMeta;
    };

/** A unit of ownership: a patch of the queue, or a source-mode component. */
export interface ChangeGroup {
  /** Unique within the set: the patch filename, or the component name. */
  readonly id: string;
  /** Size tier the group is held to instead of the one its files imply. */
  readonly tier?: 'branding';
  /**
   * False when the group's extent is no statement about scope, such as
   * created files grouped for an export: the rules that bound a group's size
   * then leave its files to the per-file rules.
   */
  readonly sized?: false;
  /** Lint rules waived for this group's changes. */
  readonly lintIgnore?: readonly LintIgnoreEntry[];
  readonly meta: ChangeMeta;
}

/**
 * Produces the unified diff of a change. It must accept any change the set
 * hands out, including the net changes {@link ChangeSet.net} derives, whose
 * readers it may use to compute the diff.
 */
export type DiffProvider = (change: OwnedChange) => Promise<string>;

/** What a provider hands {@link createChangeSet}. */
export interface ChangeSetInput {
  /** The groups in application order. Defaults to none. */
  readonly groups?: readonly ChangeGroup[];
  /** The steps, in any order. */
  readonly changes: readonly OwnedChange[];
  /** How to produce a change's unified diff, when the provider can. */
  readonly diff?: DiffProvider;
}

/** The owned changes of a project. Immutable. */
export interface ChangeSet {
  /** Groups in application order. */
  readonly groups: readonly ChangeGroup[];
  /** Every step, in application order: by group order, ungrouped last, then by path. */
  readonly changes: readonly OwnedChange[];
  /** The provider's diff function, or undefined when it has none. */
  readonly diff: DiffProvider | undefined;
  /** The group with this ID. */
  group(id: string): ChangeGroup | undefined;
  /** The steps of one group, by path. */
  inGroup(id: string): readonly OwnedChange[];
  /** Every step on one path, in application order; empty when the project does not own it. */
  at(path: string): readonly OwnedChange[];
  /** The net change on one path, or undefined when its steps cancel out or there are none. */
  final(path: string): OwnedChange | undefined;
  /** One net change per owned path, by path; paths whose steps cancel out are left out. */
  net(): readonly OwnedChange[];
}

const NEXT_KINDS: Readonly<Record<ChangeKind, readonly ChangeKind[]>> = {
  create: ['modify', 'delete'],
  modify: ['modify', 'delete'],
  delete: ['create'],
};

/**
 * Combines the steps on one path into the change from the pin to the result.
 * A create followed eventually by a delete cancels out. The net change keeps
 * the earliest step's group and meta: the group that brought the path in.
 * A modify whose steps restore the upstream bytes is still a modify; only
 * reading the content can tell.
 *
 * @param steps - The steps on one path, in application order, at least one
 */
export function netChange(steps: readonly OwnedChange[]): OwnedChange | undefined {
  const first = steps[0];
  const last = steps.at(-1);
  invariant(first !== undefined && last !== undefined, 'a net change needs at least one step');
  if (steps.length === 1) return first;
  const base = {
    path: first.path,
    binary: steps.some((step) => step.binary),
    ...(first.group === undefined ? {} : { group: first.group }),
    meta: first.meta,
  };
  if (first.kind === 'create') {
    return last.kind === 'delete'
      ? undefined
      : { ...base, kind: 'create', after: last.after, mode: last.mode };
  }
  if (last.kind === 'delete') {
    return { ...base, kind: 'delete', before: first.before, previousMode: first.previousMode };
  }
  return {
    ...base,
    kind: 'modify',
    before: first.before,
    previousMode: first.previousMode,
    after: last.after,
    mode: last.mode,
  };
}

/**
 * Decodes content as text: UTF-8 without a byte-order mark, or undefined when
 * it is not valid UTF-8 or holds a NUL byte, as binary content does.
 *
 * @param bytes - Content from a {@link ContentReader}
 */
export function textContent(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function comparePaths(a: OwnedChange, b: OwnedChange): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** Refuses an input no consistent storage can produce: these are provider bugs. */
function assertConsistent(
  groups: readonly ChangeGroup[],
  byPath: ReadonlyMap<string, readonly OwnedChange[]>
): void {
  const ids = new Set(groups.map((group) => group.id));
  invariant(ids.size === groups.length, 'change groups have duplicate IDs');
  for (const [path, steps] of byPath) {
    for (const [index, step] of steps.entries()) {
      invariant(
        step.group === undefined || ids.has(step.group),
        () => `change to ${path} names unknown group "${step.group ?? ''}"`
      );
      invariant(
        steps.length === 1 || step.group !== undefined,
        () => `${path} has several steps, so every step needs a group`
      );
      const previous = steps[index - 1];
      if (previous === undefined) continue;
      invariant(
        previous.group !== step.group,
        () => `group "${step.group ?? ''}" has two steps on ${path}`
      );
      invariant(
        NEXT_KINDS[previous.kind].includes(step.kind),
        () => `${path}: a ${step.kind} cannot follow a ${previous.kind}`
      );
    }
  }
}

/**
 * Builds a change set from a provider's steps, ordering them by group and
 * indexing them by path and group.
 *
 * @param input - See {@link ChangeSetInput}
 * @throws An internal error when the steps are inconsistent: duplicate group
 *   IDs, a step naming an unknown group, two steps of one group on one path,
 *   an ungrouped step beside others on its path, or an impossible sequence
 *   (a modify after a delete, a create after a create)
 */
export function createChangeSet(input: ChangeSetInput): ChangeSet {
  const groups = [...(input.groups ?? [])];
  const order = new Map(groups.map((group, index) => [group.id, index]));
  const rank = (change: OwnedChange): number =>
    change.group === undefined ? groups.length : (order.get(change.group) ?? groups.length);
  const changes = [...input.changes].sort((a, b) => rank(a) - rank(b) || comparePaths(a, b));
  const byPath = new Map<string, OwnedChange[]>();
  const byGroup = new Map<string, OwnedChange[]>();
  for (const change of changes) {
    byPath.set(change.path, [...(byPath.get(change.path) ?? []), change]);
    if (change.group !== undefined) {
      byGroup.set(change.group, [...(byGroup.get(change.group) ?? []), change]);
    }
  }
  assertConsistent(groups, byPath);
  const net = new Map<string, OwnedChange>();
  for (const [path, steps] of [...byPath].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const change = netChange(steps);
    if (change !== undefined) net.set(path, change);
  }
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const netList = [...net.values()];
  return {
    groups,
    changes,
    diff: input.diff,
    group: (id) => groupById.get(id),
    inGroup: (id) => byGroup.get(id) ?? [],
    at: (path) => byPath.get(path) ?? [],
    final: (path) => net.get(path),
    net: () => netList,
  };
}
