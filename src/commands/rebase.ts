// SPDX-License-Identifier: EUPL-1.2
import { defineCommand, lockOptions, lockWaitMs, opt } from '../cli/command.js';
import { FIREFOX_PRODUCTS } from '../config/index.js';
import { ExitCode, FireForgeError } from '../kernel/errors.js';
import { step } from '../kernel/log.js';
import { rebase as rebaseProject } from '../mode/index.js';
import { loadProject } from '../project/index.js';

export const rebase = defineCommand({
  name: 'rebase',
  summary: 'Move the project to a new Firefox version',
  description:
    'Downloads the new version and writes it to fireforge.json. Patch mode: replaces engine/ ' +
    'with the new source and re-applies the queue with reduced context, rewriting every patch; ' +
    'a patch that does not apply pauses the rebase for --continue, or for --abort, which ' +
    'restores the previous version, its engine and the applied queue. Source mode: ' +
    'merges every owned file three ways on a committed tree; conflicts are left as markers.',
  group: 'Project',
  options: {
    to: opt.string('The Firefox version to move to, such as 153.8.0esr', {
      valueName: 'version',
    }),
    product: opt.enum(FIREFOX_PRODUCTS, 'Product of the new version (default: by its shape)'),
    sha256: opt.string('Pinned SHA-256 of the new source archive', { valueName: 'digest' }),
    candidate: opt.string('Release-candidate build directory of the new version, such as build1', {
      valueName: 'build',
    }),
    continue: opt.flag('Patch mode: resume a paused rebase from the fixed engine'),
    abort: opt.flag('Patch mode: give up a paused rebase and go back to the version it left'),
    dryRun: opt.flag('Patch mode: report whether the queue applies, changing nothing'),
    force: opt.flag(
      'Patch mode: rebase over engine edits no patch has (a recovery snapshot keeps them)'
    ),
    ...lockOptions,
  },
  constraints: {
    exclusive: [['continue', 'abort', 'dryRun', 'force']],
    requires: { product: ['to'], sha256: ['to'], candidate: ['to'] },
  },
  json: true,
  run: async (ctx, _args, opts) => {
    const project = await loadProject(ctx.cwd, ctx.env);
    const report = await rebaseProject(project, {
      to: opts.to,
      product: opts.product,
      sha256: opts.sha256,
      candidate: opts.candidate,
      continue: opts.continue,
      abort: opts.abort,
      dryRun: opts.dryRun,
      force: opts.force,
      waitMs: lockWaitMs(opts.waitLock),
      onProgress: step,
    });
    for (const entry of report.entries) {
      if (entry.outcome !== 'kept' && entry.outcome !== 'applied') {
        ctx.out.line(`${entry.outcome}  ${entry.subject}`);
      }
    }
    for (const conflict of report.conflicts) ctx.out.line(`conflict  ${conflict}`);
    ctx.out.line(`Rebase ${report.status}: Firefox ${report.pin.version} (${report.pin.product}).`);
    ctx.out.json({ ...report });
    if (report.conflicts.length > 0) {
      throw new FireForgeError(
        'rebase-conflicts',
        `${report.conflicts.length} conflict(s) need resolving.`,
        {
          exitCode: ExitCode.RESOLUTION_ERROR,
          hint:
            report.status === 'dry-run'
              ? 'Nothing was changed.'
              : 'Resolve the conflict markers in the listed files, then commit.',
        }
      );
    }
  },
});
