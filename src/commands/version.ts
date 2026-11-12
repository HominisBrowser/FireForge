// SPDX-License-Identifier: EUPL-1.2
import { defineCommand } from '../cli/command.js';
import { cliVersion, packageVersion } from '../cli/version.js';

export const version = defineCommand({
  name: 'version',
  summary: 'Print the FireForge version and build identity',
  group: 'Diagnostics',
  json: true,
  run: async (ctx) => {
    const build = await cliVersion();
    ctx.out.line(build);
    ctx.out.json({ version: await packageVersion(), build, node: process.version });
  },
});
