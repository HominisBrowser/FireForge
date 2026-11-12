// SPDX-License-Identifier: EUPL-1.2
/**
 * How owned paths group. A group is the unit lint waivers, size tiers and
 * policy rules name, and one patch of an exported queue.
 *
 * Each path is in exactly one group, and a group's ID is a name the project
 * wrote, used as it is:
 *
 * - Every component of upstream changes is one group, whose ID is the
 *   component as the override records spell it.
 * - A created file joins the first `exportQueue.groups` entry one of whose
 *   globs it matches; the group's ID is the entry's name.
 * - The remaining created files group by directory: the deepest directory
 *   whose files fit `exportQueue.maxGroupBytes` together is one group,
 *   `created-<directory>`.
 *
 * An ID depends only on the group's own paths and names, so a change to one
 * file changes one group and adding a group renames nothing. Two groups may
 * not share an ID. What a group is called in an exported queue is derived
 * from its ID by {@link exportedPatchName} and is no part of its identity.
 */
import type { ExportQueueConfig } from '../config/index.js';
import { ExitCode, FireForgeError } from '../kernel/errors.js';
import { matchesAnyGlob } from '../kernel/glob.js';
import { compareText } from './records.js';
import type { SourceEntry } from './tree.js';

/** One group of owned paths: a change-set group and an exported patch. */
export interface PathGroup {
  /** The group's identity: the component, the `exportQueue.groups` name, or `created-<directory>`. */
  readonly id: string;
  /**
   * Where an export applies it: upstream components first, created files
   * after them, because a created file can take the place of an upstream
   * path a component deletes. Groups of one order apply in ID order.
   */
  readonly order: 1 | 2;
  readonly description: string;
  /** `component` for upstream changes, `created` for created files. */
  readonly kind: 'component' | 'created';
  /** Its paths, in code-unit order. */
  readonly paths: readonly string[];
}

type Draft = Omit<PathGroup, 'paths'> & { paths: string[] };

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The name a group's patch takes in an exported queue: the ID in lowercase
 * with every other run of characters as one hyphen. An ID spelled like a
 * patch file (`012-ui-sidebar.patch`) gives that patch's name (`ui-sidebar`).
 *
 * @param id - A group ID
 * @throws `source-group-unexportable` (exit code 2) when what remains does
 *   not start with a letter, which a patch name must
 */
export function exportedPatchName(id: string): string {
  const name = slug(id.replace(/\.patch$/, '').replace(/^\d+-/, ''));
  if (!/^[a-z]/.test(name)) {
    throw new FireForgeError(
      'source-group-unexportable',
      `Group "${id}" cannot be exported: a patch name starts with a letter.`,
      {
        exitCode: ExitCode.CONFIG_ERROR,
        hint: 'Rename the component in its override records, or the exportQueue group.',
      }
    );
  }
  return name;
}

function append(groups: Map<string, string[]>, key: string, path: string): void {
  const list = groups.get(key);
  if (list === undefined) groups.set(key, [path]);
  else list.push(path);
}

/**
 * Splits created files by directory: the whole subtree when it fits the
 * budget, else the directory's own files plus each subdirectory in turn.
 */
function directoryGroups(
  directory: string,
  paths: readonly string[],
  budget: number,
  size: (path: string) => number,
  out: Map<string, string[]>
): void {
  if (paths.reduce((total, path) => total + size(path), 0) <= budget) {
    out.set(directory, [...paths]);
    return;
  }
  const prefix = directory === '' ? '' : `${directory}/`;
  const own: string[] = [];
  const children = new Map<string, string[]>();
  for (const path of paths) {
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) own.push(path);
    else append(children, prefix + rest.slice(0, slash), path);
  }
  if (own.length > 0) out.set(directory, own);
  for (const [child, list] of [...children].sort(([a], [b]) => compareText(a, b))) {
    directoryGroups(child, list, budget, size, out);
  }
}

function createdGroups(entries: readonly SourceEntry[], settings: ExportQueueConfig): Draft[] {
  const named = new Map<string, string[]>();
  const rest: string[] = [];
  const sizes = new Map<string, number>();
  for (const entry of entries) {
    sizes.set(entry.path, entry.file?.size ?? 0);
    const group = settings.groups?.find((candidate) => matchesAnyGlob(entry.path, candidate.paths));
    if (group === undefined) rest.push(entry.path);
    else append(named, group.name, entry.path);
  }
  const byDirectory = new Map<string, string[]>();
  if (rest.length > 0) {
    directoryGroups('', rest, settings.maxGroupBytes, (path) => sizes.get(path) ?? 0, byDirectory);
  }
  return [
    ...[...named].map(([name, paths]): Draft => ({
      id: name,
      order: 2,
      kind: 'created',
      description: `Created files of group ${name}`,
      paths,
    })),
    ...[...byDirectory].map(([directory, paths]): Draft => ({
      id: `created-${slug(directory) === '' ? 'root' : slug(directory)}`,
      order: 2,
      kind: 'created',
      description: directory === '' ? 'Created files' : `Created files under ${directory}/`,
      paths,
    })),
  ];
}

/**
 * Groups owned entries into components and created-file groups.
 *
 * @param entries - The owned entries
 * @param settings - The project's `exportQueue` section
 * @returns The groups in application order
 * @throws `source-group-name-collision` (exit code 2) when two groups would share an ID
 */
export function planGroups(
  entries: readonly SourceEntry[],
  settings: ExportQueueConfig
): PathGroup[] {
  const components = new Map<string, string[]>();
  for (const entry of entries) {
    if (entry.kind !== 'create') append(components, entry.component, entry.path);
  }
  const drafts: Draft[] = [
    ...[...components].map(([component, paths]): Draft => ({
      id: component,
      order: 1,
      kind: 'component',
      description: `Upstream changes of component ${component}`,
      paths,
    })),
    ...createdGroups(
      entries.filter((entry) => entry.kind === 'create'),
      settings
    ),
  ];
  const planned = new Map<string, PathGroup>();
  for (const draft of drafts) {
    const other = planned.get(draft.id);
    if (other !== undefined) {
      throw new FireForgeError(
        'source-group-name-collision',
        `Group "${draft.id}" would hold both "${other.description}" and "${draft.description}".`,
        {
          exitCode: ExitCode.CONFIG_ERROR,
          hint: 'Give the exportQueue group another name than the component, or rename the component in its override records.',
        }
      );
    }
    planned.set(draft.id, { ...draft, paths: [...draft.paths].sort(compareText) });
  }
  return [...planned.values()].sort((a, b) => a.order - b.order || compareText(a.id, b.id));
}
