// SPDX-License-Identifier: EUPL-1.2
import { defineCommand, lockWaitMs, opt } from '../cli/command.js';
import { FireForgeError } from '../kernel/errors.js';
import {
  deployComponents,
  lintSubject,
  requireCurrentTyping,
  typeCacheDir,
  withWorkspace,
} from '../mode/index.js';
import { loadProject } from '../project/index.js';
import {
  explainTypecheck,
  explanationJson,
  renderExplanation,
  renderTypecheckReport,
  runTypecheck,
  typecheckReportJson,
  typecheckVerdict,
} from '../typecheck/index.js';
import { workspaceOptions } from './workspace.js';

export const typecheck = defineCommand({
  name: 'typecheck',
  summary: 'Type-check the configured projects and the owned files',
  description:
    'Checks each typecheck.projects jsconfig whole, with the Firefox-globals shim, and the ' +
    "owned files with lint's strict checkJs pass. Any error fails the run. The typing files " +
    'Furnace generates must be current ("fireforge furnace types").',
  group: 'Daily',
  options: {
    project: opt.list('Check this project instead of typecheck.projects; repeat for several', {
      valueName: 'path',
    }),
    explain: opt.string('Check nothing; print how both passes see this file', {
      valueName: 'file',
    }),
    ...workspaceOptions,
  },
  json: true,
  run: async (ctx, _args, { project: projects, explain, workspace, waitLock }) => {
    const project = await loadProject(ctx.cwd, ctx.env);
    await requireCurrentTyping(project);
    const waitMs = lockWaitMs(waitLock);
    await withWorkspace(project, { command: 'typecheck', workspace, waitMs }, async (leased) => {
      await deployComponents(leased, { waitMs });
      const subject = await lintSubject(project, { workspace: leased });
      const request = {
        config: project.config,
        projectRoot: project.root,
        engineDir: leased.engineDir,
        changes: subject.changes,
        engine: subject.engine,
        cacheDir: typeCacheDir(project),
        ...(projects.length === 0 ? {} : { projects }),
      };
      if (explain !== undefined) {
        const explanation = await explainTypecheck(request, explain);
        for (const line of renderExplanation(explanation)) ctx.out.line(line);
        ctx.out.json(explanationJson(explanation));
        return;
      }
      const report = await runTypecheck(request);
      for (const line of renderTypecheckReport(report)) ctx.out.line(line);
      ctx.out.json(typecheckReportJson(report));
      const verdict = typecheckVerdict(report);
      if (!verdict.pass) {
        throw new FireForgeError(
          'typecheck-failed',
          `Typecheck found ${verdict.errors} error(s).`,
          {
            hint: 'Fix the errors listed above; "fireforge typecheck --explain <file>" shows how both passes see a file.',
          }
        );
      }
    });
  },
});
