// SPDX-License-Identifier: EUPL-1.2
import { defineCommand, lockWaitMs, opt } from '../cli/command.js';
import { build as buildWorkspace } from '../engine/index.js';
import { formatDuration } from '../kernel/time.js';
import { deployComponents, withWorkspace } from '../mode/index.js';
import { loadProject } from '../project/index.js';
import { workspaceOptions } from './workspace.js';

export const build = defineCommand({
  name: 'build',
  summary: 'Build the browser in the workspace',
  description:
    'Deploys the components, then runs mach build. --ui rebuilds the front end only and becomes ' +
    'a full build when a compiled source or build definition changed since the last one.',
  group: 'Daily',
  options: {
    ui: opt.flag('Rebuild the front end only (mach build faster)'),
    jobs: opt.integer('Parallel compile jobs (default build.jobs)', { short: 'j', min: 1 }),
    ...workspaceOptions,
  },
  json: true,
  run: async (ctx, _args, opts) => {
    const project = await loadProject(ctx.cwd, ctx.env);
    const waitMs = lockWaitMs(opts.waitLock);
    const { workspace, result } = await withWorkspace(
      project,
      { command: 'build', workspace: opts.workspace, waitMs },
      async (leased) => {
        await deployComponents(leased, { waitMs });
        const built = await buildWorkspace(leased, { ui: opts.ui, jobs: opts.jobs, waitMs });
        return { workspace: leased.name, result: built };
      }
    );
    ctx.out.line(
      `${result.kind === 'ui' ? 'UI build' : 'Full build'} of workspace "${workspace}" finished in ${formatDuration(result.durationMs)}.`
    );
    ctx.out.json({
      workspace,
      kind: result.kind,
      escalated: result.escalated ?? null,
      durationMs: result.durationMs,
      unpackaged: result.unpackaged,
    });
  },
});
