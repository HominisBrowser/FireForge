// SPDX-License-Identifier: EUPL-1.2
/**
 * Edits of the files a project tracks: `components/`, `furnace.json`, the
 * typing files, and the engine files a component brings along (its tests
 * and their manifests). Each command's edits run as one transaction under
 * the project's Furnace edit lock, so a failure or a signal leaves every
 * file as it was. A dry run runs the same edits against a transaction that
 * only records what it is asked to change and keeps those changes in memory,
 * so the later steps of the edit (the generated typing files) read the
 * project as the edit leaves it.
 *
 * An engine file the project tracks is stored differently per mode: in
 * patch mode it is `engine/<path>` itself, in source mode `src/<path>`
 * behind an override record. Furnace never asks which; the caller hands it
 * a {@link TrackedFiles} that knows.
 */
import { dirname, join, relative, resolve } from 'node:path';

import { isInside, listDir, readTextIfExists, toPosixPath } from '../kernel/fs.js';
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

/** How an edit reads the project's files: as they are on disk, or as a dry run's edits leave them. */
export interface ProjectView {
  /** The text of a file, or undefined when it does not exist. */
  readText(path: string): Promise<string | undefined>;
  /** The names of the regular files directly in a directory; a missing directory lists as empty. */
  listFiles(dir: string): Promise<string[]>;
}

/** The project's files as they are on disk. */
export const diskView: ProjectView = {
  readText: readTextIfExists,
  listFiles: async (dir) =>
    (await listDir(dir)).filter((entry) => entry.kind === 'file').map((entry) => entry.name),
};

/** The edits a dry run would have made, laid over the disk. */
class Overlay implements ProjectView {
  private readonly written = new Map<string, string>();
  private readonly removed: string[] = [];

  set(path: string, content: string | Uint8Array): void {
    this.written.set(
      resolve(path),
      typeof content === 'string' ? content : Buffer.from(content).toString('utf8')
    );
  }

  delete(path: string): void {
    const gone = resolve(path);
    for (const file of [...this.written.keys()]) {
      if (isInside(gone, file)) this.written.delete(file);
    }
    this.removed.push(gone);
  }

  private hidden(path: string): boolean {
    return this.removed.some((gone) => isInside(gone, path));
  }

  async readText(path: string): Promise<string | undefined> {
    const at = resolve(path);
    const text = this.written.get(at);
    if (text !== undefined) return text;
    return this.hidden(at) ? undefined : readTextIfExists(at);
  }

  async listFiles(dir: string): Promise<string[]> {
    const at = resolve(dir);
    const names = new Set(this.hidden(at) ? [] : await diskView.listFiles(at));
    for (const file of this.written.keys()) {
      if (dirname(file) === at) names.add(file.slice(at.length + 1));
    }
    return [...names].sort();
  }
}

/** A transaction that passes every change on to `inner` (or, without one, keeps it in `overlay`) and records the paths. */
function recording(
  inner: Transaction | undefined,
  paths: string[],
  overlay?: Overlay
): Transaction {
  const note = (path: string): void => {
    if (!paths.includes(path)) paths.push(path);
  };
  return {
    async write(path, content, options) {
      note(path);
      overlay?.set(path, content);
      await inner?.write(path, content, options);
    },
    async remove(path) {
      note(path);
      overlay?.delete(path);
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
 * @param body - Makes the edits through the transaction and returns notes for the operator; it
 *   reads files it has changed through the view, which in a dry run holds those changes
 */
export async function editProject(
  project: FurnaceProject,
  label: string,
  options: EditOptions,
  body: (tx: Transaction, view: ProjectView) => Promise<string[]>
): Promise<EditResult> {
  const { root, stateDir } = project.paths;
  const paths: string[] = [];
  const report = (notes: string[]): EditResult => ({
    paths: paths.map((path) => toPosixPath(relative(root, path))),
    notes,
  });
  if (options.dryRun === true) {
    const overlay = new Overlay();
    return report(await body(recording(undefined, paths, overlay), overlay));
  }
  const lock = {
    label: 'furnace edit',
    ...(options.waitMs === undefined ? {} : { waitMs: options.waitMs }),
  };
  const notes = await withLock(join(stateDir, 'furnace-edit.lock'), lock, () =>
    transaction(join(stateDir, 'furnace-edit.journal'), label, (tx) =>
      body(recording(tx, paths), diskView)
    )
  );
  return report(notes);
}
