// SPDX-License-Identifier: EUPL-1.2
import { defineCommand, lockOptions, lockWaitMs } from '../cli/command.js';
import { verify as verifyStorage, verifyOutcome, withOwnedRead } from '../mode/index.js';
import { loadProject } from '../project/index.js';

export const verify = defineCommand({
  name: 'verify',
  summary: 'Check the integrity of where the owned changes are stored',
  description:
    'Patch mode: the manifest, every patch body, and that the queue replays onto the engine. ' +
    'Source mode: every override record and owned file against the pristine repository.',
  group: 'Daily',
  options: { ...lockOptions },
  json: true,
  run: async (ctx, _args, opts) => {
    const project = await loadProject(ctx.cwd, ctx.env);
    const report = await withOwnedRead(
      project,
      { command: 'verify', waitMs: lockWaitMs(opts.waitLock) },
      () => verifyStorage(project)
    );
    for (const problem of report.problems) {
      const subject = problem.subject === undefined ? '' : `${problem.subject}: `;
      ctx.out.line(`${problem.code}  ${subject}${problem.message}`);
      if (problem.hint !== undefined) ctx.out.line(`  ${problem.hint}`);
    }
    const outcome = verifyOutcome(report);
    if ('sound' in outcome) ctx.out.line(outcome.sound);
    ctx.out.json({ ...report, pass: report.problems.length === 0 });
    if ('failure' in outcome) throw outcome.failure;
  },
});
