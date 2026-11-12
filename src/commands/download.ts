// SPDX-License-Identifier: EUPL-1.2
import { defineCommand, lockOptions, lockWaitMs, opt } from '../cli/command.js';
import { step } from '../kernel/log.js';
import { download as fetchPin } from '../mode/index.js';
import { loadProject } from '../project/index.js';

export const download = defineCommand({
  name: 'download',
  summary: 'Fetch the pinned Firefox source',
  description:
    'Downloads the source archive of the pin in fireforge.json, verifies it, and imports it as ' +
    'one commit into the pristine repository this host keeps per pin. In patch mode engine/ ' +
    'then becomes a checkout of that commit. A host that already has the pin downloads nothing.',
  group: 'Engine',
  options: {
    force: opt.flag(
      'Replace an existing engine/, keeping its uncommitted changes as a recovery snapshot'
    ),
    ...lockOptions,
  },
  json: true,
  run: async (ctx, _args, opts) => {
    const project = await loadProject(ctx.cwd, ctx.env);
    const { pristine, engine } = await fetchPin(project, {
      force: opts.force,
      waitMs: lockWaitMs(opts.waitLock),
      onProgress: step,
    });
    ctx.out.line(`Firefox ${project.config.firefox.version} is at commit ${pristine.commit}`);
    if (engine !== undefined) {
      ctx.out.line(`${engine.replaced ? 'Replaced' : 'Created'} ${engine.engineDir}`);
      if (engine.recovery !== undefined) {
        ctx.out.line(`The previous engine's changes are saved as ${engine.recovery}`);
      }
    }
    ctx.out.json({
      commit: pristine.commit,
      pristine: pristine.repo,
      engine: engine?.engineDir ?? null,
      replaced: engine?.replaced ?? false,
      recovery: engine?.recovery ?? null,
    });
  },
});
