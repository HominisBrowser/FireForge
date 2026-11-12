// SPDX-License-Identifier: EUPL-1.2
import { arg, defineCommand, lockOptions, opt } from '../cli/command.js';
import type { CommandContext } from '../cli/context.js';
import {
  addWorkspace,
  type PoolWorkspace,
  removeWorkspace,
  repairWorkspace,
} from '../engine/index.js';
import { FireForgeError } from '../kernel/errors.js';
import { listAllWorkspaces } from '../mode/index.js';
import { hostPaths, loadProject, type Project } from '../project/index.js';

/** The options of every command that works in a workspace. */
export const workspaceOptions = {
  workspace: opt.string(
    'Source mode: use this pool workspace instead of the best free one ("fireforge workspace list" names them)',
    { valueName: 'name' }
  ),
  ...lockOptions,
};

/** The project the command was run in, or undefined outside one: the pool belongs to the host. */
async function projectHere(ctx: CommandContext): Promise<Project | undefined> {
  try {
    return await loadProject(ctx.cwd, ctx.env);
  } catch (error: unknown) {
    if (error instanceof FireForgeError && error.code === 'project-not-found') return undefined;
    throw error;
  }
}

function row(workspace: PoolWorkspace): string {
  const state =
    workspace.holders.length > 0
      ? `leased by PID ${workspace.holders.map((holder) => holder.pid).join(', ')}`
      : 'free';
  const last =
    workspace.lessee === undefined ? 'never leased' : `last used by ${workspace.lessee.root}`;
  return `${workspace.name}  ${workspace.pin}  ${workspace.built ? 'built' : 'not built'}  ${state}  ${last}`;
}

const list = defineCommand({
  name: 'list',
  summary: 'List the workspaces of this host',
  json: true,
  run: async (ctx) => {
    const { engine, pool } = await listAllWorkspaces(hostPaths(ctx.env), await projectHere(ctx));
    if (engine !== undefined) {
      const state =
        engine.holders.length > 0 ? `in use by PID ${engine.holders.join(', ')}` : 'free';
      ctx.out.line(`engine  ${engine.path}  ${state}`);
    }
    for (const workspace of pool) ctx.out.line(row(workspace));
    if (engine === undefined && pool.length === 0) ctx.out.line('The pool is empty.');
    ctx.out.json({
      engine: engine ?? null,
      workspaces: pool.map((workspace) => ({
        name: workspace.name,
        path: workspace.dir,
        pin: workspace.pin,
        commit: workspace.commit,
        built: workspace.built,
        clonedFrom: workspace.clonedFrom ?? null,
        lessee: workspace.lessee ?? null,
        holders: workspace.holders.map((holder) => holder.pid),
      })),
    });
  },
});

const add = defineCommand({
  name: 'add',
  summary: "Create a workspace on the project's Firefox",
  description:
    'Checks the pinned Firefox out of the pristine repository. With --from, clones the engine of ' +
    'another workspace copy-on-write instead, with what is recorded about its content. Either way ' +
    'the new workspace needs a full build: an object directory is tied to the path it was ' +
    'configured at, so a build is never copied or moved to another workspace.',
  args: { name: arg.string('Name of the new workspace') },
  options: {
    from: opt.string("Clone this workspace's engine, without its builds", { valueName: 'name' }),
  },
  json: true,
  run: async (ctx, { name }, { from }) => {
    const project = await loadProject(ctx.cwd, ctx.env);
    const workspace = await addWorkspace(project.host, name, { pin: project.config.firefox, from });
    ctx.out.line(`Created workspace "${workspace.name}" at ${workspace.dir}`);
    ctx.out.line(
      from === undefined
        ? 'It needs a full build before it is useful.'
        : `The builds of "${from}" were not copied (a build cannot be moved to another path): it needs a full build.`
    );
    ctx.out.json({
      name: workspace.name,
      path: workspace.dir,
      pin: workspace.pin,
      built: workspace.built,
    });
  },
});

const remove = defineCommand({
  name: 'remove',
  summary: 'Delete a workspace and its build',
  args: { name: arg.string('The workspace') },
  json: true,
  run: async (ctx, { name }) => {
    await removeWorkspace(hostPaths(ctx.env), name);
    ctx.out.line(`Removed workspace "${name}"`);
    ctx.out.json({ name, removed: true });
  },
});

const repair = defineCommand({
  name: 'repair',
  summary: "Reset a workspace's engine to the pristine Firefox, keeping its build",
  description:
    'Restores every file of the engine, removes what was added, and forgets what was recorded ' +
    "about the engine's content (materialized files, deployed components, test runs), so the " +
    "next command that leases the workspace applies the project's source afresh. The object " +
    'directory and the release build stay.',
  args: { name: arg.string('The workspace') },
  json: true,
  run: async (ctx, { name }) => {
    await repairWorkspace(hostPaths(ctx.env), name);
    ctx.out.line(`Reset workspace "${name}" to the pristine source`);
    ctx.out.json({ name, repaired: true });
  },
});

export const workspace = defineCommand({
  name: 'workspace',
  summary: 'Manage the host pool of engine workspaces',
  group: 'Engine',
  subcommands: [list, add, remove, repair],
});
