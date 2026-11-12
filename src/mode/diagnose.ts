// SPDX-License-Identifier: EUPL-1.2
/**
 * What `doctor` asks about a project that depends on its mode: the git it
 * needs, the pinned source on this host, the engine or the pool workspaces
 * built from it, and the integrity of where the owned changes are stored.
 */
import { join } from 'node:path';

import { listWorkspaces, pinKey, type Pristine } from '../engine/index.js';
import { deploymentStatus } from '../furnace/index.js';
import { getConfig, git, isRepository, resolveRevision } from '../git/index.js';
import { FireForgeError, toError } from '../kernel/errors.js';
import { exists } from '../kernel/fs.js';
import type { PatchProject, Project, SourceProject } from '../project/index.js';
import { MERGE_DRIVER, mergeDriverCommand } from '../source/index.js';
import { pinnedPristine } from './pristine.js';
import { verify } from './report.js';

/** One answer of a diagnostic check. */
export type Diagnosis = {
  /** Stable identifier of the check. */
  id: string;
  title: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  /** What to run or change, for anything but `ok`. */
  fix?: string;
};

type Answer = Pick<Diagnosis, 'status' | 'detail' | 'fix'>;

const failed = (error: unknown): Answer => ({
  status: 'fail',
  detail: toError(error).message,
  ...(error instanceof FireForgeError && error.hint !== undefined ? { fix: error.hint } : {}),
});

/** Git old enough to lack the ancestor label breaks first-touch merges; older still lacks plumbing options. */
async function gitVersion(project: Project): Promise<Answer> {
  const needed = project.mode === 'source' ? [2, 44] : [2, 35];
  const text = (await git(['version'], { cwd: project.root })).trim();
  const found = /(\d+)\.(\d+)/.exec(text);
  const [major, minor] = [Number(found?.[1]), Number(found?.[2])];
  const [needMajor = 0, needMinor = 0] = needed;
  if (major > needMajor || (major === needMajor && minor >= needMinor)) {
    return { status: 'ok', detail: text };
  }
  return {
    status: 'fail',
    detail: `${text}; this project needs git ${needed.join('.')} or later`,
    fix: 'Upgrade git.',
  };
}

async function patchEngine(project: PatchProject, pristine: Pristine): Promise<Answer> {
  const engine = project.paths.engine;
  if (!(await exists(join(engine, 'mach'))) || !(await isRepository(engine))) {
    return {
      status: 'fail',
      detail: `There is no Firefox source at ${engine}`,
      fix: 'Run "fireforge download".',
    };
  }
  const head = await resolveRevision(engine, 'HEAD', 'commit');
  if (head !== pristine.commit) {
    return {
      status: 'fail',
      detail: `engine/ is a checkout of ${head ?? 'nothing'}, and the pinned source is ${pristine.commit}`,
      fix: 'Run "fireforge rebase" to move the queue onto what engine/ holds, or "fireforge download --force" to replace engine/ with the pin.',
    };
  }
  return { status: 'ok', detail: `engine/ is a checkout of ${pinKey(project.config.firefox)}` };
}

async function deployment(project: PatchProject): Promise<Answer> {
  const status = await deploymentStatus(project, {
    engineDir: project.paths.engine,
    stateDir: project.paths.stateDir,
  });
  const stale = status.components.filter((component) => component.status !== 'current');
  return stale.length === 0
    ? { status: 'ok', detail: `${status.components.length} component(s) deployed` }
    : {
        status: 'warn',
        detail: `Not deployed as the project has them: ${stale.map((component) => component.name).join(', ')}`,
        fix: 'Run "fireforge furnace apply"; every build, run and test does it first.',
      };
}

async function mergeDriver(project: SourceProject): Promise<Answer> {
  const { worktree } = project.checkout;
  if (worktree === undefined) {
    return {
      status: 'fail',
      detail: 'The project is not in a git repository',
      fix: 'A source-mode project is tracked in git: run "git init" and commit it.',
    };
  }
  const driver = await getConfig(worktree, `merge.${MERGE_DRIVER}.driver`);
  if (driver === undefined) {
    return {
      status: 'fail',
      detail: 'The merge driver for owned files is not configured in this repository',
      fix: 'Run "fireforge merge-driver install".',
    };
  }
  return driver === mergeDriverCommand(project)
    ? { status: 'ok', detail: 'Configured' }
    : {
        status: 'warn',
        detail: `merge.${MERGE_DRIVER}.driver is not the command this FireForge configures: ${driver}`,
        fix: 'Run "fireforge merge-driver install".',
      };
}

async function pool(project: SourceProject, pristine: Pristine): Promise<Answer> {
  const key = pinKey(project.config.firefox);
  const workspaces = (await listWorkspaces(project.host)).filter(
    (workspace) => workspace.pin === key
  );
  if (workspaces.length === 0) {
    return { status: 'ok', detail: `None on ${key} yet; the first build creates one` };
  }
  const broken: string[] = [];
  for (const workspace of workspaces) {
    if (!(await exists(join(workspace.engineDir, 'mach')))) {
      broken.push(`"${workspace.name}" has no engine`);
    } else if (workspace.commit !== pristine.commit) {
      broken.push(`"${workspace.name}" holds commit ${workspace.commit}, not the pinned source`);
    }
  }
  if (broken.length > 0) {
    return {
      status: 'fail',
      detail: broken.join('; '),
      fix: 'Remove each with "fireforge workspace remove <name>"; the next build creates a fresh one.',
    };
  }
  const rows = workspaces.map((workspace) => {
    const lease =
      workspace.holders.length > 0
        ? `leased by PID ${workspace.holders.map((holder) => holder.pid).join(', ')}`
        : 'free';
    return `${workspace.name} (${workspace.built ? 'built' : 'not built'}, ${lease})`;
  });
  return { status: 'ok', detail: rows.join(', ') };
}

async function storage(project: Project): Promise<Answer> {
  const { problems } = await verify(project);
  if (problems.length === 0) return { status: 'ok', detail: 'Sound' };
  const first = problems[0];
  const subject = first?.subject === undefined ? '' : `${first.subject}: `;
  return {
    status: 'fail',
    detail: `${problems.length} problem(s), first: ${subject}${first?.message ?? ''}`,
    fix: first?.hint ?? 'Run "fireforge verify" for all of them.',
  };
}

/**
 * The mode-dependent diagnostics of a project, in the order a broken one
 * should be repaired. A check that cannot run because an earlier one failed
 * is left out.
 *
 * @param project - The project
 */
export async function diagnose(project: Project): Promise<Diagnosis[]> {
  const found: Diagnosis[] = [];
  const check = async (id: string, title: string, run: () => Promise<Answer>): Promise<boolean> => {
    const answer = await run().catch(failed);
    found.push({ id, title, ...answer });
    return answer.status !== 'fail';
  };
  await check('git', 'Git', () => gitVersion(project));
  let pristine: Pristine | undefined;
  await check('pristine', 'Pinned Firefox source', async () => {
    pristine = await pinnedPristine(project);
    return { status: 'ok', detail: `${pinKey(project.config.firefox)} at ${pristine.commit}` };
  });
  const source = pristine;
  if (source === undefined) return found;
  if (project.mode === 'source') {
    await check('merge-driver', 'Merge driver', () => mergeDriver(project));
    await check('workspaces', 'Workspace pool', () => pool(project, source));
    await check('storage', 'Owned files and records', () => storage(project));
    return found;
  }
  if (await check('engine', 'Engine', () => patchEngine(project, source))) {
    await check('storage', 'Patch queue', () => storage(project));
    if (await exists(project.paths.furnace)) {
      await check('components', 'Deployed components', () => deployment(project));
    }
  }
  return found;
}
