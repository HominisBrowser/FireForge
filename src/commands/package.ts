// SPDX-License-Identifier: EUPL-1.2
import { defineCommand, lockWaitMs, opt } from '../cli/command.js';
import { ensureBuilt, packageBrowser } from '../engine/index.js';
import { deployComponents, withWorkspace } from '../mode/index.js';
import { loadProject } from '../project/index.js';
import { workspaceOptions } from './workspace.js';

export const packageCommand = defineCommand({
  name: 'package',
  summary: 'Create a distribution package',
  description:
    'Packages the development build, which must match the source (--build brings it up to ' +
    'date). --release builds and packages with the build.release recipe in its own object directory.',
  group: 'Daily',
  options: {
    release: opt.flag('Build and package a release with build.release'),
    build: opt.flag('Build first when the development build is older than the engine'),
    out: opt.path("Where a release's outputs go (default .fireforge/release-output)"),
    jobs: opt.integer('Parallel jobs of the release build (default build.jobs)', {
      short: 'j',
      min: 1,
    }),
    ...workspaceOptions,
  },
  constraints: { exclusive: [['release', 'build']], requires: { out: ['release'] } },
  json: true,
  run: async (ctx, _args, opts) => {
    const project = await loadProject(ctx.cwd, ctx.env);
    const waitMs = lockWaitMs(opts.waitLock);
    const result = await withWorkspace(
      project,
      { command: 'package', workspace: opts.workspace, waitMs },
      async (workspace) => {
        await deployComponents(workspace, { waitMs });
        if (!opts.release) await ensureBuilt(workspace, { build: opts.build, waitMs });
        return packageBrowser(workspace, {
          release: opts.release,
          ...(opts.out === undefined ? {} : { outputDir: opts.out }),
          ...(opts.jobs === undefined ? {} : { jobs: opts.jobs }),
          waitMs,
        });
      }
    );
    for (const output of result.outputs) ctx.out.line(output);
    if (result.outputs.length === 0) ctx.out.line('Packaging produced no output file.');
    ctx.out.json({
      objDir: result.objDir,
      outputs: result.outputs,
      outputDir: result.outputDir ?? null,
    });
  },
});
