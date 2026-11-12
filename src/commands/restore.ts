// SPDX-License-Identifier: EUPL-1.2
import { arg, defineCommand, opt } from '../cli/command.js';
import { loadProject } from '../project/index.js';
import { requireSourceMode, restore as giveBack } from '../source/index.js';

export const restore = defineCommand({
  name: 'restore',
  summary: 'Give an upstream file back: remove its override record and owned file',
  description: 'The next materialization restores the upstream bytes.',
  group: 'Source',
  args: { path: arg.string('Engine path of the overridden file') },
  options: { discard: opt.flag('Drop uncommitted edits of the owned file') },
  json: true,
  run: async (ctx, { path }, opts) => {
    const project = requireSourceMode(await loadProject(ctx.cwd, ctx.env));
    const restored = await giveBack(project, path, { discard: opts.discard });
    ctx.out.line(
      restored.wasDeletion ? `${path} is no longer deleted.` : `${path} is back to upstream.`
    );
    ctx.out.json({ ...restored });
  },
});
