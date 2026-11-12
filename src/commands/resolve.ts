// SPDX-License-Identifier: EUPL-1.2
import { defineCommand, lockOptions, lockWaitMs } from '../cli/command.js';
import { withEngineLock } from '../engine/index.js';
import { loadProject } from '../project/index.js';
import { requirePatchMode, resolvePatchFromEngine } from '../queue/index.js';

export const resolve = defineCommand({
  name: 'resolve',
  summary: 'After a failed import, rewrite the failed patch from engine/',
  description:
    "The patch's new body is the change engine/ now holds in the patch's files, relative to what " +
    'the patches before it leave there. Run "fireforge import --continue" afterwards to apply the rest.',
  group: 'Patches',
  options: { ...lockOptions },
  json: true,
  run: async (ctx, _args, opts) => {
    const project = requirePatchMode(await loadProject(ctx.cwd, ctx.env));
    const resolution = await withEngineLock(
      project,
      { command: 'resolve', waitMs: lockWaitMs(opts.waitLock) },
      () => resolvePatchFromEngine(project)
    );
    ctx.out.line(`Rewrote ${resolution.patch} (${resolution.files.length} file(s)).`);
    ctx.out.line('Run "fireforge import --continue" to apply the rest of the queue.');
    ctx.out.json({ patch: resolution.patch, files: [...resolution.files] });
  },
});
