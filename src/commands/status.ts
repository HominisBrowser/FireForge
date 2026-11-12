// SPDX-License-Identifier: EUPL-1.2
import { defineCommand, lockOptions, lockWaitMs, opt } from '../cli/command.js';
import { ExitCode, FireForgeError } from '../kernel/errors.js';
import { status as readStatus, withOwnedRead } from '../mode/index.js';
import { loadProject } from '../project/index.js';

export const status = defineCommand({
  name: 'status',
  summary: 'Show the owned changes and anything unaccounted for',
  description:
    'Patch mode: edits no patch holds, queue files not applied, a paused import or rebase. ' +
    'Source mode: undeclared edits of upstream files, stale or orphaned override records. ' +
    '--groups lists the groups of the owned paths by ID: the name patchLint.waivers, ' +
    'patchPolicy.scopeRules and patchPolicy.reservedRanges select a group by.',
  group: 'Daily',
  options: {
    check: opt.flag('Exit nonzero when anything is unaccounted for'),
    groups: opt.flag('List every group with its ID, kind and number of paths'),
    ...lockOptions,
  },
  json: true,
  run: async (ctx, _args, opts) => {
    const project = await loadProject(ctx.cwd, ctx.env);
    const report = await withOwnedRead(
      project,
      { command: 'status', waitMs: lockWaitMs(opts.waitLock) },
      () => readStatus(project)
    );
    const furnace = report.groups.filter((group) => group.kind === 'furnace').length;
    ctx.out.line(
      `${report.owned.length} owned path(s) in ${report.groups.length - furnace} group(s)` +
        (furnace === 0 ? '' : `, and ${furnace} Furnace component(s)`)
    );
    if (opts.groups) {
      for (const group of report.groups) {
        ctx.out.line(`  ${group.id}  ${group.kind}  ${group.paths} path(s)`);
      }
    }
    for (const problem of report.pending) {
      const subject = problem.subject === undefined ? '' : `${problem.subject}: `;
      ctx.out.line(`${problem.code}  ${subject}${problem.message}`);
      if (problem.hint !== undefined) ctx.out.line(`  ${problem.hint}`);
    }
    if (report.pending.length === 0) ctx.out.line('Nothing is unaccounted for.');
    ctx.out.json({ ...report, clean: report.pending.length === 0 });
    if (opts.check && report.pending.length > 0) {
      throw new FireForgeError(
        'status-not-clean',
        `${report.pending.length} thing(s) are unaccounted for.`,
        {
          exitCode: ExitCode.GENERAL_ERROR,
          hint: 'Each line above names the command that accounts for it.',
        }
      );
    }
  },
});
