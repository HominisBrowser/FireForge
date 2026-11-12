// SPDX-License-Identifier: EUPL-1.2
import { arg, defineCommand, lockOptions, lockWaitMs, opt } from '../cli/command.js';
import type { CommandContext } from '../cli/context.js';
import type { Workspace } from '../engine/index.js';
import {
  componentDiff,
  createComponent,
  type DeploymentResult,
  deploymentStatus,
  type EditResult,
  loadFurnaceConfig,
  overrideComponent,
  removeComponent,
  renameComponent,
  TEST_STYLES,
  typingDrift,
  updateTypingFiles,
  validateComponents,
  validationPasses,
} from '../furnace/index.js';
import { ExitCode, FireForgeError } from '../kernel/errors.js';
import { deployComponents, trackedFiles, withWorkspace } from '../mode/index.js';
import { loadProject, type Project, type TrackedFiles } from '../project/index.js';
import { workspaceOptions } from './workspace.js';

interface FurnaceTarget {
  project: Project;
  /** The writer for engine files the project tracks; a first touch of an upstream file is a registration. */
  tracked: TrackedFiles;
}

async function target(ctx: CommandContext): Promise<FurnaceTarget> {
  const project = await loadProject(ctx.cwd, ctx.env);
  return { project, tracked: await trackedFiles(project, { declare: true }) };
}

/** Runs `body` in the workspace whose engine the components deploy into. */
function inWorkspace<T>(
  project: Project,
  command: string,
  opts: { workspace: string | undefined; waitLock: number | undefined },
  body: (workspace: Workspace) => Promise<T>
): Promise<T> {
  return withWorkspace(
    project,
    { command: `furnace ${command}`, workspace: opts.workspace, waitMs: lockWaitMs(opts.waitLock) },
    body
  );
}

const dryRun = opt.flag('Show what would change without writing');

function reportEdit(ctx: CommandContext, result: EditResult, dry: boolean): void {
  for (const path of result.paths) ctx.out.line(`${dry ? 'would change' : 'changed'} ${path}`);
  for (const note of result.notes) ctx.out.line(`note: ${note}`);
  ctx.out.json({ dryRun: dry, paths: result.paths, notes: result.notes });
}

function reportDeployment(ctx: CommandContext, result: DeploymentResult, dry: boolean): void {
  const touched = result.components.filter((component) => component.status !== 'current');
  for (const component of touched) {
    const verb = component.status === 'removed' ? 'undeploy' : 'deploy';
    ctx.out.line(
      `${dry ? `would ${verb}` : `${verb}ed`} ${component.name}: ${component.reasons.join('; ')}`
    );
  }
  if (!result.changed) ctx.out.line('Components are current.');
  ctx.out.json({ ...result, dryRun: dry });
}

const create = defineCommand({
  name: 'create',
  summary: 'Create a custom component',
  args: { name: arg.string('Tag of the new element, such as moz-my-widget') },
  options: {
    description: opt.string('What the component is', { short: 'd', valueName: 'text' }),
    localized: opt.flag('Give it its own Fluent file'),
    sharedFtl: opt.string('Share this existing feature Fluent file instead (implies --localized)', {
      valueName: 'path',
    }),
    register: opt.flag('List the element in customElements.js', { negatable: true, default: true }),
    compose: opt.list('A component it renders inside its template', { valueName: 'tag' }),
    tests: opt.enum(TEST_STYLES, 'Scaffold a test in this harness'),
    dryRun,
    ...lockOptions,
  },
  json: true,
  run: async (ctx, { name }, opts) => {
    const { project, tracked } = await target(ctx);
    const result = await createComponent(project, tracked, name, {
      ...(opts.description === undefined ? {} : { description: opts.description }),
      localized: opts.localized,
      ...(opts.sharedFtl === undefined ? {} : { sharedFtl: opts.sharedFtl }),
      register: opts.register,
      composes: opts.compose,
      ...(opts.tests === undefined ? {} : { tests: opts.tests }),
      dryRun: opts.dryRun,
      waitMs: lockWaitMs(opts.waitLock),
    });
    reportEdit(ctx, result, opts.dryRun);
  },
});

const apply = defineCommand({
  name: 'apply',
  summary: 'Deploy the components into the engine',
  description:
    'Writes every component file whose engine copy differs, removes what components no longer have, ' +
    'and brings jar.mn and customElements.js in line, in one transaction. Unchanged components cost nothing.',
  options: { dryRun, ...workspaceOptions },
  json: true,
  run: async (ctx, _args, opts) => {
    const { project } = await target(ctx);
    const result = await inWorkspace(project, 'apply', opts, (workspace) =>
      deployComponents(workspace, { dryRun: opts.dryRun, waitMs: lockWaitMs(opts.waitLock) })
    );
    reportDeployment(ctx, result, opts.dryRun);
  },
});

const status = defineCommand({
  name: 'status',
  summary: 'List the components and whether the engine holds them as the project has them',
  options: { ...workspaceOptions },
  json: true,
  run: async (ctx, _args, opts) => {
    const { project } = await target(ctx);
    const result = await inWorkspace(project, 'status', opts, (workspace) =>
      deploymentStatus(project, workspace)
    );
    for (const component of result.components) {
      const why = component.reasons.length === 0 ? '' : `: ${component.reasons.join('; ')}`;
      ctx.out.line(`${component.name} (${component.kind}) ${component.status}${why}`);
    }
    if (result.components.length === 0) ctx.out.line('furnace.json lists no components.');
    ctx.out.json(result);
  },
});

const validate = defineCommand({
  name: 'validate',
  summary: 'Check the components against the accessibility, compatibility and token rules',
  args: { name: arg.string('Judge only this component', { optional: true }) },
  options: {
    maxWarnings: opt.integer('Also fail when more warnings than this remain', { min: 0 }),
    ...workspaceOptions,
  },
  json: true,
  verdict: true,
  run: async (ctx, { name }, opts) => {
    const { project, tracked } = await target(ctx);
    const report = await inWorkspace(project, 'validate', opts, (workspace) =>
      validateComponents(project, tracked, {
        workspace,
        ...(name === undefined ? {} : { component: name }),
      })
    );
    for (const finding of report.findings) {
      ctx.out.line(
        `${finding.severity} ${finding.component} [${finding.check}] ${finding.message}`
      );
    }
    for (const finding of report.excepted) {
      ctx.out.line(`excepted ${finding.component} [${finding.check}] ${finding.reason}`);
    }
    const pass = validationPasses(report, opts.maxWarnings);
    ctx.out.line(
      `${report.judged} component(s): ${report.errors} error(s), ${report.warnings} warning(s)`
    );
    ctx.out.json({ pass, ...report });
    ctx.out.verdict(pass, { errors: report.errors, warnings: report.warnings });
    if (!pass) {
      throw new FireForgeError('furnace-validation-failed', 'Component validation failed.', {
        exitCode: ExitCode.FURNACE_ERROR,
        hint:
          'Fix the findings above. A warning that is reviewed and accepted goes in ' +
          'validationExceptions of furnace.json; an error cannot be excepted.',
      });
    }
  },
});

const types = defineCommand({
  name: 'types',
  summary: 'Write the jsconfig paths and the tag map generated from the components',
  options: {
    check: opt.flag('Write nothing; fail while a generated file is out of date'),
    ...lockOptions,
  },
  json: true,
  run: async (ctx, _args, opts) => {
    const { project, tracked } = await target(ctx);
    if (opts.check) {
      const drift = await typingDrift(project, await loadFurnaceConfig(project), tracked);
      for (const file of drift) ctx.out.line(`${file.file}: ${file.detail}`);
      ctx.out.json({ current: drift.length === 0, drift });
      if (drift.length > 0) {
        throw new FireForgeError(
          'furnace-typing-drift',
          'Generated typing files are out of date.',
          {
            exitCode: ExitCode.FURNACE_ERROR,
            hint: 'Run "fireforge furnace types".',
          }
        );
      }
      return;
    }
    reportEdit(
      ctx,
      await updateTypingFiles(project, tracked, { waitMs: lockWaitMs(opts.waitLock) }),
      false
    );
  },
});

const diff = defineCommand({
  name: 'diff',
  summary:
    'Show how components differ from their deployed copy (custom) or the stock files (override)',
  args: { name: arg.string('Only this component', { optional: true }) },
  options: { ...workspaceOptions },
  run: async (ctx, { name }, opts) => {
    const { project } = await target(ctx);
    ctx.out.write(
      await inWorkspace(project, 'diff', opts, (workspace) =>
        componentDiff(project, workspace, name)
      )
    );
  },
});

const rename = defineCommand({
  name: 'rename',
  summary: 'Rename a component, its files, its tests and every reference to it',
  args: { from: arg.string('Current name'), to: arg.string('New name') },
  options: { dryRun, ...lockOptions },
  json: true,
  run: async (ctx, { from, to }, opts) => {
    const { project, tracked } = await target(ctx);
    const options = { dryRun: opts.dryRun, waitMs: lockWaitMs(opts.waitLock) };
    reportEdit(ctx, await renameComponent(project, tracked, from, to, options), opts.dryRun);
  },
});

const remove = defineCommand({
  name: 'remove',
  summary: 'Remove a component, its tests and its furnace.json entry',
  args: { name: arg.string('The component') },
  options: { dryRun, ...lockOptions },
  json: true,
  run: async (ctx, { name }, opts) => {
    const { project, tracked } = await target(ctx);
    const options = { dryRun: opts.dryRun, waitMs: lockWaitMs(opts.waitLock) };
    reportEdit(ctx, await removeComponent(project, tracked, name, options), opts.dryRun);
  },
});

const override = defineCommand({
  name: 'override',
  summary: 'Start overriding a stock component with a copy in components/overrides/',
  args: { name: arg.string('The stock component, such as moz-button') },
  options: {
    description: opt.string('Why it is overridden', { short: 'd', valueName: 'text' }),
    cssOnly: opt.flag('Copy and deploy only its stylesheets'),
    from: opt.string(
      'Engine directory of the stock component (default toolkit/content/widgets/<name>)',
      { valueName: 'dir' }
    ),
    dryRun,
    ...workspaceOptions,
  },
  json: true,
  run: async (ctx, { name }, opts) => {
    const { project, tracked } = await target(ctx);
    const result = await inWorkspace(project, 'override', opts, (workspace) =>
      overrideComponent(project, tracked, workspace, name, {
        ...(opts.description === undefined ? {} : { description: opts.description }),
        cssOnly: opts.cssOnly,
        ...(opts.from === undefined ? {} : { from: opts.from }),
        dryRun: opts.dryRun,
        waitMs: lockWaitMs(opts.waitLock),
      })
    );
    reportEdit(ctx, result, opts.dryRun);
  },
});

export const furnace = defineCommand({
  name: 'furnace',
  summary: 'Create, deploy and validate UI components',
  group: 'Components',
  subcommands: [create, apply, status, validate, types, diff, rename, remove, override],
});
