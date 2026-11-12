// SPDX-License-Identifier: EUPL-1.2
import { arg, defineCommand, lockOptions, lockWaitMs, opt } from '../cli/command.js';
import { markerComment } from '../config/index.js';
import { editTracked, enginePathOf, trackedFiles } from '../mode/index.js';
import { loadProject } from '../project/index.js';
import { applyEdits, planWire } from '../register/index.js';

export const wire = defineCommand({
  name: 'wire',
  summary: 'Wire a chrome subscript into the browser',
  description:
    'Loads <name>.js from browser-main.js, optionally calls init from onLoad and destroy from ' +
    'onUnload in browser-init.js, optionally #includes a DOM fragment into the top-level chrome ' +
    'document, and registers the script in browser/base/jar.mn. Every edit is planned before ' +
    'any is written. Where scripts live and the chrome document are the wire.subscriptDir and ' +
    'wire.domTarget keys of fireforge.json.',
  group: 'Authoring',
  args: { name: arg.string('Subscript name, without .js') },
  options: {
    init: opt.string('Expression called from onLoad, such as Feature.init', {
      valueName: 'expression',
    }),
    destroy: opt.string('Expression called from onUnload, such as Feature.destroy', {
      valueName: 'expression',
    }),
    dom: opt.string('DOM fragment (.inc.xhtml) to #include into the chrome document', {
      valueName: 'path',
    }),
    after: opt.string('Subscript whose init block the new init block follows', {
      valueName: 'name',
    }),
    dryRun: opt.flag('Show the planned edits without writing'),
    ...lockOptions,
  },
  json: true,
  run: async (ctx, { name }, opts) => {
    const project = await loadProject(ctx.cwd, ctx.env);
    const { config } = project;
    const files = await trackedFiles(project, { declare: true });
    const plan = await planWire(files, {
      name,
      subscriptDir: config.wire.subscriptDir,
      marker: `${markerComment(config)}:`,
      requireSubscript: !opts.dryRun,
      init: opts.init,
      destroy: opts.destroy,
      after: opts.after,
      dom:
        opts.dom === undefined
          ? undefined
          : { file: enginePathOf(project, opts.dom), target: config.wire.domTarget },
    });
    if (!opts.dryRun) {
      await editTracked(
        project,
        { label: `wiring ${name}`, command: 'wire', waitMs: lockWaitMs(opts.waitLock) },
        (tx) => applyEdits(tx, files, plan.edits)
      );
    }

    const verb = opts.dryRun ? 'Would change' : 'Changed';
    for (const step of plan.steps) {
      ctx.out.line(
        step.present
          ? `Already in place: ${step.path}: ${step.change}`
          : `${verb} ${step.path}: ${step.change}`
      );
    }
    ctx.out.json({ name, dryRun: opts.dryRun, steps: plan.steps.map((step) => ({ ...step })) });
  },
});
