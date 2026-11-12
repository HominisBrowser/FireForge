// SPDX-License-Identifier: EUPL-1.2
import { dirname, resolve } from 'node:path';

import { arg, defineCommand } from '../cli/command.js';
import { FireForgeError } from '../kernel/errors.js';
import { warn } from '../kernel/log.js';
import { pinnedPristine } from '../mode/index.js';
import { loadProject } from '../project/index.js';
import { installMergeDriver, requireSourceMode, runMergeDriver } from '../source/index.js';

const run = defineCommand({
  name: 'run',
  summary: 'Merge one owned file (git runs this)',
  hidden: true,
  args: {
    base: arg.path('%O: the ancestor version'),
    ours: arg.path('%A: our version, which receives the result'),
    theirs: arg.path('%B: their version'),
    path: arg.string('%P: the path being merged'),
    label: arg.string('%S: the ancestor label', { optional: true }),
  },
  run: async (ctx, args) => {
    const project = requireSourceMode(
      await loadProject(dirname(resolve(ctx.cwd, args.path)), ctx.env)
    );
    const clean = await runMergeDriver(project, () => pinnedPristine(project), {
      base: args.base,
      ours: args.ours,
      theirs: args.theirs,
      path: args.path,
      ...(args.label === undefined ? {} : { label: args.label }),
    });
    if (!clean) {
      throw new FireForgeError('merge-conflict', `Conflicts left in ${args.path}.`, {
        hint: 'Resolve the conflict markers in the file, then "git add" it.',
      });
    }
  },
});

const install = defineCommand({
  name: 'install',
  summary: 'Configure the merge driver in this repository',
  json: true,
  run: async (ctx) => {
    const project = requireSourceMode(await loadProject(ctx.cwd, ctx.env));
    const installed = await installMergeDriver(project);
    if (!installed.labelSupported) {
      warn(
        'This git does not pass the ancestor label to merge drivers (Git 2.44 or later does); ' +
          'first touches of one upstream file will conflict as git reports them.'
      );
    }
    ctx.out.line(`merge.fireforge.driver = ${installed.driver}`);
    ctx.out.json({ ...installed });
  },
});

export const mergeDriver = defineCommand({
  name: 'merge-driver',
  summary: 'Git merge driver that merges first touches of upstream files against pristine',
  group: 'Source',
  subcommands: [install, run],
});
