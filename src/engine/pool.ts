// SPDX-License-Identifier: EUPL-1.2
/**
 * The host workspace pool: `workspaces/<name>/` holds `engine/` (a checkout
 * of a pin's pristine commit, with its object directory inside),
 * `workspace.json`, and whatever else modules record about that engine's
 * content (what was materialized and deployed into it, their journals, test
 * runs). A command leases one workspace for its duration; the lease is a
 * lock under the host's `locks/`, so a command that dies gives its workspace
 * back by dying.
 *
 * Everything in a workspace directory describes its engine. A repair keeps
 * only the engine (reset), the release build and the identity and build
 * sections of `workspace.json` ({@link resetWorkspaceState}). A clone copies
 * all of it but what is built: an object directory belongs to the path it
 * was configured at (`objdir.ts`), so the clone starts unbuilt.
 */
import { join, sep } from 'node:path';

import { cleanPaths, gitResult, reset } from '../git/index.js';
import { ExitCode, FireForgeError } from '../kernel/errors.js';
import { cloneTree, exists, listDir, move, remove, tempPathFor } from '../kernel/fs.js';
import { readJsonIfExists, writeJson } from '../kernel/json.js';
import {
  COMMAND_WAIT_MS,
  type HeldLock,
  type LockHolder,
  PROGRESS_EVERY_MS,
  PROGRESS_FIRST_MS,
  readLockStatus,
  tryAcquireLock,
  withLock,
} from '../kernel/lock.js';
import { info } from '../kernel/log.js';
import { listProcesses } from '../kernel/process/index.js';
import { type Infer, s } from '../kernel/schema.js';
import { formatDuration, sleep } from '../kernel/time.js';
import {
  defineStateSection,
  type HostPaths,
  type Project,
  readState,
  updateState,
} from '../project/index.js';
import { type FirefoxPin, pinKey } from './pin.js';
import { checkoutPristine, findPristine } from './pristine.js';
import { OBJDIR_NAME, type Workspace, workspaceAt, type WorkspaceWait } from './workspace.js';

const NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;

const recordSection = defineStateSection(
  'workspace',
  s.object({
    /** The pin key of the Firefox the engine holds. */
    pin: s.string({ min: 1 }),
    /** The pristine commit the engine is a checkout of. */
    commit: s.string({ min: 1 }),
    createdAt: s.string(),
    /** The workspace this one was cloned from. */
    clonedFrom: s.string().optional(),
    /** Who leased it last: its object directory is warm for that checkout's source. */
    lessee: s.object({ checkout: s.string(), root: s.string(), at: s.string() }).optional(),
  }),
  'fireforge workspace remove <name>'
);
type WorkspaceRecord = Infer<typeof recordSection.schema>;

/** The section of `workspace.json` holding the build baseline. */
const BUILD_SECTION = 'build';

/** The entry of a workspace directory holding the release build. */
const RELEASE_ENTRY = 'release';

/** Sections of `workspace.json` that describe the workspace and its build rather than the engine's content. */
const KEPT_ON_REPAIR = ['workspace', BUILD_SECTION];

/** Entries of a workspace directory a repair keeps besides `workspace.json`: the engine and the release build. */
const KEPT_ENTRIES = new Set(['engine', RELEASE_ENTRY, 'workspace.json']);

/** How long a pool workspace may wait to be created, which checks out a whole Firefox. */
const CREATE_WAIT_MS = 60 * 60 * 1000;

/** One workspace of the pool, as `workspace list` shows it. */
export interface PoolWorkspace extends WorkspaceRecord {
  name: string;
  /** `workspaces/<name>/`. */
  dir: string;
  engineDir: string;
  /** Whether a build has configured its object directory. */
  built: boolean;
  /** The commands holding it right now; empty when it is free. */
  holders: LockHolder[];
}

interface Place {
  dir: string;
  engineDir: string;
  paths: { state: string; stateDir: string };
  lock: string;
}

function place(host: HostPaths, name: string): Place {
  const dir = join(host.workspaces, name);
  return {
    dir,
    engineDir: join(dir, 'engine'),
    paths: { state: join(dir, 'workspace.json'), stateDir: dir },
    lock: join(host.locks, `workspace-${name}`),
  };
}

function poolError(code: string, message: string, hint?: string): FireForgeError {
  return new FireForgeError(code, message, {
    exitCode: ExitCode.GENERAL_ERROR,
    ...(hint === undefined ? {} : { hint }),
  });
}

function describe(holders: readonly LockHolder[]): string {
  return holders
    .map((holder) => {
      const details = Object.entries(holder.info).map(([key, value]) => `${key}=${value}`);
      return `PID ${holder.pid}${details.length > 0 ? ` (${details.join(', ')})` : ''}`;
    })
    .join(', ');
}

async function readWorkspace(host: HostPaths, name: string): Promise<PoolWorkspace | undefined> {
  const at = place(host, name);
  const record = await readState(at, recordSection);
  if (record === undefined) return undefined;
  return {
    ...record,
    name,
    dir: at.dir,
    engineDir: at.engineDir,
    built: await exists(join(at.engineDir, OBJDIR_NAME, 'config.status')),
    holders: (await readLockStatus(at.lock)).holders,
  };
}

/**
 * The workspaces of the pool, by name.
 *
 * @param host - The host locations
 */
export async function listWorkspaces(host: HostPaths): Promise<PoolWorkspace[]> {
  const found: PoolWorkspace[] = [];
  for (const entry of await listDir(host.workspaces)) {
    // A dot-name is a workspace still being created.
    if (entry.kind !== 'directory' || entry.name.startsWith('.')) continue;
    const workspace = await readWorkspace(host, entry.name);
    if (workspace !== undefined) found.push(workspace);
  }
  return found;
}

async function requireWorkspace(host: HostPaths, name: string): Promise<PoolWorkspace> {
  const workspace = await readWorkspace(host, name);
  if (workspace !== undefined) return workspace;
  const names = (await listWorkspaces(host)).map((entry) => entry.name);
  throw poolError(
    'workspace-not-found',
    `There is no workspace "${name}"`,
    names.length > 0
      ? `The pool has: ${names.join(', ')}.`
      : 'The pool is empty; create one with "fireforge workspace add <name>".'
  );
}

/** Takes a workspace's lease only if it is free, for an operation on the workspace itself. */
async function holdFree(
  host: HostPaths,
  workspace: PoolWorkspace,
  doing: string
): Promise<HeldLock> {
  const lock = await tryAcquireLock(place(host, workspace.name).lock, { info: { command: doing } });
  if (lock !== undefined) return lock;
  const { holders } = await readLockStatus(place(host, workspace.name).lock);
  throw poolError(
    'workspace-busy',
    `Workspace "${workspace.name}" is leased by ${describe(holders) || 'another command'}`,
    'Wait for that command to finish.'
  );
}

/** How {@link addWorkspace} creates a workspace. */
export interface AddWorkspaceOptions {
  /** The Firefox the workspace holds. */
  pin: FirefoxPin;
  /** Clone this workspace's engine copy-on-write, without its builds, instead of a fresh checkout. */
  from?: string | undefined;
}

/**
 * Creates a pool workspace: a fresh checkout of the pin's pristine commit, or
 * with `from` a copy-on-write clone of another workspace's engine on the same
 * pin, with everything recorded about the engine's content. Either way the
 * new workspace is unbuilt: the object directory and the release build of
 * `from` stay behind, because a build cannot be moved to another path.
 *
 * @param host - The host locations
 * @param name - The new workspace's name
 * @param options - See {@link AddWorkspaceOptions}
 * @throws `invalid-argument` for a bad name, `workspace-exists`,
 *   `pristine-missing` when the pin was never downloaded, `workspace-busy`
 *   when `from` is leased, `workspace-interrupted` when `from` holds an
 *   unfinished change, `clone-unsupported` when the filesystem cannot clone
 */
export async function addWorkspace(
  host: HostPaths,
  name: string,
  options: AddWorkspaceOptions
): Promise<PoolWorkspace> {
  if (!NAME.test(name)) {
    throw new FireForgeError(
      'invalid-argument',
      `"${name}" is not a workspace name: use lowercase letters, digits, ".", "_" and "-"`,
      { exitCode: ExitCode.INVALID_ARGUMENT }
    );
  }
  return withPoolLock(host, () => createWorkspace(host, name, options));
}

function withPoolLock<T>(host: HostPaths, body: () => Promise<T>): Promise<T> {
  return withLock(
    join(host.locks, 'pool'),
    { label: 'workspace pool', waitMs: CREATE_WAIT_MS },
    body
  );
}

/** Creates a workspace; the caller holds the pool lock. */
async function createWorkspace(
  host: HostPaths,
  name: string,
  options: AddWorkspaceOptions
): Promise<PoolWorkspace> {
  const at = place(host, name);
  const key = pinKey(options.pin);
  if (await exists(at.dir)) throw poolError('workspace-exists', `Workspace "${name}" exists`);
  const staging = tempPathFor(at.dir);
  const staged = { state: join(staging, 'workspace.json'), stateDir: staging };
  try {
    if (options.from === undefined) {
      const pristine = await findPristine(host, options.pin);
      if (pristine === undefined) {
        throw poolError(
          'pristine-missing',
          `This host has no pristine source for ${key}`,
          'Run "fireforge download" in the project first.'
        );
      }
      await checkoutPristine(pristine, join(staging, 'engine'));
      await updateState({ paths: staged }, recordSection, () => ({
        pin: key,
        commit: pristine.commit,
        createdAt: new Date().toISOString(),
      }));
    } else {
      await cloneWorkspace(host, options.from, key, staging);
    }
    await move(staging, at.dir);
  } finally {
    await remove(staging);
  }
  return requireWorkspace(host, name);
}

/**
 * Clones the entries of `source` into `target`, each copy-on-write, leaving
 * out the one named `except`.
 */
async function cloneEntries(source: string, target: string, except: string): Promise<void> {
  for (const entry of await listDir(source)) {
    if (entry.name !== except) await cloneTree(join(source, entry.name), join(target, entry.name));
  }
}

/** Rewrites a workspace's state document with only the sections `keep` accepts. */
async function keepSections(statePath: string, keep: (section: string) => boolean): Promise<void> {
  const document = (await readJsonIfExists(statePath, s.record(s.unknown()))) ?? {};
  await writeJson(
    statePath,
    Object.fromEntries(Object.entries(document).filter(([key]) => keep(key)))
  );
}

/**
 * Copies a workspace's engine and everything recorded about the engine's
 * content, so the clone holds the source the original held for whichever
 * checkout leases it next. Its builds are left out with their baseline.
 */
async function cloneWorkspace(
  host: HostPaths,
  from: string,
  key: string,
  staging: string
): Promise<void> {
  const source = await requireWorkspace(host, from);
  if (source.pin !== key) {
    throw poolError(
      'workspace-pin-mismatch',
      `Workspace "${from}" holds ${source.pin}, not ${key}`,
      'Clone a workspace on the same Firefox, or add a fresh one without --from.'
    );
  }
  const lease = await holdFree(host, source, 'workspace add');
  try {
    // A journal names the source's absolute paths; undoing it in the clone would change the source.
    const pending = (await listDir(source.dir)).filter((entry) => entry.name.endsWith('.journal'));
    if (pending.length > 0) {
      throw poolError(
        'workspace-interrupted',
        `Workspace "${from}" holds an interrupted change (${pending.map((entry) => entry.name).join(', ')})`,
        `Run a command in it first, such as "fireforge build --workspace ${from}", which completes the undo, or repair it with "fireforge workspace repair ${from}".`
      );
    }
    const engineDir = join(staging, 'engine');
    for (const entry of await listDir(source.dir)) {
      if (entry.name === RELEASE_ENTRY) continue;
      const [origin, target] = [join(source.dir, entry.name), join(staging, entry.name)];
      if (entry.name === 'engine') await cloneEntries(origin, target, OBJDIR_NAME);
      else await cloneTree(origin, target);
    }
    await keepSections(join(staging, 'workspace.json'), (section) => section !== BUILD_SECTION);
    await remove(join(engineDir, '.git', 'index.lock'));
    // Every file is a new inode, so git would re-read each one on every
    // status until the index knows them. Exit 1 only reports real changes.
    await gitResult(['update-index', '-q', '--refresh'], { cwd: engineDir });
    await updateState(
      { paths: { state: join(staging, 'workspace.json'), stateDir: staging } },
      recordSection,
      () => ({
        pin: key,
        commit: source.commit,
        createdAt: new Date().toISOString(),
        clonedFrom: from,
      })
    );
  } finally {
    await lease.release();
  }
}

/**
 * Removes a workspace and everything built in it.
 *
 * @param host - The host locations
 * @param name - The workspace
 * @throws `workspace-not-found`, or `workspace-busy` while a command leases
 *   it or a process (a browser left running) was started from inside it
 */
export async function removeWorkspace(host: HostPaths, name: string): Promise<void> {
  const workspace = await requireWorkspace(host, name);
  const lease = await holdFree(host, workspace, 'workspace remove');
  try {
    const inside = (await listProcesses(['pid', 'command'])).filter((row) =>
      row.command.includes(workspace.dir + sep)
    );
    if (inside.length > 0) {
      throw poolError(
        'workspace-busy',
        `Workspace "${name}" still has running processes: PID ${inside.map((row) => row.pid).join(', ')}`,
        'Close the browser or build started from it, then retry.'
      );
    }
    await remove(workspace.dir);
  } finally {
    await lease.release();
  }
  await remove(place(host, name).lock);
}

/**
 * Puts a workspace's engine back to the pristine commit: every tracked file
 * restored, every untracked source file removed. The object directory and
 * the build record stay; what other modules recorded about the engine's
 * content is dropped, so the next lease materializes the source afresh.
 *
 * @param host - The host locations
 * @param name - The workspace
 * @throws `workspace-not-found`, or `workspace-busy` while a command leases it
 */
export async function repairWorkspace(host: HostPaths, name: string): Promise<void> {
  const workspace = await requireWorkspace(host, name);
  const lease = await holdFree(host, workspace, 'workspace repair');
  try {
    await remove(join(workspace.engineDir, '.git', 'index.lock'));
    await reset(workspace.engineDir, workspace.commit, 'hard');
    await cleanPaths(workspace.engineDir);
    await resetWorkspaceState(place(host, name));
  } finally {
    await lease.release();
  }
}

/**
 * Forgets what was recorded about a workspace engine's content, for an
 * engine just put back to pristine: every entry of the workspace directory
 * but the engine and the release build goes (ledgers, deployment records,
 * their journals, test runs), and `workspace.json` keeps only the
 * workspace's identity and its build baseline.
 */
async function resetWorkspaceState(at: Place): Promise<void> {
  for (const entry of await listDir(at.dir)) {
    if (!KEPT_ENTRIES.has(entry.name)) await remove(join(at.dir, entry.name));
  }
  await keepSections(at.paths.state, (section) => KEPT_ON_REPAIR.includes(section));
}

/** How a command leases a pool workspace. */
export interface LeaseOptions extends WorkspaceWait {
  /** Lease this workspace rather than the best free one. */
  name?: string | undefined;
  /**
   * Brings the engine to the checkout's source, after the lease is taken and
   * before the command's work.
   */
  prepare?: ((workspace: Workspace) => Promise<unknown>) | undefined;
}

/** The workspaces a project may lease, best first: its own last one, then the least recently used. */
function preference(candidates: PoolWorkspace[], checkout: string): PoolWorkspace[] {
  const lastUsed = (workspace: PoolWorkspace): string => workspace.lessee?.at ?? '';
  return [...candidates].sort((a, b) => {
    const [mineA, mineB] = [a.lessee?.checkout === checkout, b.lessee?.checkout === checkout];
    if (mineA !== mineB) return mineA ? -1 : 1;
    return lastUsed(a) < lastUsed(b)
      ? -1
      : lastUsed(a) > lastUsed(b)
        ? 1
        : a.name < b.name
          ? -1
          : 1;
  });
}

async function candidates(project: Project, name: string | undefined): Promise<PoolWorkspace[]> {
  const key = pinKey(project.config.firefox);
  if (name !== undefined) {
    const workspace = await requireWorkspace(project.host, name);
    if (workspace.pin !== key) {
      throw poolError(
        'workspace-pin-mismatch',
        `Workspace "${name}" holds ${workspace.pin}, and this project builds on ${key}`,
        'Lease a workspace on the project\'s Firefox, or add one with "fireforge workspace add".'
      );
    }
    return [workspace];
  }
  const onPin = async (): Promise<PoolWorkspace[]> =>
    (await listWorkspaces(project.host)).filter((workspace) => workspace.pin === key);
  const found = await onPin();
  if (found.length > 0) return preference(found, project.checkout.key);
  // The first workspace of a pin is always wanted; further ones cost tens of
  // gigabytes each once built, so those are the operator's decision. Two
  // commands that both find none agree under the pool lock on who creates it.
  return withPoolLock(project.host, async () => {
    const created = await onPin();
    if (created.length > 0) return preference(created, project.checkout.key);
    const taken = new Set((await listDir(project.host.workspaces)).map((entry) => entry.name));
    let index = 1;
    while (taken.has(`w${index}`)) index += 1;
    info(`The pool has no workspace for ${key}; creating "w${index}".`);
    return [await createWorkspace(project.host, `w${index}`, { pin: project.config.firefox })];
  });
}

async function takeLease(
  project: Project,
  options: LeaseOptions
): Promise<{ workspace: PoolWorkspace; lock: HeldLock }> {
  const waitMs = options.waitMs ?? COMMAND_WAIT_MS;
  const startedAt = Date.now();
  let lastProgress = startedAt;
  let pollMs = 50;
  for (;;) {
    const ordered = await candidates(project, options.name);
    for (const workspace of ordered) {
      const lock = await tryAcquireLock(place(project.host, workspace.name).lock, {
        info: {
          checkout: project.root,
          ...(options.command === undefined ? {} : { command: options.command }),
        },
      });
      if (lock === undefined) continue;
      // It may have been removed between the listing and the lock.
      const current = await readWorkspace(project.host, workspace.name);
      if (current !== undefined) return { workspace: current, lock };
      await lock.release();
    }
    const held = ordered
      .map(
        (workspace) => `"${workspace.name}" by ${describe(workspace.holders) || 'another command'}`
      )
      .join('; ');
    const waited = Date.now() - startedAt;
    if (waited >= waitMs) {
      throw new FireForgeError(
        'lock-timeout',
        `${waitMs > 0 ? `Timed out after ${formatDuration(waitMs)} waiting for` : 'Could not take'} a free workspace: ${held}`,
        {
          exitCode: ExitCode.LOCK_TIMEOUT,
          hint: 'Wait for those commands, allow a longer wait with --wait-lock <seconds>, or add a workspace with "fireforge workspace add <name>".',
        }
      );
    }
    if (
      Date.now() - lastProgress >=
      (lastProgress === startedAt ? PROGRESS_FIRST_MS : PROGRESS_EVERY_MS)
    ) {
      lastProgress = Date.now();
      info(
        `Waiting for a free workspace (${held}): ${formatDuration(waited)} of up to ${formatDuration(waitMs)}.`
      );
    }
    await sleep(Math.max(1, Math.min(pollMs, waitMs - waited)));
    pollMs = Math.min(pollMs * 2, 1_000);
  }
}

/**
 * Runs `body` in a pool workspace leased for its duration: a free workspace
 * on the project's pin, preferring the one this checkout used last (its
 * object directory is warm for this source), then the least recently used.
 * When all are leased it waits, naming the holders. A pin with no workspace
 * yet gets its first one created.
 *
 * @param project - The project; its pin selects the workspaces, its checkout is the lessee
 * @param options - See {@link LeaseOptions}
 * @param body - The command's work
 * @throws `lock-timeout` (exit code 15) when no workspace came free in time,
 *   `workspace-not-found` or `workspace-pin-mismatch` for a named one,
 *   `pristine-missing` when the first workspace cannot be created
 */
export async function leaseWorkspace<T>(
  project: Project,
  options: LeaseOptions,
  body: (workspace: Workspace) => Promise<T>
): Promise<T> {
  const { workspace: leased, lock } = await takeLease(project, options);
  try {
    const at = place(project.host, leased.name);
    await updateState(at, recordSection, (record) =>
      record === undefined
        ? undefined
        : {
            ...record,
            lessee: {
              checkout: project.checkout.key,
              root: project.root,
              at: new Date().toISOString(),
            },
          }
    );
    const workspace = workspaceAt(project, {
      name: leased.name,
      kind: 'pool',
      engineDir: at.engineDir,
      stateDir: at.dir,
      stateFile: at.paths.state,
    });
    await options.prepare?.(workspace);
    return await body(workspace);
  } finally {
    await lock.release();
  }
}
