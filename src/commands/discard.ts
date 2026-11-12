// SPDX-License-Identifier: EUPL-1.2
import { arg, defineCommand, lockOptions, lockWaitMs } from '../cli/command.js';
import { withEngineLock } from '../engine/index.js';
import { loadProject } from '../project/index.js';
import { discard as discardPaths, enginePaths, requirePatchMode } from '../queue/index.js';

export const discard = defineCommand({
  name: 'discard',
  summary: 'Restore engine files to what the patch queue leaves there',
  description:
    'A file the queue touches gets the queue-applied content back (re-created or removed as the ' +
    'queue has it); any other changed file goes back to upstream, and an untracked one is deleted. ' +
    'Paths are engine-relative (relative to the current directory inside engine/); a directory ' +
    'covers every changed file below it. A recovery snapshot keeps what is discarded.',
  group: 'Patches',
  args: { paths: arg.list('Engine files or directories', { required: true }) },
  options: { ...lockOptions },
  json: true,
  run: async (ctx, { paths }, opts) => {
    const project = requirePatchMode(await loadProject(ctx.cwd, ctx.env));
    const targets = enginePaths(project.paths.engine, ctx.cwd, paths);
    const result = await withEngineLock(
      project,
      { command: 'discard', waitMs: lockWaitMs(opts.waitLock) },
      () => discardPaths(project, targets)
    );
    if (result.paths.length === 0) ctx.out.line('Nothing to discard.');
    for (const entry of result.paths) {
      const to = entry.to === 'queue' ? `queue baseline (${entry.owners.join(', ')})` : 'upstream';
      ctx.out.line(`${entry.path}: ${entry.was} -> ${to}`);
    }
    if (result.snapshot !== undefined) ctx.out.line(`Recovery snapshot: ${result.snapshot}`);
    ctx.out.json({
      paths: result.paths.map((entry) => ({
        path: entry.path,
        was: entry.was,
        to: entry.to,
        owners: [...entry.owners],
      })),
      snapshot: result.snapshot ?? null,
    });
  },
});
