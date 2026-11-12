// SPDX-License-Identifier: EUPL-1.2
import { defineCommand, lockWaitMs } from '../cli/command.js';
import { bootstrap as runBootstrap } from '../engine/index.js';
import { withWorkspace } from '../mode/index.js';
import { loadProject } from '../project/index.js';
import { workspaceOptions } from './workspace.js';

export const bootstrap = defineCommand({
  name: 'bootstrap',
  summary: 'Install Firefox build dependencies (mach bootstrap)',
  description:
    'Runs mach bootstrap for the browser application. It may prompt and ask for elevated rights.',
  group: 'Engine',
  options: { ...workspaceOptions },
  run: async (ctx, _args, opts) => {
    const project = await loadProject(ctx.cwd, ctx.env);
    await withWorkspace(
      project,
      { command: 'bootstrap', workspace: opts.workspace, waitMs: lockWaitMs(opts.waitLock) },
      runBootstrap
    );
    ctx.out.line('Build dependencies are installed.');
  },
});
