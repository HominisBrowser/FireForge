// SPDX-License-Identifier: EUPL-1.2
/**
 * The workspace: an engine with its object directory, at a stable path, that
 * a command builds and tests in. A patch-mode project has one, its `engine/`;
 * a source-mode project leases one from the host pool (`pool.ts`). Everything
 * that builds, runs or tests takes a {@link Workspace} and never asks which
 * kind it is.
 */
import { join } from 'node:path';

import { ExitCode, FireForgeError } from '../kernel/errors.js';
import { exists } from '../kernel/fs.js';
import { COMMAND_WAIT_MS, type LockMode, withLock } from '../kernel/lock.js';
import type { PatchProject, Project, ProjectPaths } from '../project/index.js';

/** Name of the development object directory inside every engine. */
export const OBJDIR_NAME = 'obj-fireforge';

/** An engine a command works in for its duration. */
export interface Workspace {
  /** `engine` for a patch-mode project's own engine, else the pool name. */
  readonly name: string;
  readonly kind: 'project' | 'pool';
  /** The Firefox checkout with the project's changes applied. */
  readonly engineDir: string;
  /** The development object directory, `<engineDir>/obj-fireforge`. It exists once a build ran. */
  readonly objDir: string;
  /** The object directory of release builds, kept apart from the development one. */
  readonly releaseObjDir: string;
  /** Where the workspace keeps its state: the project's `.fireforge/`, or the pool entry. */
  readonly stateDir: string;
  /**
   * The workspace's state document, in the shape `readState` and
   * `updateState` of the project module take: a module keeps what it records
   * about a workspace (the build baseline, the materialized paths) in a
   * section of its own, `readState(workspace, section)`.
   */
  readonly paths: { readonly state: string; readonly stateDir: string };
  /** The project whose source the engine holds: its configuration and `configs/` drive the build. */
  readonly project: Project;
}

/**
 * The workspace value for an engine directory.
 *
 * @param project - The project building in it
 * @param place - Its name, kind, engine directory and state location
 */
export function workspaceAt(
  project: Project,
  place: Pick<Workspace, 'name' | 'kind' | 'engineDir' | 'stateDir'> & { stateFile: string }
): Workspace {
  return {
    name: place.name,
    kind: place.kind,
    engineDir: place.engineDir,
    objDir: join(place.engineDir, OBJDIR_NAME),
    releaseObjDir: join(place.stateDir, 'release', 'obj'),
    stateDir: place.stateDir,
    paths: { state: place.stateFile, stateDir: place.stateDir },
    project,
  };
}

/**
 * Where the engine lock of a patch-mode project lives, for reading who holds it.
 *
 * @param project - The project
 */
export function engineLockPath(project: {
  readonly paths: Pick<ProjectPaths, 'stateDir'>;
}): string {
  return join(project.paths.stateDir, 'locks', 'engine');
}

/** How a command takes its workspace. */
export interface WorkspaceWait {
  /** How long to wait for the workspace, in milliseconds (default {@link COMMAND_WAIT_MS}). */
  waitMs?: number | undefined;
  /** The command, shown to whoever waits on this one. */
  command?: string | undefined;
}

/** How {@link withEngineLock} takes the lock (default wait 30 000 ms). */
export interface EngineLockOptions extends WorkspaceWait {
  /** `exclusive` (default) to change the engine or the queue, `shared` to read them. */
  mode?: LockMode | undefined;
}

/**
 * Runs `body` holding the engine lock: the one lock of a patch-mode project,
 * over `engine/` and `patches/` together. A command that changes either, or
 * builds, holds it exclusively; a command that only reads them holds it
 * shared, so readers overlap each other but never a writer.
 *
 * @param project - The project
 * @param options - See {@link EngineLockOptions}
 * @param body - The work
 * @throws `lock-timeout` (exit code 15) naming the holder when the wait expires
 */
export function withEngineLock<T>(
  project: { readonly paths: Pick<ProjectPaths, 'stateDir'> },
  options: EngineLockOptions,
  body: () => Promise<T>
): Promise<T> {
  return withLock(
    engineLockPath(project),
    {
      mode: options.mode ?? 'exclusive',
      label: 'engine',
      ...(options.waitMs === undefined ? {} : { waitMs: options.waitMs }),
      info: { ...(options.command === undefined ? {} : { command: options.command }) },
    },
    body
  );
}

/**
 * Runs `body` in a patch-mode project's `engine/`, holding the engine lock.
 *
 * @param project - The project
 * @param options - See {@link EngineLockOptions}
 * @param body - The work
 * @throws `engine-missing` (exit code 1) when the project has no engine yet,
 *   `lock-timeout` (exit code 15) when another command holds it
 */
export async function withProjectWorkspace<T>(
  project: PatchProject,
  options: EngineLockOptions,
  body: (workspace: Workspace) => Promise<T>
): Promise<T> {
  const engineDir = project.paths.engine;
  if (!(await exists(join(engineDir, 'mach')))) {
    throw new FireForgeError('engine-missing', `There is no Firefox source at ${engineDir}`, {
      exitCode: ExitCode.GENERAL_ERROR,
      hint: 'Run "fireforge download" first.',
    });
  }
  const workspace = workspaceAt(project, {
    name: 'engine',
    kind: 'project',
    engineDir,
    stateDir: project.paths.stateDir,
    stateFile: project.paths.state,
  });
  return withEngineLock(project, { ...options, waitMs: options.waitMs ?? COMMAND_WAIT_MS }, () =>
    body(workspace)
  );
}
