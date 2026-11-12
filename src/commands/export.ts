// SPDX-License-Identifier: EUPL-1.2
import { arg, defineCommand, lockOptions, lockWaitMs, opt } from '../cli/command.js';
import { exportChanges } from '../mode/index.js';
import { loadProject } from '../project/index.js';

export const exportCommand = defineCommand({
  name: 'export',
  summary: 'Capture edits into a new patch, or write the generated patch queue',
  description:
    'Patch mode: captures the engine edits of <paths> (or with --all, every edit no patch ' +
    'holds) into a new patch named --name. Source mode: writes the owned changes as a patch ' +
    'queue into --out (default patches/), after proving that it replays to the tree this ' +
    'checkout builds.',
  group: 'Daily',
  args: { paths: arg.list('Patch mode: engine files or directories to capture') },
  options: {
    all: opt.flag('Patch mode: capture every edit no patch holds'),
    name: opt.string('Patch mode: name of the new patch, such as ui-sidebar', {
      valueName: 'name',
    }),
    description: opt.string('Patch mode: what the patch does', { short: 'd', valueName: 'text' }),
    order: opt.integer('Patch mode: order number of the new patch (default: after the last)', {
      min: 1,
    }),
    before: opt.string('Patch mode: place the new patch before this one', { valueName: 'patch' }),
    after: opt.string('Patch mode: place the new patch after this one', { valueName: 'patch' }),
    tier: opt.enum(['branding'], 'Patch mode: size tier the patch is held to'),
    out: opt.path('Source mode: directory the queue is written to'),
    ...lockOptions,
  },
  constraints: { exclusive: [['order', 'before', 'after']] },
  json: true,
  run: async (ctx, { paths }, opts) => {
    const project = await loadProject(ctx.cwd, ctx.env);
    const outcome = await exportChanges(project, {
      ...opts,
      paths,
      waitMs: lockWaitMs(opts.waitLock),
    });
    if (outcome.kind === 'queue') {
      ctx.out.line(`Wrote ${outcome.queue.patches.length} patch(es) to ${outcome.queue.out}`);
      ctx.out.json({ ...outcome.queue });
      return;
    }
    ctx.out.line(`Exported ${outcome.files.length} file(s) as ${outcome.patch}`);
    ctx.out.json({ patch: outcome.patch, files: outcome.files });
  },
});
