// SPDX-License-Identifier: EUPL-1.2
import { arg, defineCommand, lockOptions, lockWaitMs, opt } from '../cli/command.js';
import { editTracked, enginePathOf, trackedFiles } from '../mode/index.js';
import { loadProject } from '../project/index.js';
import { applyEdits, planRegister } from '../register/index.js';

export const register = defineCommand({
  name: 'register',
  summary: 'Register an engine file in the build manifest it belongs in',
  description:
    'The manifest follows from the path: jar.mn for chrome content, skin and widget files, ' +
    'the directory moz.build for JS modules, the moz.build above a test manifest for the ' +
    'manifest, and the directory test manifest for a test file. A file that is already registered is left alone. In source mode the ' +
    'first edit of an upstream manifest declares its override as a registration.',
  group: 'Authoring',
  args: { path: arg.string('Engine file, such as browser/base/content/panel.js') },
  options: {
    dryRun: opt.flag('Show the planned edit without writing'),
    after: opt.string('Place the entry after this one (jar.mn and test manifests only)', {
      valueName: 'entry',
    }),
    createManifest: opt.flag(
      'Create a missing moz.build or test manifest and wire it into its parents'
    ),
    ...lockOptions,
  },
  json: true,
  run: async (ctx, { path }, opts) => {
    const project = await loadProject(ctx.cwd, ctx.env);
    const files = await trackedFiles(project, { declare: true });
    const enginePath = enginePathOf(project, path);
    const plan = await planRegister(files, {
      path: enginePath,
      moduleDir: `browser/modules/${project.config.binaryName}`,
      license: project.config.license,
      mustExist: !opts.dryRun,
      ...(opts.after === undefined ? {} : { after: opts.after }),
      ...(opts.createManifest ? { createManifest: true } : {}),
    });
    const changes = plan.edits.length > 0;
    if (changes && !opts.dryRun) {
      await editTracked(
        project,
        {
          label: `registering ${enginePath}`,
          command: 'register',
          waitMs: lockWaitMs(opts.waitLock),
        },
        (tx) => applyEdits(tx, files, plan.edits)
      );
    }

    const verb = !changes ? 'Already registered' : opts.dryRun ? 'Would register' : 'Registered';
    ctx.out.line(`${verb} ${enginePath} in ${plan.manifest}`);
    if (changes) {
      ctx.out.line(`  entry: ${plan.entry}`);
      for (const step of plan.steps.slice(1)) ctx.out.line(`  also: ${step.path}: ${step.change}`);
      if (plan.previous !== undefined) ctx.out.line(`  after: ${plan.previous}`);
      if (plan.afterFallback === true) {
        ctx.out.line('  --after named no entry, so the entry went in sort order');
      }
    }
    ctx.out.json({
      path: enginePath,
      manifest: plan.manifest,
      entry: plan.entry,
      changed: changes,
      dryRun: opts.dryRun,
      steps: plan.steps.map((step) => ({ ...step })),
    });
  },
});
