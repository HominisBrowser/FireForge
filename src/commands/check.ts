// SPDX-License-Identifier: EUPL-1.2
import { checkJson, renderCheck, runCheck } from '../check/index.js';
import { defineCommand, lockWaitMs, opt } from '../cli/command.js';
import { FireForgeError } from '../kernel/errors.js';
import { loadProject } from '../project/index.js';
import { workspaceOptions } from './workspace.js';

export const check = defineCommand({
  name: 'check',
  summary: 'Run the static checks as one judgement',
  description:
    'Runs status, verify, lint, typecheck, furnace-validate, token-coverage, token-lint and the ' +
    "project's check.extraSteps, side by side where they do not depend on each other, and ends " +
    'with one verdict line. A step with nothing to run is skipped. The steps that work in an ' +
    'engine share one workspace.',
  group: 'Daily',
  options: {
    only: opt.list('Run only this step; repeat for several', { valueName: 'step' }),
    skip: opt.list('Leave this step out; repeat for several', { valueName: 'step' }),
    ...workspaceOptions,
  },
  constraints: { exclusive: [['only', 'skip']] },
  json: true,
  verdict: true,
  run: async (ctx, _args, opts) => {
    const project = await loadProject(ctx.cwd, ctx.env);
    const report = await runCheck(project, {
      only: opts.only,
      skip: opts.skip,
      workspace: opts.workspace,
      waitMs: lockWaitMs(opts.waitLock),
    });
    for (const line of renderCheck(report)) ctx.out.line(line);
    ctx.out.json(checkJson(report));
    const count = (status: string): number =>
      report.steps.filter((step) => step.status === status).length;
    ctx.out.verdict(report.pass, {
      ...(report.pass ? {} : { reason: 'check-failed', failed: report.failed.join(',') }),
      steps: report.steps.length,
      passed: count('pass'),
      skipped: count('skipped'),
    });
    if (!report.pass) {
      throw new FireForgeError('check-failed', `Check failed: ${report.failed.join(', ')}.`, {
        hint: 'Fix what each failed step reports above; "fireforge check --only <step>" runs one step.',
      });
    }
  },
});
