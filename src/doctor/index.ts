// SPDX-License-Identifier: EUPL-1.2
/**
 * `doctor`: a table of small checks over the project and the host, each
 * answering ok, warn or fail with what to do about it, and one row per tool
 * the project declares in `externalToolchains`. Nothing here repairs
 * anything except, on request, undoing transactions a dead process left
 * unfinished.
 */
import { join, resolve } from 'node:path';

import type { FireForgeConfig } from '../config/index.js';
import { engineLockPath, listWorkspaces, workspaceLockPath } from '../engine/index.js';
import { loadFurnaceConfig, typingDrift } from '../furnace/index.js';
import { FireForgeError, toError } from '../kernel/errors.js';
import { exists, freeDiskSpace, listDir } from '../kernel/fs.js';
import { inspectJournal, recoverJournal } from '../kernel/journal.js';
import { readLockStatus, tryAcquireLock } from '../kernel/lock.js';
import { findExecutable, run } from '../kernel/process/index.js';
import { diagnose, type Diagnosis, trackedFiles } from '../mode/index.js';
import {
  type Environment,
  type HostPaths,
  hostPaths,
  loadProject,
  type Project,
} from '../project/index.js';

/** One row of the report. */
export type DoctorCheck = Diagnosis;

/** What `doctor` found. */
export interface DoctorReport {
  checks: DoctorCheck[];
  /** False when any check failed; warnings do not count. */
  healthy: boolean;
}

/** How {@link runDoctor} runs. */
export interface DoctorOptions {
  /** Undo the transactions interrupted runs left unfinished. */
  recover?: boolean;
}

type Answer = Pick<Diagnosis, 'status' | 'detail' | 'fix'>;

interface Context {
  host: HostPaths;
  /** Undefined when the configuration does not load. */
  project: Project | undefined;
  recover: boolean;
}

interface Check {
  id: string;
  title: string;
  /** Returns undefined when the check does not apply. */
  run: (context: Context) => Promise<Answer | undefined>;
}

/** A full build writes about 20 GiB; below this a build is likely to run out. */
const LOW_DISK_BYTES = 25 * 1024 ** 3;
const GIB = 1024 ** 3;

const failed = (error: unknown): Answer => ({
  status: 'fail',
  detail: toError(error).message,
  ...(error instanceof FireForgeError && error.hint !== undefined ? { fix: error.hint } : {}),
});

async function python(): Promise<Answer> {
  const found = await findExecutable('python3');
  return found === undefined
    ? {
        status: 'fail',
        detail: 'python3 is not on PATH, and mach needs it',
        fix: 'Install Python 3, then run "fireforge bootstrap".',
      }
    : { status: 'ok', detail: found };
}

/** A journal on disk and the lock whose holder owns what it changes. */
interface JournalFile {
  path: string;
  /** Undefined when nothing known serialises the resource, so doctor cannot undo it safely. */
  lock: string | undefined;
}

/**
 * The lock a project's own journal is written under, by the lock that its
 * owner holds: the engine lock for everything that changes the engine or the
 * queue of a patch-mode project, the module's own lock where it has one.
 */
function projectLock(project: Project, name: string): string | undefined {
  const { stateDir } = project.paths;
  if (name === 'furnace-edit.journal') return join(stateDir, 'furnace-edit.lock');
  if (name === 'source.journal') return join(stateDir, 'source.lock');
  if (name === 'tracked-edit.journal' && project.mode === 'source') {
    return join(stateDir, 'tracked-edit.lock');
  }
  const engineWork = [
    'engine.journal',
    'queue.journal',
    'tracked-edit.journal',
    'furnace-deployment.journal',
    'source-materialize.journal',
  ];
  if (project.mode === 'patches' && (engineWork.includes(name) || name.startsWith('journals/'))) {
    return engineLockPath(project);
  }
  return undefined;
}

/** Where transactions keep their journals: the project state and every pool workspace. */
async function journalPaths({ host, project }: Context): Promise<JournalFile[]> {
  const homes: { directory: string; lockOf: (name: string) => string | undefined }[] = [
    ...(project === undefined
      ? []
      : [
          {
            directory: project.paths.stateDir,
            lockOf: (name: string) => projectLock(project, name),
          },
        ]),
    ...(await listWorkspaces(host)).map((workspace) => ({
      directory: workspace.dir,
      // The lease is held for the whole of a command in the workspace.
      lockOf: () => workspaceLockPath(host, workspace.name),
    })),
  ];
  const found: JournalFile[] = [];
  for (const { directory, lockOf } of homes) {
    for (const entry of await listDir(directory)) {
      if (entry.kind === 'file' && entry.name.endsWith('.journal')) {
        found.push({ path: join(directory, entry.name), lock: lockOf(entry.name) });
      }
    }
    for (const entry of await listDir(join(directory, 'journals'))) {
      if (entry.kind === 'file') {
        found.push({
          path: join(directory, 'journals', entry.name),
          lock: lockOf(`journals/${entry.name}`),
        });
      }
    }
  }
  return found;
}

/**
 * Undoes one interrupted journal while holding the lock that serialises what
 * it changes, and reads the journal again once the lock is held: a command
 * that held the lock first may have recovered it, or begun a new transaction.
 *
 * @returns Whether it was undone (false when another command already had), or why it was left alone
 */
async function recoverUnderLock(file: JournalFile): Promise<boolean | string> {
  if (file.lock === undefined) {
    return 'no known lock serialises it, so it is left for the command that wrote it';
  }
  const lock = await tryAcquireLock(file.lock, {
    label: 'journal recovery',
    info: { command: 'doctor' },
  });
  if (lock === undefined) {
    const { holders } = await readLockStatus(file.lock);
    const who = holders.map((holder) => `PID ${holder.pid}`).join(', ');
    return `${file.lock} is held${who === '' ? '' : ` by ${who}`}`;
  }
  try {
    const pending = await inspectJournal(file.path);
    if (pending === undefined) return false;
    if (pending.ownerAlive) return `PID ${pending.pid} is running it`;
    return await recoverJournal(file.path);
  } finally {
    await lock.release();
  }
}

async function journals(context: Context): Promise<Answer> {
  const interrupted: string[] = [];
  let recovered = 0;
  for (const file of await journalPaths(context)) {
    const pending = await inspectJournal(file.path);
    if (pending === undefined || pending.ownerAlive) continue;
    const named = `${pending.label} (${pending.paths.length} path(s), ${file.path})`;
    if (!context.recover) {
      interrupted.push(named);
      continue;
    }
    const outcome = await recoverUnderLock(file);
    if (outcome === true) recovered += 1;
    else if (outcome !== false) interrupted.push(`${named}: ${outcome}`);
  }
  if (interrupted.length > 0) {
    return {
      status: 'fail',
      detail: `Interrupted and not undone: ${interrupted.join('; ')}`,
      fix: context.recover
        ? 'Finish or stop the commands holding the locks named, then run "fireforge doctor --recover" again. A journal no lock covers is undone by the next run of the command that wrote it.'
        : 'Run "fireforge doctor --recover" to restore the files those runs were changing.',
    };
  }
  return {
    status: 'ok',
    detail:
      recovered > 0 ? `Undid ${recovered} interrupted run(s)` : 'No interrupted run left anything',
  };
}

async function locks({ host, project }: Context): Promise<Answer> {
  const paths = [
    ...(project === undefined ? [] : [engineLockPath(project)]),
    join(host.locks, 'display'),
    join(host.locks, 'build'),
  ];
  const held: string[] = [];
  const unreadable: string[] = [];
  for (const path of paths) {
    const lock = await readLockStatus(path);
    if (lock.unidentified > 0) unreadable.push(path);
    for (const holder of lock.holders) {
      const command = holder.info['command'];
      held.push(
        `${path} by PID ${holder.pid}${command === undefined ? '' : ` (${command})`} since ${holder.requestedAt}`
      );
    }
  }
  if (unreadable.length > 0) {
    return {
      status: 'warn',
      detail: `Held by something that left no readable record: ${unreadable.join(', ')}`,
      fix: 'When no fireforge command is running, delete those directories.',
    };
  }
  return { status: 'ok', detail: held.length === 0 ? 'None held' : `Held: ${held.join('; ')}` };
}

async function disk({ host, project }: Context): Promise<Answer | undefined> {
  const where = (await exists(host.root)) ? host.root : project?.root;
  const free = where === undefined ? undefined : await freeDiskSpace(where);
  if (free === undefined) return undefined;
  const detail = `${(free / GIB).toFixed(1)} GiB free at ${where ?? ''}`;
  return free >= LOW_DISK_BYTES
    ? { status: 'ok', detail }
    : {
        status: 'warn',
        detail: `${detail}; a full build writes about 20 GiB`,
        fix: 'Free space, or remove workspaces you no longer use with "fireforge workspace remove <name>".',
      };
}

async function typing({ project }: Context): Promise<Answer | undefined> {
  if (project === undefined || !(await exists(project.paths.furnace))) return undefined;
  const drift = await typingDrift(
    project,
    await loadFurnaceConfig(project),
    await trackedFiles(project)
  );
  return drift.length === 0
    ? { status: 'ok', detail: 'Generated typing files are current' }
    : {
        status: 'warn',
        detail: `Out of date: ${drift.map((file) => file.file).join(', ')}`,
        fix: 'Run "fireforge furnace types".',
      };
}

type DeclaredTool = NonNullable<FireForgeConfig['externalToolchains']>[number]['tools'][number];

/** How long `xcrun -find` may take before the tool counts as missing. */
const XCRUN_TIMEOUT_MS = 5000;

/** Where a declared tool is: its `path`, what `xcrun -find` prints, or its place on PATH. */
async function locateTool(project: Project, tool: DeclaredTool): Promise<string | undefined> {
  if (tool.path !== undefined) {
    const candidate = resolve(project.root, tool.path);
    return (await exists(candidate)) ? candidate : undefined;
  }
  if (tool.xcrun !== true) return findExecutable(tool.name);
  try {
    const found = await run('xcrun', ['-find', tool.name], { timeoutMs: XCRUN_TIMEOUT_MS });
    const line = found.stdout.split(/\r?\n/).find((entry) => entry.trim() !== '');
    return found.exitCode === 0 ? line?.trim() : undefined;
  } catch {
    // No xcrun on this host, or it did not answer: the tool has no path either way.
    return undefined;
  }
}

/** One row per tool of `externalToolchains`: found, or missing as a failure or a warning. */
async function toolchains(project: Project): Promise<DoctorCheck[]> {
  const rows: DoctorCheck[] = [];
  for (const toolchain of project.config.externalToolchains ?? []) {
    for (const tool of toolchain.tools) {
      const row = {
        id: `toolchain:${toolchain.name}/${tool.name}`,
        title: `Toolchain ${toolchain.name}: ${tool.name}`,
      };
      const found = await locateTool(project, tool);
      if (found !== undefined) {
        rows.push({ ...row, status: 'ok', detail: found });
        continue;
      }
      const where =
        tool.path !== undefined
          ? `at ${tool.path}`
          : tool.xcrun === true
            ? `by "xcrun -find ${tool.name}"`
            : 'on PATH';
      rows.push({
        ...row,
        status: tool.required ? 'fail' : 'warn',
        detail: `${tool.name}, which toolchain "${toolchain.name}" ${tool.required ? 'requires' : 'uses'}, was not found ${where}`,
        fix: `Install ${tool.name}, or correct the "${toolchain.name}" entry of externalToolchains in fireforge.json.`,
      });
    }
  }
  return rows;
}

const HOST_CHECKS: readonly Check[] = [
  { id: 'python', title: 'Python for mach', run: python },
  { id: 'journals', title: 'Interrupted runs', run: journals },
  { id: 'locks', title: 'Locks', run: locks },
  { id: 'disk', title: 'Disk space', run: disk },
  { id: 'typing', title: 'Component typing files', run: typing },
];

/**
 * Diagnoses the project containing `cwd` and the host.
 *
 * @param cwd - Where the command was run
 * @param env - The environment of the invocation
 * @param options - See {@link DoctorOptions}
 */
export async function runDoctor(
  cwd: string,
  env: Environment,
  options: DoctorOptions = {}
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  let project: Project | undefined;
  try {
    project = await loadProject(cwd, env);
    checks.push({
      id: 'config',
      title: 'Configuration',
      status: 'ok',
      detail: `${project.paths.config} (${project.mode} mode)`,
    });
  } catch (error: unknown) {
    checks.push({ id: 'config', title: 'Configuration', ...failed(error) });
  }
  if (project !== undefined) checks.push(...(await diagnose(project)));
  const context = { host: hostPaths(env), project, recover: options.recover === true };
  for (const check of HOST_CHECKS) {
    const answer = await check.run(context).catch(failed);
    if (answer !== undefined) checks.push({ id: check.id, title: check.title, ...answer });
  }
  if (project !== undefined) checks.push(...(await toolchains(project)));
  return { checks, healthy: checks.every((check) => check.status !== 'fail') };
}

/**
 * The report for a person: one line per check, with the fix under anything
 * that is not ok.
 *
 * @param report - The report
 */
export function renderDoctor(report: DoctorReport): string[] {
  const width = Math.max(...report.checks.map((check) => check.title.length));
  const lines: string[] = [];
  for (const check of report.checks) {
    lines.push(`${check.status.padEnd(4)}  ${check.title.padEnd(width)}  ${check.detail}`);
    if (check.fix !== undefined) lines.push(`      ${check.fix}`);
  }
  const count = (status: DoctorCheck['status']): number =>
    report.checks.filter((check) => check.status === status).length;
  lines.push(`${count('ok')} ok, ${count('warn')} warning(s), ${count('fail')} failed.`);
  return lines;
}
