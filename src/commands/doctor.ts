// SPDX-License-Identifier: EUPL-1.2
import { defineCommand, opt } from '../cli/command.js';
import { renderDoctor, runDoctor } from '../doctor/index.js';
import { FireForgeError } from '../kernel/errors.js';

export const doctor = defineCommand({
  name: 'doctor',
  summary: 'Diagnose the project and the host',
  description:
    'Checks the configuration, git, the pinned Firefox source, the engine or the workspace ' +
    'pool, the stored owned changes, interrupted runs, locks, disk space, generated typing ' +
    'files and the tools externalToolchains declares, and says what to run for anything that ' +
    'is not in order.',
  group: 'Project',
  options: {
    recover: opt.flag('Undo the changes interrupted runs left half-made'),
  },
  json: true,
  run: async (ctx, _args, opts) => {
    const report = await runDoctor(ctx.cwd, ctx.env, { recover: opts.recover });
    for (const line of renderDoctor(report)) ctx.out.line(line);
    ctx.out.json({
      healthy: report.healthy,
      checks: report.checks.map((check) => ({ ...check, fix: check.fix ?? null })),
    });
    if (!report.healthy) {
      const failed = report.checks.filter((check) => check.status === 'fail');
      throw new FireForgeError(
        'doctor-unhealthy',
        `${failed.length} check(s) failed: ${failed.map((check) => check.id).join(', ')}.`,
        { hint: 'Each failed check above says how to repair it.' }
      );
    }
  },
});
