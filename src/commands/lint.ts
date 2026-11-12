// SPDX-License-Identifier: EUPL-1.2
import { arg, defineCommand, lockOptions, lockWaitMs, opt } from '../cli/command.js';
import { FireForgeError } from '../kernel/errors.js';
import { isVerbose } from '../kernel/log.js';
import { lintReportJson, lintVerdict, renderLintReport, runLint } from '../lint/index.js';
import { lintSubject, typeCacheDir, withOwnedRead } from '../mode/index.js';
import { loadProject } from '../project/index.js';

export const lint = defineCommand({
  name: 'lint',
  summary: 'Check the owned changes against the quality rules',
  description:
    'Runs every rule over the owned changes (patchLint, patchPolicy, checkJs) and applies the ' +
    "groups' waivers. Errors fail the run; warnings fail it past --max-warnings.",
  group: 'Daily',
  args: { paths: arg.list('Engine-relative files or directories to report on') },
  options: {
    maxWarnings: opt.integer('Fail when more warnings than this remain', { min: 0 }),
    perPatch: opt.flag(
      'Patch mode: judge the stored queue patch by patch instead of what the engine holds'
    ),
    ...lockOptions,
  },
  json: true,
  run: async (ctx, { paths }, { maxWarnings, perPatch, waitLock }) => {
    const project = await loadProject(ctx.cwd, ctx.env);
    await withOwnedRead(project, { command: 'lint', waitMs: lockWaitMs(waitLock) }, async () => {
      const subject = await lintSubject(project, { scope: perPatch ? 'queue' : 'engine' });
      const report = await runLint(subject.changes, subject.engine, project.config, {
        projectRoot: project.root,
        sequential: subject.sequential,
        components: subject.components,
        paths,
        cacheDir: typeCacheDir(project),
        ...(subject.tokens === undefined ? {} : { tokens: subject.tokens }),
      });
      const verdict = lintVerdict(report, maxWarnings);
      for (const line of renderLintReport(report, verdict, isVerbose())) ctx.out.line(line);
      ctx.out.json(lintReportJson(report, verdict));
      if (!verdict.pass) {
        throw new FireForgeError('lint-failed', `Lint failed: ${verdict.reason ?? ''}.`, {
          hint:
            'Fix the findings listed above, or, for a reviewed exception, add the rule to the ' +
            "group's lintIgnore.",
        });
      }
    });
  },
});
