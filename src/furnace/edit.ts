// SPDX-License-Identifier: EUPL-1.2
/**
 * Edits of the files a project tracks: `components/`, `furnace.json`, the
 * typing files, and the engine files a component brings along (its tests
 * and their manifests). Each command's edits run as one transaction under
 * the project's Furnace edit lock, so a failure or a signal leaves every
 * file as it was. A dry run runs the same edits against a transaction that
 * only records what it is asked to change.
 *
 * An engine file the project tracks is stored differently per mode: in
 * patch mode it is `engine/<path>` itself, in source mode `src/<path>`
 * behind an override record. Furnace never asks which; the caller hands it
 * a {@link TrackedFiles} that knows.
 */
import { join, relative } from 'node:path';

import { toPosixPath } from '../kernel/fs.js';
import { type Transaction, transaction } from '../kernel/journal.js';
import { withLock } from '../kernel/lock.js';
import type { FurnaceProject } from './config.js';

/** How a project edit runs. */
export interface EditOptions {
  /** Record what would change without writing. */
  dryRun?: boolean;
  /** Milliseconds to wait for the project's Furnace edit lock. */
  waitMs?: number | undefined;
}

/** What an edit changed, or for a dry run would change. */
export type EditResult = {
  /** Changed paths, relative to the project root, in the order they were changed. */
  paths: string[];
  /** Things the operator should know or do. */
  notes: string[];
};

/** A transaction that passes every change on to `inner` (or, without one, drops it) and records the paths. */
function recording(inner: Transaction | undefined, paths: string[]): Transaction {
  const note = (path: string): void => {
    if (!paths.includes(path)) paths.push(path);
  };
  return {
    async write(path, content, options) {
      note(path);
      await inner?.write(path, content, options);
    },
    async remove(path) {
      note(path);
      await inner?.remove(path);
    },
    async change(changed, mutate) {
      changed.forEach(note);
      await inner?.change(changed, mutate);
    },
  };
}

/**
 * Runs `body` as one transaction under the project's Furnace edit lock and
 * reports the paths it changed.
 *
 * @param project - The project
 * @param label - What is being done, for messages
 * @param options - See {@link EditOptions}
 * @param body - Makes the edits through the transaction and returns notes for the operator
 */
export async function editProject(
  project: FurnaceProject,
  label: string,
  options: EditOptions,
  body: (tx: Transaction) => Promise<string[]>
): Promise<EditResult> {
  const { root, stateDir } = project.paths;
  const paths: string[] = [];
  const report = (notes: string[]): EditResult => ({
    paths: paths.map((path) => toPosixPath(relative(root, path))),
    notes,
  });
  if (options.dryRun === true) return report(await body(recording(undefined, paths)));
  const lock = {
    label: 'furnace edit',
    ...(options.waitMs === undefined ? {} : { waitMs: options.waitMs }),
  };
  const notes = await withLock(join(stateDir, 'furnace-edit.lock'), lock, () =>
    transaction(join(stateDir, 'furnace-edit.journal'), label, (tx) => body(recording(tx, paths)))
  );
  return report(notes);
}
