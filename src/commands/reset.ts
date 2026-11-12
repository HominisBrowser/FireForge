// SPDX-License-Identifier: EUPL-1.2
import {
  confirmOptions,
  defineCommand,
  lockOptions,
  lockWaitMs,
  usageError,
} from '../cli/command.js';
import { withEngineLock } from '../engine/index.js';
import { confirm } from '../kernel/tty.js';
import { loadProject } from '../project/index.js';
import { requirePatchMode, resetEngine } from '../queue/index.js';

export const reset = defineCommand({
  name: 'reset',
  summary: 'Reset engine/ to pristine Firefox, dropping every change',
  description:
    'Tracked files are restored, untracked files removed, build output kept. A paused import or ' +
    'rebase is dropped. A recovery snapshot keeps what is discarded.',
  group: 'Patches',
  options: { ...confirmOptions, ...lockOptions },
  json: true,
  run: async (ctx, _args, opts) => {
    const project = requirePatchMode(await loadProject(ctx.cwd, ctx.env));
    if (!opts.yes) {
      if (!ctx.interactive) {
        throw usageError('reset discards every change in engine/.', 'Pass --yes to confirm.');
      }
      if (!(await confirm('Discard every change in engine/?'))) return;
    }
    const result = await withEngineLock(
      project,
      { command: 'reset', waitMs: lockWaitMs(opts.waitLock) },
      () => resetEngine(project)
    );
    ctx.out.line(result.changed ? 'engine/ is pristine again.' : 'engine/ was already pristine.');
    if (result.snapshot !== undefined) ctx.out.line(`Recovery snapshot: ${result.snapshot}`);
    ctx.out.json({ changed: result.changed, snapshot: result.snapshot ?? null });
  },
});
