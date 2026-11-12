// SPDX-License-Identifier: EUPL-1.2
import { arg, defineCommand, lockOptions, lockWaitMs, opt } from '../cli/command.js';
import { withEngineLock } from '../engine/index.js';
import { loadProject } from '../project/index.js';
import { reExport as reExportPatches, requirePatchMode } from '../queue/index.js';

export const reExport = defineCommand({
  name: 're-export',
  summary: 'Rewrite patches from the edits engine/ holds now',
  description:
    'Each patch is rewritten so the queue ends in what engine/ holds in its files. An edit to a ' +
    'file several patches change goes to the last of them being re-exported; the others keep ' +
    'their change. A patch whose files hold no edit is left byte for byte. A deleted file is ' +
    'recorded as a deletion; a file the patch created that engine/ no longer has leaves the patch.',
  group: 'Patches',
  args: { patches: arg.list('Patches to rewrite (order, filename or name)') },
  options: {
    all: opt.flag('Rewrite every patch'),
    scan: opt.flag(
      "Adopt edits no patch owns in the directories the patches' files are in (into the last such patch)"
    ),
    dryRun: opt.flag('Report what would change and write nothing'),
    stamp: opt.flag("Stamp the patches with the project's Firefox version"),
    ...lockOptions,
  },
  constraints: { oneOf: [['patches', 'all']] },
  json: true,
  run: async (ctx, { patches }, opts) => {
    const project = requirePatchMode(await loadProject(ctx.cwd, ctx.env));
    const result = await withEngineLock(
      project,
      {
        command: 're-export',
        mode: opts.dryRun ? 'shared' : 'exclusive',
        waitMs: lockWaitMs(opts.waitLock),
      },
      () =>
        reExportPatches(project, {
          ...(opts.all ? { all: true } : { patches }),
          scan: opts.scan,
          dryRun: opts.dryRun,
          stamp: opts.stamp,
        })
    );
    const verb = opts.dryRun ? 'Would rewrite' : 'Rewrote';
    for (const entry of result.patches) {
      ctx.out.line(`${entry.status === 'rewritten' ? verb : 'Unchanged'} ${entry.patch}`);
      for (const path of entry.adopted) ctx.out.line(`  + ${path} (adopted)`);
      for (const path of entry.dropped) ctx.out.line(`  - ${path} (no longer changed)`);
      if (entry.stamped) ctx.out.line(`  stamped ${project.config.firefox.version}`);
    }
    ctx.out.json({
      dryRun: opts.dryRun,
      patches: result.patches.map((entry) => ({
        patch: entry.patch,
        status: entry.status,
        adopted: [...entry.adopted],
        dropped: [...entry.dropped],
        stamped: entry.stamped,
      })),
    });
  },
});
