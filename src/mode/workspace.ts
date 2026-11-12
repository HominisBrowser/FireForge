// SPDX-License-Identifier: EUPL-1.2
/**
 * Giving a command its workspace: the project's `engine/` under the engine
 * lock in patch mode, a pool workspace leased and brought to the checkout's
 * owned files in source mode.
 */
import {
  engineLockPath,
  leaseWorkspace,
  listWorkspaces,
  type PoolWorkspace,
  withEngineLock,
  withProjectWorkspace,
  type Workspace,
} from '../engine/index.js';
import {
  applyComponents,
  type ApplyOptions,
  type DeploymentResult,
  loadFurnaceConfig,
  typingDrift,
} from '../furnace/index.js';
import { ExitCode, FireForgeError } from '../kernel/errors.js';
import { exists } from '../kernel/fs.js';
import { readLockStatus } from '../kernel/lock.js';
import { info, verbose } from '../kernel/log.js';
import type { HostPaths, Project } from '../project/index.js';
import { materialize, recordDeployment } from '../source/index.js';
import { pinnedPristine } from './pristine.js';
import { trackedFiles } from './tracked.js';

/** How a command takes its workspace. */
export interface WorkspaceOptions {
  /** The command, shown to whoever waits on this one. */
  command: string;
  /** How long to wait for the workspace, in milliseconds (default: as long as a build takes). */
  waitMs?: number | undefined;
  /** Source mode: lease this pool workspace rather than the best free one. */
  workspace?: string | undefined;
  /**
   * False for a command that only reads the engine: in patch mode it then
   * shares the engine with other readers. A pool lease is always exclusive.
   */
  write?: boolean | undefined;
}

/**
 * Runs `body` in the project's workspace, holding it for the duration.
 * Whatever else must be current before the body's work (deployed
 * components, the build) is the body's business.
 *
 * @param project - The project
 * @param options - See {@link WorkspaceOptions}
 * @param body - The command's work
 * @throws `engine-missing` or `pristine-missing` before `download`,
 *   `lock-timeout` (exit code 15), `materialize-drift` when the leased
 *   engine was changed by something other than FireForge
 */
export async function withWorkspace<T>(
  project: Project,
  options: WorkspaceOptions,
  body: (workspace: Workspace) => Promise<T>
): Promise<T> {
  const wait = { command: options.command, waitMs: options.waitMs };
  if (project.mode === 'patches') {
    if (options.workspace !== undefined) {
      throw new FireForgeError(
        'invalid-argument',
        'A patch-mode project builds in its own engine/; it has no pool workspace to select.',
        { exitCode: ExitCode.INVALID_ARGUMENT, hint: 'Leave out --workspace.' }
      );
    }
    return withProjectWorkspace(
      project,
      { ...wait, mode: options.write === false ? 'shared' : 'exclusive' },
      body
    );
  }
  return leaseWorkspace(
    project,
    { ...wait, name: options.workspace, prepare: bringToCheckout },
    body
  );
}

/**
 * Makes a leased pool workspace hold what the checkout builds: its owned
 * files, then the files its components deploy. A pool workspace serves any
 * checkout, so what an earlier lessee deployed says nothing about this one.
 */
async function bringToCheckout(workspace: Workspace): Promise<void> {
  await materializeIn(workspace);
  await deployComponents(workspace);
}

/** States of a leased engine that only putting it back to pristine resolves. */
const NEEDS_REPAIR = new Set(['materialize-drift', 'journal-conflict', 'materialize-pin-mismatch']);

/**
 * Brings a source-mode project's pool workspace to the checkout's owned
 * files.
 *
 * @param workspace - A pool workspace of a source-mode project, held by the caller
 * @returns How many engine files changed
 * @throws What materialization throws, with the repair command for a
 *   workspace only a repair can bring back
 */
export async function materializeIn(workspace: Workspace): Promise<number> {
  const { project } = workspace;
  if (project.mode !== 'source') return 0;
  try {
    const result = await materialize(project, await pinnedPristine(project), workspace);
    const changed = result.written.length + result.restored.length + result.removed.length;
    verbose(`Workspace "${workspace.name}": ${changed} file(s) brought to this checkout.`);
    return changed;
  } catch (error: unknown) {
    if (!(error instanceof FireForgeError) || !NEEDS_REPAIR.has(error.code)) throw error;
    throw new FireForgeError(error.code, error.message, {
      exitCode: error.exitCode,
      hint:
        `Save anything you need from ${workspace.engineDir}, then run ` +
        `"fireforge workspace repair ${workspace.name}" and retry.`,
      cause: error,
    });
  }
}

/** The workspaces a command can build in, as `workspace list` shows them. */
export interface WorkspaceListing {
  /** A patch-mode project's own `engine/`, and the PIDs holding its lock. */
  engine?: { path: string; holders: number[] };
  /** The host pool. */
  pool: PoolWorkspace[];
}

/**
 * The host pool, and for a patch-mode project its own engine, which is its
 * one workspace.
 *
 * @param host - The host locations
 * @param project - The project the command runs in, if any
 */
export async function listAllWorkspaces(
  host: HostPaths,
  project: Project | undefined
): Promise<WorkspaceListing> {
  const pool = await listWorkspaces(host);
  if (project?.mode !== 'patches' || !(await exists(project.paths.engine))) return { pool };
  const { holders } = await readLockStatus(engineLockPath(project));
  return {
    engine: { path: project.paths.engine, holders: holders.map((holder) => holder.pid) },
    pool,
  };
}

/**
 * Runs `body` for a command made of several steps of which only some work
 * in the workspace. The workspace is taken when a step first asks for it
 * and held until the body ends, so steps that read only the owned changes
 * never wait for it; with `write: false` a patch-mode engine is held shared.
 *
 * @param project - The project
 * @param options - See {@link WorkspaceOptions}
 * @param body - The command's work; it calls its argument for the workspace
 */
export async function withWorkspaceOnDemand<T>(
  project: Project,
  options: WorkspaceOptions,
  body: (workspace: () => Promise<Workspace>) => Promise<T>
): Promise<T> {
  let release: (() => void) | undefined;
  let lease: Promise<void> | undefined;
  let leased: Promise<Workspace> | undefined;
  const workspace = (): Promise<Workspace> =>
    (leased ??= new Promise<Workspace>((resolve, reject) => {
      const done = new Promise<void>((finish) => {
        release = finish;
      });
      lease = withWorkspace(project, options, (taken) => {
        resolve(taken);
        return done;
      });
      // A lease that never came is the asking step's failure.
      lease.catch(reject);
    }));
  try {
    return await body(workspace);
  } finally {
    release?.();
    await lease?.catch(() => undefined);
  }
}

/**
 * Runs `body` while nothing changes the project's owned changes underneath
 * it: under the shared engine lock in patch mode. Source mode reads tracked
 * files and needs no lock.
 *
 * @param project - The project
 * @param options - The command and how long to wait
 * @param body - The read
 */
export function withOwnedRead<T>(
  project: Project,
  options: { command: string; waitMs?: number | undefined },
  body: () => Promise<T>
): Promise<T> {
  return project.mode === 'patches'
    ? withEngineLock(project, { ...options, mode: 'shared' }, body)
    : body();
}

/**
 * Brings the components deployed in a workspace's engine in line with the
 * project's: what every build, run and test of the workspace starts with.
 * A source-mode workspace's ledger records what the deployment wrote.
 *
 * @param workspace - The workspace
 * @param options - `dryRun` plans without writing; `waitMs` is for another deployment into the workspace
 * @returns What was deployed or removed; nothing for a project without components
 */
export async function deployComponents(
  workspace: Workspace,
  options: ApplyOptions = {}
): Promise<DeploymentResult> {
  const { project } = workspace;
  if (!(await exists(project.paths.furnace))) {
    return { changed: false, components: [], written: [], removed: [] };
  }
  const result = await applyComponents(project, workspace, options);
  if (options.dryRun === true) return result;
  // Deployment edits registration files a source-mode checkout may own.
  if (project.mode === 'source' && workspace.kind === 'pool') {
    await recordDeployment(await pinnedPristine(project), workspace, [
      ...result.written,
      ...result.removed,
    ]);
  }
  const changed = result.components
    .filter((component) => component.status !== 'current')
    .map((component) => component.name);
  if (changed.length > 0) info(`Deployed components: ${changed.join(', ')}.`);
  return result;
}

/**
 * Refuses while a typing file Furnace generates (the jsconfig paths, the
 * tag map) is out of date: a type check against stale typing files judges
 * the wrong program.
 *
 * @param project - The project
 * @throws `furnace-typing-drift` (exit code 9) naming the files
 */
export async function requireCurrentTyping(project: Project): Promise<void> {
  if (!(await exists(project.paths.furnace))) return;
  const drift = await typingDrift(
    project,
    await loadFurnaceConfig(project),
    await trackedFiles(project)
  );
  if (drift.length === 0) return;
  throw new FireForgeError(
    'furnace-typing-drift',
    `Generated typing files are out of date: ${drift.map((file) => file.file).join(', ')}.`,
    { exitCode: ExitCode.FURNACE_ERROR, hint: 'Run "fireforge furnace types".' }
  );
}
