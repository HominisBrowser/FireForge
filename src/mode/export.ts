// SPDX-License-Identifier: EUPL-1.2
/**
 * `export` in either mode. A source-mode project's owned changes are
 * written as a patch queue, proven to replay to the tree the checkout
 * builds. A patch-mode project captures engine edits no patch holds into a
 * new patch of its queue.
 */
import { basename } from 'node:path';

import { type Pristine, withEngineLock } from '../engine/index.js';
import { changedPaths, writeTree } from '../git/index.js';
import { ExitCode, FireForgeError } from '../kernel/errors.js';
import { listDir, move, pathInfo, remove, tempPathFor } from '../kernel/fs.js';
import { warn } from '../kernel/log.js';
import type { ChangeSet, SourceProject } from '../project/index.js';
import type { Project } from '../project/index.js';
import {
  exportPatch,
  type LintIgnoreEntry,
  readQueue,
  replayQueue,
  writeQueue,
} from '../queue/index.js';
import { planQueueExport, requireSourceMode } from '../source/index.js';
import { ownedChanges } from './changes.js';
import { pinnedPristine } from './pristine.js';

/** What {@link exportQueue} wrote. */
export type QueueExport = {
  /** The queue directory. */
  out: string;
  patches: { filename: string; files: string[] }[];
  /** Identifies the owned content the queue was generated from. */
  digest: string;
};

/**
 * The tree an engine at the pristine commit holds with the owned changes
 * applied, written into the pristine repository's object store.
 *
 * @param pristine - The pinned pristine repository
 * @param changes - The owned changes, one step per path
 */
export async function ownedTree(pristine: Pristine, changes: ChangeSet): Promise<string> {
  const edits = await Promise.all(
    changes.changes.map(async (change) =>
      change.kind === 'delete'
        ? { path: change.path, remove: true as const }
        : { path: change.path, content: await change.after(), mode: change.mode }
    )
  );
  return writeTree(pristine.repo, edits, pristine.commit);
}

/**
 * Refuses to replace a directory that holds anything but a generated queue,
 * or that holds entries of its own beside one (notes, assets): replacing it
 * would delete them.
 *
 * @param out - The directory an export replaces
 * @param staging - The new queue; what it holds beside its patches are the files every generated queue has
 */
async function assertReplaceable(out: string, staging: string): Promise<void> {
  const entries = await listDir(out);
  if (entries.length === 0) return;
  const earlier = await readQueue(out).then(
    (queue) => (queue.source === undefined ? undefined : queue),
    () => undefined
  );
  if (earlier === undefined) {
    throw new FireForgeError(
      'export-target-not-generated',
      `${out} holds something other than a generated patch queue.`,
      {
        exitCode: ExitCode.INVALID_ARGUMENT,
        hint: 'Export into an empty directory with --out, or remove it first.',
      }
    );
  }
  // A file is the earlier export's own when its manifest lists it as a patch,
  // or when it is one of the files a queue has beside its patches. The names
  // of the patches being written say nothing about what is there now.
  const written = new Set((await readQueue(staging)).patches.map((patch) => basename(patch.path)));
  const accounted = new Set([
    ...(await listDir(staging)).map((entry) => entry.name).filter((name) => !written.has(name)),
    ...earlier.patches.map((patch) => basename(patch.path)),
  ]);
  const foreign = entries.filter((entry) => !accounted.has(entry.name));
  if (foreign.length > 0) {
    throw new FireForgeError(
      'export-target-has-other-files',
      `${out} holds ${foreign.length} entr${foreign.length === 1 ? 'y' : 'ies'} that are not part of the generated queue and would be deleted: ` +
        foreign.map((entry) => entry.name).join(', '),
      {
        exitCode: ExitCode.INVALID_ARGUMENT,
        hint: 'Move them elsewhere, or export into an empty directory with --out.',
      }
    );
  }
}

/**
 * Puts a staged directory in place of `target`. The previous one is moved
 * aside next to it first and removed only after the new one is in place; if
 * the new one cannot be moved in, the previous one is put back.
 *
 * @param staging - The finished replacement, on the same filesystem as `target`
 * @param target - The directory to replace
 */
export async function replaceDirectory(staging: string, target: string): Promise<void> {
  if ((await pathInfo(target)) === undefined) {
    await move(staging, target);
    return;
  }
  const aside = tempPathFor(target);
  await move(target, aside);
  try {
    await move(staging, target);
  } catch (error) {
    await move(aside, target).catch(() => {
      warn(`The previous export was left at ${aside}.`);
    });
    throw error;
  }
  await remove(aside).catch(() => {
    warn(`The previous export could not be removed from ${aside}.`);
  });
}

async function writeVerified(project: SourceProject, out: string): Promise<QueueExport> {
  const pristine = await pinnedPristine(project);
  const plan = await planQueueExport(project, pristine);
  const changes = await ownedChanges(project);
  const { product, version } = project.config.firefox;
  const staging = tempPathFor(out);
  try {
    const queue = await writeQueue(staging, {
      source: { snapshot: plan.manifestSource.digest },
      patches: plan.patches.map((patch, index) => {
        const group = changes.group(patch.group);
        return {
          order: index + 1,
          name: patch.name,
          description: patch.description,
          firefox: { product, version },
          ...(group?.tier === undefined ? {} : { tier: group.tier }),
          ...(group?.lintIgnore === undefined
            ? {}
            : { lintIgnore: group.lintIgnore as LintIgnoreEntry[] }),
          body: patch.body,
        };
      }),
    });
    const replayed = await replayQueue(pristine.repo, pristine.commit, staging);
    const expected = await ownedTree(pristine, changes);
    if (replayed !== expected) {
      const differing = await changedPaths(pristine.repo, expected, replayed);
      throw new FireForgeError(
        'export-queue-mismatch',
        `The generated queue does not replay to the tree this checkout builds; ${differing.length} path(s) differ: ` +
          `${differing.slice(0, 10).join(', ')}${differing.length > 10 ? ', ...' : ''}`,
        {
          exitCode: ExitCode.PATCH_ERROR,
          hint: 'Nothing was written. Report this: an export must reproduce the owned files.',
        }
      );
    }
    await assertReplaceable(out, staging);
    await replaceDirectory(staging, out);
    return {
      out,
      patches: queue.patches.map((patch) => ({
        filename: patch.filename,
        files: [...patch.files],
      })),
      digest: plan.manifestSource.digest,
    };
  } finally {
    await remove(staging);
  }
}

/** What `export` is asked for; each mode reads its own fields and refuses the other's. */
export interface ExportRequest {
  /** Patch mode: engine files or directories to capture. */
  paths: readonly string[];
  /** Patch mode: capture every edit no patch holds. */
  all: boolean;
  /** Patch mode: the new patch's name. */
  name?: string | undefined;
  /** Patch mode: what the patch does. */
  description?: string | undefined;
  /** Patch mode: where the new patch goes. */
  order?: number | undefined;
  before?: string | undefined;
  after?: string | undefined;
  /** Patch mode: the size tier the patch is held to. */
  tier?: 'branding' | undefined;
  /** Source mode: the queue directory. */
  out?: string | undefined;
  /** Patch mode: how long to wait for the engine lock, in milliseconds. */
  waitMs?: number | undefined;
}

/** What `export` wrote. */
export type ExportOutcome =
  { kind: 'queue'; queue: QueueExport } | { kind: 'patch'; patch: string; files: string[] };

function usage(message: string): FireForgeError {
  return new FireForgeError('invalid-argument', message, { exitCode: ExitCode.INVALID_ARGUMENT });
}

/**
 * `export`: a source-mode project writes its generated queue
 * ({@link exportQueue}); a patch-mode project captures engine edits into a
 * new patch, under the engine lock.
 *
 * @param project - The project
 * @param request - See {@link ExportRequest}
 * @throws `invalid-argument` for a field the project's mode does not take,
 *   and what the mode's export throws
 */
export async function exportChanges(
  project: Project,
  request: ExportRequest
): Promise<ExportOutcome> {
  if (project.mode === 'source') {
    if (request.paths.length > 0 || request.all || request.name !== undefined) {
      throw usage(
        'A source-mode export writes the whole queue; it takes no paths, --all or --name.'
      );
    }
    return { kind: 'queue', queue: await exportQueue(project, { out: request.out }) };
  }
  if (request.out !== undefined) throw usage('--out applies to a source-mode project.');
  const { name } = request;
  if (name === undefined) throw usage('--name is required.');
  if (request.paths.length === 0 && !request.all) {
    throw usage('Name the paths to capture, or pass --all.');
  }
  const result = await withEngineLock(project, { command: 'export', waitMs: request.waitMs }, () =>
    exportPatch(project, {
      name,
      ...(request.paths.length === 0 ? {} : { paths: [...request.paths] }),
      ...(request.all ? { all: true } : {}),
      ...(request.description === undefined ? {} : { description: request.description }),
      ...(request.order === undefined ? {} : { order: request.order }),
      ...(request.before === undefined ? {} : { before: request.before }),
      ...(request.after === undefined ? {} : { after: request.after }),
      ...(request.tier === undefined ? {} : { tier: request.tier }),
    })
  );
  return { kind: 'patch', patch: result.patch.filename, files: [...result.files] };
}

/**
 * Writes the patch queue a source-mode checkout's owned changes export as:
 * the planned patches with a manifest carrying each group's tier and
 * waivers. The queue is first replayed onto the pristine commit and compared
 * with the tree of pristine plus the owned files; a queue that would not
 * reproduce them is refused and nothing is written. An earlier generated
 * queue at `out` is replaced, and kept until the new one is in place.
 *
 * @param project - A source-mode project
 * @param options - `out`: the queue directory (default the project's `patches/`)
 * @throws `source-mode-required`, `source-invalid` while `verify` reports a
 *   problem, `export-queue-mismatch` (exit code 6), `export-target-not-generated`
 *   or `export-target-has-other-files` (exit code 2)
 */
function exportQueue(
  project: Project,
  options: { out?: string | undefined } = {}
): Promise<QueueExport> {
  const source = requireSourceMode(project);
  return writeVerified(source, options.out ?? source.paths.patches);
}
