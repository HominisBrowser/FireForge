// SPDX-License-Identifier: EUPL-1.2
import { arg, defineCommand, lockWaitMs, opt } from '../cli/command.js';
import { ensureBuilt, runBrowser } from '../engine/index.js';
import { deployComponents, withWorkspace } from '../mode/index.js';
import { loadProject } from '../project/index.js';
import { workspaceOptions } from './workspace.js';

export const run = defineCommand({
  name: 'run',
  summary: 'Launch the built browser',
  description:
    'A build older than the engine is refused with the build to run; --build runs it first. ' +
    '--smoke-exit watches the console for that many seconds, ends the browser, and fails on ' +
    'errors no --console-allow pattern accepts.',
  group: 'Daily',
  args: { args: arg.list('Arguments for the browser, after "--"') },
  options: {
    build: opt.flag('Build first when the build is older than the engine'),
    smokeExit: opt.number('Smoke start: watch the console this long, then end the browser', {
      valueName: 'seconds',
    }),
    consoleAllow: opt.list('Console line pattern a smoke start accepts', { valueName: 'regex' }),
    consoleAllowFile: opt.path('File of such patterns, one per line'),
    captureConsole: opt.path('Write everything the browser prints to this file'),
    screenshot: opt.path('Save a screenshot of the first window here and exit'),
    profile: opt.path('Profile directory to launch with; it is kept'),
    tempProfile: opt.flag('Launch with a fresh profile that is removed afterwards'),
    headless: opt.flag('Launch without a window'),
    ...workspaceOptions,
  },
  constraints: { exclusive: [['profile', 'tempProfile']] },
  json: true,
  run: async (ctx, { args }, opts) => {
    const project = await loadProject(ctx.cwd, ctx.env);
    const waitMs = lockWaitMs(opts.waitLock);
    const result = await withWorkspace(
      project,
      { command: 'run', workspace: opts.workspace, waitMs },
      async (workspace) => {
        await deployComponents(workspace, { waitMs });
        await ensureBuilt(workspace, { build: opts.build, waitMs });
        return runBrowser(workspace, {
          args,
          consoleAllow: opts.consoleAllow,
          tempProfile: opts.tempProfile,
          headless: opts.headless,
          ...(opts.smokeExit === undefined ? {} : { smokeExit: opts.smokeExit }),
          ...(opts.consoleAllowFile === undefined
            ? {}
            : { consoleAllowFile: opts.consoleAllowFile }),
          ...(opts.captureConsole === undefined ? {} : { captureConsole: opts.captureConsole }),
          ...(opts.screenshot === undefined ? {} : { screenshot: opts.screenshot }),
          ...(opts.profile === undefined ? {} : { profile: opts.profile }),
          waitMs,
        });
      }
    );
    if (result.smoke !== undefined) {
      ctx.out.line(
        `Smoke start passed: ${result.smoke.elapsedMs} ms without an unallowed console error.`
      );
    }
    if (result.screenshot !== undefined) ctx.out.line(`Screenshot: ${result.screenshot}`);
    ctx.out.json({
      exitCode: result.exitCode,
      smoke: result.smoke === undefined ? null : { ...result.smoke },
      screenshot: result.screenshot ?? null,
      profile: result.profile ?? null,
    });
  },
});
