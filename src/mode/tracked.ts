// SPDX-License-Identifier: EUPL-1.2
/**
 * The engine files a project tracks, for the commands that edit them
 * (`register`, `wire`, `token`, `furnace`). Patch mode edits `engine/`
 * itself. Source mode edits the owned copy under the source root, read over
 * the pristine bytes.
 *
 * An upstream file is owned only behind an override record. The helpers
 * whose edits are registrations by definition (build manifests, wiring,
 * component registration) pass `declare`, and their first touch of an
 * upstream file writes the record as `fireforge override <path>` would,
 * classified `registration`. Without `declare` such a write is refused
 * with that command as the hint.
 */
import { isAbsolute, join, posix, relative } from 'node:path';

import { listPristineTree, type Pristine, withEngineLock } from '../engine/index.js';
import { ExitCode, FireForgeError } from '../kernel/errors.js';
import { exists, isInside, readTextIfExists, resolveContained, toPosixPath } from '../kernel/fs.js';
import { type Transaction, transaction } from '../kernel/journal.js';
import type { Project, SourceProject, TrackedFiles } from '../project/index.js';
import { override, readSourceFile, writeSourceFile } from '../source/index.js';
import { pinnedPristine } from './pristine.js';

/** The directory holding the project's tracked engine files: `engine/`, or the source root. */
function trackedDir(project: Project): string {
  return project.mode === 'patches' ? project.paths.engine : project.paths.source;
}

function sourceFiles(project: SourceProject, pristine: Pristine, declare: boolean): TrackedFiles {
  const read = (path: string): Promise<Buffer | undefined> =>
    readSourceFile(project, pristine, path);
  return {
    read: async (path) => (await read(path))?.toString('utf8'),
    exists: async (path) => (await read(path)) !== undefined,
    async write(tx, path, content) {
      const bytes = Buffer.from(content, 'utf8');
      try {
        await writeSourceFile(project, pristine, path, bytes, { tx });
      } catch (error: unknown) {
        const undeclared =
          error instanceof FireForgeError && error.code === 'source-override-required';
        if (!undeclared || !declare) throw error;
        await override(project, pristine, path, { tx });
        await writeSourceFile(project, pristine, path, bytes, { tx });
      }
    },
    async remove(tx, path) {
      if ((await listPristineTree(pristine, [path])).some((entry) => entry.path === path)) {
        throw new FireForgeError(
          'source-upstream-file',
          `${path} is an upstream file; removing it is a declared deletion.`,
          {
            exitCode: ExitCode.INVALID_ARGUMENT,
            hint: `Run "fireforge override --delete ${path}", or "fireforge restore ${path}" to give an override back.`,
          }
        );
      }
      await tx.remove(join(project.paths.source, path));
    },
    locate: (path) => join(project.paths.source, path),
  };
}

/**
 * The writer for the engine files the project tracks.
 *
 * @param project - The project
 * @param options - `declare`: in source mode, declare the first touch of an
 *   upstream file as a registration instead of refusing it
 * @throws `pristine-missing` in source mode before `download`
 */
export async function trackedFiles(
  project: Project,
  options: { declare?: boolean } = {}
): Promise<TrackedFiles> {
  if (project.mode === 'source') {
    return sourceFiles(project, await pinnedPristine(project), options.declare === true);
  }
  const engine = project.paths.engine;
  return {
    read: (path) => readTextIfExists(join(engine, path)),
    exists: (path) => exists(join(engine, path)),
    write: async (tx, path, content) => tx.write(await resolveContained(engine, path), content),
    remove: async (tx, path) => tx.remove(await resolveContained(engine, path)),
    locate: (path) => join(engine, path),
  };
}

/**
 * The engine-relative POSIX path for a path as the user typed it:
 * engine-relative, prefixed with the tracked directory (`engine/…`,
 * `src/…`), or absolute inside it.
 *
 * @param project - The project
 * @param input - The path as typed
 * @throws `invalid-argument` (exit code 8) for a path outside the engine
 */
export function enginePathOf(project: Project, input: string): string {
  const dir = trackedDir(project);
  const prefix = `${toPosixPath(relative(project.root, dir))}/`;
  const typed = input.replaceAll('\\', '/').replace(/^\.\//, '');
  const text = isAbsolute(input)
    ? toPosixPath(relative(dir, input))
    : typed.startsWith(prefix)
      ? typed.slice(prefix.length)
      : typed;
  const path = posix.normalize(text);
  if (path === '.' || path === '..' || path.startsWith('../') || !isInside(dir, path)) {
    throw new FireForgeError('invalid-argument', `Path is outside the engine: ${input}`, {
      exitCode: ExitCode.INVALID_ARGUMENT,
    });
  }
  return path;
}

/**
 * Runs an edit of tracked files as one transaction: every write lands, or
 * none. Patch mode holds the engine lock exclusively for it.
 *
 * @param project - The project
 * @param options - `label` names the edit in messages; `command` and `waitMs` are for the lock
 * @param body - Makes the edits through the transaction
 */
export function editTracked<T>(
  project: Project,
  options: { label: string; command: string; waitMs?: number | undefined },
  body: (tx: Transaction) => Promise<T>
): Promise<T> {
  const run = (): Promise<T> =>
    transaction(join(project.paths.stateDir, 'tracked-edit.journal'), options.label, body);
  return project.mode === 'patches'
    ? withEngineLock(project, { command: options.command, waitMs: options.waitMs }, run)
    : run();
}
