// SPDX-License-Identifier: EUPL-1.2
import { arg, defineCommand, lockWaitMs, opt } from '../cli/command.js';
import { deployComponents, mutationRoots, withWorkspace } from '../mode/index.js';
import { loadProject } from '../project/index.js';
import {
  controlReport,
  envAssignments,
  planTests,
  refusalLines,
  refusalVerdict,
  runControl,
  runReport,
  runTests,
  type TestReport,
  writeResults,
} from '../test/index.js';
import { workspaceOptions } from './workspace.js';

export const test = defineCommand({
  name: 'test',
  summary: 'Run tests in the workspace and judge the result',
  description:
    'Runs mochitest, xpcshell and reftest files, directories or manifests through mach and ends with ' +
    'one verdict line. A crash, a hang, a file that never started or finished, or an engine that ' +
    'changed under the harness never reads as a pass. With --control, runs a negative control: the ' +
    'tests must be green without the diff and red at exactly the --expect assertions with it.',
  group: 'Daily',
  args: {
    paths: arg.list('Engine-relative test files, directories or manifests', { required: true }),
  },
  options: {
    build: opt.flag('Build first when the build does not match the engine, instead of refusing'),
    headed: opt.flag('Show the browser, holding the host display lock (default headless)'),
    shard: opt.flag(
      'Give each mochitest file a browser of its own; --no-shard runs them all in one',
      {
        negatable: true,
        default: true,
      }
    ),
    standalone: opt.flag(
      'Run mochitest files in one invocation, restarting the browser between them'
    ),
    repeat: opt.integer('Run everything this many times; every run must pass', {
      min: 1,
      default: 1,
    }),
    shuffle: opt.integer('Permute the mochitest files with this seed', {
      valueName: 'seed',
      min: 0,
    }),
    machArg: opt.list(
      'Pass to mach: --setpref=<name>=<value>, --timeout=<s> or --app-path=<path>',
      {
        valueName: 'arg',
      }
    ),
    env: opt.list('Set NAME=VALUE in the harness environment', { valueName: 'NAME=VALUE' }),
    results: opt.path('Write the per-file results document here'),
    keepLog: opt.path("Also keep the run's complete output here"),
    coverage: opt.path("Write the harnesses' per-test JavaScript coverage under this directory"),
    control: opt.path('Run a negative control with the mutation in this diff'),
    expect: opt.list('An assertion the control must redden; repeat for each', {
      valueName: 'assertion',
    }),
    ...workspaceOptions,
  },
  constraints: {
    exclusive: [['shard', 'standalone']],
    requires: { control: ['expect'], expect: ['control'] },
  },
  json: true,
  verdict: true,
  run: async (ctx, { paths }, opts) => {
    const waitMs = lockWaitMs(opts.waitLock);
    const run = {
      build: opts.build,
      waitMs,
      ...(opts.keepLog === undefined ? {} : { keepLog: opts.keepLog }),
    };
    const extra = opts.results === undefined ? {} : { results: opts.results };
    let report: TestReport | undefined;
    try {
      const project = await loadProject(ctx.cwd, ctx.env);
      report = await withWorkspace(
        project,
        { command: 'test', workspace: opts.workspace, waitMs },
        async (workspace) => {
          // The project's components first, so a --build builds what the project holds now.
          await deployComponents(workspace, { waitMs });
          const plan = await planTests(workspace.engineDir, {
            paths,
            dispatch: opts.standalone ? 'standalone' : opts.shard ? 'shards' : 'one-browser',
            headed: opts.headed,
            repeat: opts.repeat,
            ...(opts.shuffle === undefined ? {} : { shuffle: opts.shuffle }),
            machArgs: opts.machArg,
            env: envAssignments(opts.env),
            ...(opts.coverage === undefined ? {} : { coverageDir: opts.coverage }),
          });
          return opts.control === undefined
            ? runReport(await runTests(workspace, plan, run), extra)
            : controlReport(
                await runControl(
                  workspace,
                  plan,
                  {
                    diff: opts.control,
                    expect: opts.expect,
                    roots: await mutationRoots(project),
                  },
                  run
                ),
                extra
              );
        }
      );
    } catch (error: unknown) {
      for (const line of refusalLines(error)) ctx.out.line(line);
      ctx.out.verdict(false, refusalVerdict(error));
      throw error;
    }
    if (opts.results !== undefined) await writeResults(opts.results, report.document);
    for (const line of report.lines) ctx.out.line(line);
    ctx.out.json(report.document);
    ctx.out.verdict(report.pass, report.fields);
    if (report.failure !== undefined) throw report.failure;
  },
});
