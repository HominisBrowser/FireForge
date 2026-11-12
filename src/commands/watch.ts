// SPDX-License-Identifier: EUPL-1.2
import { defineCommand, lockWaitMs } from '../cli/command.js';
import { deployComponents, watch as watchWorkspace, withWorkspace } from '../mode/index.js';
import { loadProject } from '../project/index.js';
import { workspaceOptions } from './workspace.js';

export const watch = defineCommand({
  name: 'watch',
  summary: 'Rebuild front-end files as the project changes (mach watch)',
  description:
    'Needs watchman and a completed build. Edits of the engine are rebuilt by mach; edits of a ' +
    "source-mode project's owned files and of the components are brought into the workspace's " +
    'engine first. The workspace stays held until the watch is stopped.',
  group: 'Daily',
  options: { ...workspaceOptions },
  run: async (ctx, _args, opts) => {
    const project = await loadProject(ctx.cwd, ctx.env);
    const waitMs = lockWaitMs(opts.waitLock);
    await withWorkspace(
      project,
      { command: 'watch', workspace: opts.workspace, waitMs },
      async (workspace) => {
        await deployComponents(workspace, { waitMs });
        await watchWorkspace(workspace, { env: ctx.env });
      }
    );
  },
});
