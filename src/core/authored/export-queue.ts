// SPDX-License-Identifier: EUPL-1.2
/**
 * A snapshot as an ordered patch queue, for whatever still consumes one: a public
 * export whose CI runs `fireforge import`, or a rollback to legacy mode.
 *
 * Each path is in exactly one patch, so nothing depends on another patch's
 * context. A patch's name and bytes depend only on its own files, so a change to
 * one file changes one patch, and adding a group renames nothing:
 *
 * - Every upstream component is one patch, order 1, named after the component.
 *   Components never share a path, so their order among themselves is free.
 * - The files the project created (and undeclared generated files) follow at
 *   order 2, because a created file can take the place of an upstream path a
 *   component deletes. A file joins the first `exportQueue.groups` entry one of
 *   whose globs it matches; the rest are grouped by directory, the deepest
 *   directory whose patch stays within `exportQueue.maxGroupBytes`.
 *
 * Patches of one order apply in name order. The snapshot id is recorded once, as
 * the manifest's `source`. The queue is a function of the snapshot: exporting it
 * twice gives the same bytes.
 */
import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { GeneralError } from '../../errors/base.js';
import type { PatchesManifest, PatchMetadata } from '../../types/commands/index.js';
import type { ExportQueueConfig } from '../../types/config.js';
import { getNodeErrorCode } from '../../utils/errors.js';
import { matchesAnyGlob } from '../../utils/path-glob.js';
import { savePatchesManifest } from '../patch-manifest-io.js';
import { validatePatchesManifest } from '../patch-manifest-validate.js';
import { generateAuthoredDelta, sliceDiffByPath } from './generate.js';
import { pristineRepositoryFor, readSourceBlobs, sourceGit } from './git.js';
import { replayQueue } from './migrate.js';
import { authenticateAuthoredSnapshot } from './provider.js';
import type { AuthoredFile, AuthoredSnapshot } from './types.js';

/** A fixed time, so the manifest is a function of the snapshot. */
const QUEUE_CREATED_AT = '2000-01-01T00:00:00.000Z';
/** Order of every component patch. */
const COMPONENT_ORDER = 1;
/** Order of every created-file patch: after every component. */
const CREATED_ORDER = 2;
/** Default byte budget of a directory group of created files. */
const DEFAULT_MAX_GROUP_BYTES = 1024 * 1024;

export interface ExportedQueue {
  destination: string;
  patches: number;
  paths: number;
}

/** One patch of the queue before it is numbered and written. */
interface QueueGroup {
  order: number;
  category: string;
  name: string;
  description: string;
  paths: string[];
}

/** Code-unit order, which no locale changes. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Lowercase words joined by hyphens. */
function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** `012-ui-sidebar.patch` or `ui-sidebar` as a category and name. */
function patchLabel(component: string): { category: string; name: string } {
  const label = slug(component.replace(/\.patch$/, '').replace(/^\d+-/, ''));
  const match = /^([a-z]+)-(.+)$/.exec(label);
  return match?.[1] && match[2]
    ? { category: match[1], name: match[2] }
    : { category: 'infra', name: label || 'source' };
}

function append(groups: Map<string, string[]>, key: string, path: string): void {
  groups.set(key, [...(groups.get(key) ?? []), path]);
}

/** One patch per upstream component, for the paths the delta changes. */
function componentGroups(files: readonly AuthoredFile[]): QueueGroup[] {
  const byComponent = new Map<string, string[]>();
  for (const file of files)
    if (file.declaration) append(byComponent, file.declaration.component, file.path);
  return [...byComponent].map(([component, paths]) => ({
    order: COMPONENT_ORDER,
    ...patchLabel(component),
    description: `Upstream changes of component ${component}`,
    paths,
  }));
}

/**
 * Splits created files by directory: the whole subtree when its patch fits the
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
  for (const [child, list] of [...children].sort(([a], [b]) => compare(a, b)))
    directoryGroups(child, list, budget, size, out);
}

/** Patches of the files the project created: named groups first, then directories. */
function createdGroups(
  paths: readonly string[],
  settings: ExportQueueConfig | undefined,
  size: (path: string) => number
): QueueGroup[] {
  const named = new Map<string, string[]>();
  const rest: string[] = [];
  for (const path of paths) {
    const group = settings?.groups?.find((entry) => matchesAnyGlob(path, entry.paths));
    if (group) append(named, group.name, path);
    else rest.push(path);
  }
  const byDirectory = new Map<string, string[]>();
  if (rest.length > 0)
    directoryGroups(
      '',
      rest,
      settings?.maxGroupBytes ?? DEFAULT_MAX_GROUP_BYTES,
      size,
      byDirectory
    );
  return [
    ...[...named].map(([name, members]) => ({
      order: CREATED_ORDER,
      ...patchLabel(name),
      description: `Created files of group ${name}`,
      paths: members,
    })),
    ...[...byDirectory].map(([directory, members]) => ({
      order: CREATED_ORDER,
      category: 'created',
      name: slug(directory) || 'root',
      description: directory === '' ? 'Created files' : `Created files under ${directory}/`,
      paths: members,
    })),
  ];
}

/** Every patch with its file name, in apply order; two groups may not share a name. */
function planQueue(
  snapshot: AuthoredSnapshot,
  sections: ReadonlyMap<string, string>
): (QueueGroup & { filename: string })[] {
  const changed = snapshot.files.filter((file) => sections.has(file.path));
  const created = changed.filter((file) => !file.declaration).map((file) => file.path);
  const groups = [
    ...componentGroups(changed),
    ...createdGroups(created, snapshot.config.exportQueue, (path) =>
      Buffer.byteLength(sections.get(path) ?? '')
    ),
  ];
  const planned = new Map<string, QueueGroup & { filename: string }>();
  for (const group of groups) {
    const filename = `${String(group.order).padStart(3, '0')}-${group.category}-${group.name}.patch`;
    const other = planned.get(filename);
    if (other)
      throw new GeneralError(
        `authored-export-queue-name-collision: ${filename} would hold both "${other.description}" and "${group.description}"; rename a component or an exportQueue group`
      );
    planned.set(filename, { ...group, filename, paths: [...group.paths].sort(compare) });
  }
  return [...planned.values()].sort((a, b) => a.order - b.order || compare(a.filename, b.filename));
}

/** Replays the patch bodies onto pristine bytes and compares every path with the snapshot. */
async function proveReplay(
  snapshot: AuthoredSnapshot,
  pristineRepository: string,
  patches: readonly { name: string; body: Buffer }[]
): Promise<void> {
  const staging = await mkdtemp(join(tmpdir(), 'fireforge-export-queue-'));
  try {
    await sourceGit(staging, ['init', '-q']);
    await replayQueue({
      staging,
      pristineRepository,
      commit: snapshot.pin.commit,
      affected: new Set(snapshot.files.map((file) => file.path)),
      patches,
    });
    const blobs = await readSourceBlobs(
      snapshot.repository,
      snapshot.files.flatMap((file) => (file.blob ? [file.blob] : []))
    );
    for (const file of snapshot.files) {
      const path = join(staging, file.path);
      const written = await readFile(path).catch((error: unknown) => {
        if (getNodeErrorCode(error) === 'ENOENT') return undefined;
        throw error;
      });
      const expected = file.blob === undefined ? undefined : blobs.get(file.blob);
      const executable = written === undefined ? false : ((await lstat(path)).mode & 0o111) !== 0;
      if (
        (written === undefined) !== (expected === undefined) ||
        (written !== undefined && expected !== undefined && !written.equals(expected)) ||
        (expected !== undefined && executable !== (file.mode === '100755'))
      )
        throw new GeneralError(
          `authored-export-queue-mismatch: replaying the queue does not reproduce ${file.path}`
        );
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Writes a snapshot as `patches.json` plus its patches into a directory
 * that must be absent or empty, after proving that the queue replays onto the
 * pinned pristine bytes to exactly the snapshot's bytes and modes.
 */
export async function exportAuthoredQueue(options: {
  snapshot: AuthoredSnapshot;
  destination: string;
  pristineRepository?: string;
}): Promise<ExportedQueue> {
  const destination = resolve(options.destination);
  const pristineRepository = pristineRepositoryFor(
    options.snapshot.repository,
    options.pristineRepository
  );
  const snapshot = await authenticateAuthoredSnapshot(options.snapshot, pristineRepository);
  if ((await readdir(destination).catch(() => [])).length > 0)
    throw new GeneralError(`authored-export-queue-destination-not-empty: ${destination}`);
  const diff = await generateAuthoredDelta(snapshot, { pristineRepository });
  const sections = sliceDiffByPath(diff);
  const { firefox } = snapshot.pin;
  const patches: { name: string; body: Buffer }[] = [];
  const rows: PatchMetadata[] = [];
  for (const group of planQueue(snapshot, sections)) {
    patches.push({
      name: group.filename,
      body: Buffer.from(group.paths.map((path) => sections.get(path) ?? '').join('')),
    });
    rows.push({
      filename: group.filename,
      order: group.order,
      category: group.category,
      name: group.name,
      description: group.description,
      createdAt: QUEUE_CREATED_AT,
      sourceEsrVersion: firefox.version,
      sourceProduct: firefox.product,
      sourceVersion: firefox.version,
      filesAffected: group.paths,
    });
  }
  await proveReplay(snapshot, pristineRepository, patches);
  const manifest: PatchesManifest = validatePatchesManifest({
    version: 1,
    source: { snapshot: snapshot.id },
    patches: rows,
  });
  await mkdir(dirname(destination), { recursive: true });
  const output = `${destination}.queue-${randomUUID()}`;
  await mkdir(output);
  try {
    for (const patch of patches) await writeFile(join(output, patch.name), patch.body);
    await savePatchesManifest(output, manifest);
    await rmdir(destination).catch((error: unknown) => {
      if (getNodeErrorCode(error) !== 'ENOENT') throw error;
    });
    await rename(output, destination);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
  return {
    destination,
    patches: patches.length,
    paths: rows.flatMap((row) => row.filesAffected).length,
  };
}
