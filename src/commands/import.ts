// SPDX-License-Identifier: EUPL-1.2
import { defineCommand, lockOptions, lockWaitMs, opt } from '../cli/command.js';
import { withEngineLock } from '../engine/index.js';
import { loadProject } from '../project/index.js';
import { importQueue, requirePatchMode } from '../queue/index.js';

export const importCommand = defineCommand({
  name: 'import',
  summary: 'Apply the patch queue to engine/',
  description:
    'Every file the queue touches ends holding what the queue leaves there; other engine edits are ' +
    'kept. A patch that does not apply pauses the import with its fitting hunks applied and the rest ' +
    'in .rej files: finish the change in engine/, then run "fireforge import --continue" (or ' +
    '"fireforge resolve" to only rewrite the patch).',
  group: 'Patches',
  options: {
    until: opt.string(
      'Apply the queue only up to and including this patch (order, filename or name)',
      {
        valueName: 'patch',
      }
    ),
    continue: opt.flag(
      'Resume a paused import: rewrite the failed patch from engine/, then apply the rest'
    ),
    force: opt.flag(
      "Overwrite edits in the queue's files that no patch accounts for (a recovery snapshot keeps them)"
    ),
    ...lockOptions,
  },
  constraints: { exclusive: [['until', 'continue']] },
  json: true,
  run: async (ctx, _args, opts) => {
    const project = requirePatchMode(await loadProject(ctx.cwd, ctx.env));
    const run = await withEngineLock(
      project,
      { command: 'import', waitMs: lockWaitMs(opts.waitLock) },
      () =>
        importQueue(project, {
          ...(opts.until === undefined ? {} : { until: opts.until }),
          continue: opts.continue,
          force: opts.force,
        })
    );
    const applied = run.patches.filter((patch) => patch.status !== 'pending');
    for (const patch of run.patches) {
      for (const path of patch.replaced ?? []) {
        ctx.out.line(`${patch.patch} replaced the upstream file ${path}`);
      }
    }
    ctx.out.line(
      `Applied ${applied.length} patch(es); ${run.written.length} engine file(s) written.`
    );
    ctx.out.json({
      patches: run.patches.map((patch) => ({
        patch: patch.patch,
        status: patch.status,
        ...(patch.replaced === undefined ? {} : { replaced: [...patch.replaced] }),
      })),
      written: [...run.written],
    });
  },
});
