// SPDX-License-Identifier: EUPL-1.2
import { arg, defineCommand, opt } from '../cli/command.js';
import { pinnedPristine } from '../mode/index.js';
import { loadProject } from '../project/index.js';
import { override as declareOverride, requireSourceMode } from '../source/index.js';

export const override = defineCommand({
  name: 'override',
  summary: 'Declare the first touch of an upstream file',
  description:
    'Writes the override record holding the upstream identity and, unless --delete, seeds the ' +
    'owned copy under the source root (src/<path> by default; source.root in fireforge.json) ' +
    'with the pristine bytes to edit. An existing undeclared edit is refused: move it aside, ' +
    "declare, then reapply it. The first override also configures FireForge's merge driver in " +
    "the repository's git config.",
  group: 'Source',
  args: { path: arg.string('Engine path of the upstream file, such as browser/base/jar.mn') },
  options: {
    delete: opt.flag('Delete the upstream file instead of editing it'),
    component: opt.string('Component the change belongs to (default: the top directory)', {
      valueName: 'name',
    }),
    classification: opt.enum(
      ['registration', 'exception'],
      'registration wires an addition in; exception is a reviewed upstream change',
      { default: 'registration' }
    ),
    adr: opt.string('Decision record approving an exception, relative to the project', {
      valueName: 'path',
    }),
  },
  json: true,
  run: async (ctx, { path }, opts) => {
    const project = requireSourceMode(await loadProject(ctx.cwd, ctx.env));
    const { record, driverInstalled } = await declareOverride(
      project,
      await pinnedPristine(project),
      path,
      {
        delete: opts.delete,
        classification: opts.classification,
        ...(opts.component === undefined ? {} : { component: opts.component }),
        ...(opts.adr === undefined ? {} : { adr: opts.adr }),
      }
    );
    ctx.out.line(
      record.kind === 'delete'
        ? `Declared the deletion of ${path} (component ${record.component}).`
        : `Declared ${path} (component ${record.component}); edit ${project.config.source.root}/${path}.`
    );
    if (driverInstalled) {
      ctx.out.line(
        'Configured the merge driver (merge.fireforge.driver) in git config, so merges of owned files start from the pristine file.'
      );
    }
    ctx.out.json({ path, record, driverInstalled });
  },
});
