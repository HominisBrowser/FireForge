// SPDX-License-Identifier: EUPL-1.2
import { defineCommand, kebabCase, opt, usageError } from '../cli/command.js';
import type { CommandContext } from '../cli/context.js';
import {
  DEFAULT_LICENSE,
  FIREFOX_PRODUCTS,
  inferFirefoxProduct,
  PROJECT_LICENSES,
  PROJECT_MODES,
} from '../config/index.js';
import { step } from '../kernel/log.js';
import { ask, choose } from '../kernel/tty.js';
import { createProject, type ProjectSpec, refuseExistingProject } from '../mode/index.js';

/** The answers that have no default, with the question asked for each. */
const QUESTIONS = {
  name: 'What is the name of your browser?',
  vendor: 'What is your vendor or company name?',
  firefoxVersion: 'Firefox version to build on (such as 140.9.0esr)',
} as const;

/** The value of an option, or the answer to its question when a terminal is attached. */
async function required(
  ctx: CommandContext,
  key: keyof typeof QUESTIONS,
  given: string | undefined
): Promise<string> {
  if (given !== undefined) return given;
  if (!ctx.interactive) {
    throw usageError(
      `--${kebabCase(key)} is required.`,
      'Without a terminal, pass --name, --vendor and --firefox-version.'
    );
  }
  return ask(QUESTIONS[key], {
    validate: (answer) => (answer === '' ? 'An answer is required' : undefined),
  });
}

export const setup = defineCommand({
  name: 'setup',
  summary: 'Create a FireForge project in this directory',
  description:
    'Writes fireforge.json, the mozconfig templates in configs/, the license text and the ' +
    'ignore rules. Values not given as options are asked for on a terminal. A source-mode ' +
    'project pins the pristine commit of its Firefox, so creating one downloads that Firefox ' +
    'when this host does not have it yet. A directory that already holds fireforge.json is ' +
    'refused; change an existing project with "fireforge config set".',
  group: 'Project',
  options: {
    name: opt.string('Display name of the browser', { valueName: 'name' }),
    vendor: opt.string('Vendor or company name', { valueName: 'name' }),
    appId: opt.string('Application ID (default org.<name>.browser)', { valueName: 'id' }),
    binaryName: opt.string('Executable name (default: the name in lowercase)', {
      valueName: 'name',
    }),
    firefoxVersion: opt.string('Firefox version to build on', { valueName: 'version' }),
    product: opt.enum(FIREFOX_PRODUCTS, "Mozilla product (default: by the version's shape)"),
    license: opt.enum(PROJECT_LICENSES, `Project license (default ${DEFAULT_LICENSE})`),
    mode: opt.enum(
      PROJECT_MODES,
      'Where owned changes live: a patch queue, or tracked files under src/ (default patches)'
    ),
  },
  json: true,
  run: async (ctx, _args, opts) => {
    await refuseExistingProject(ctx.cwd);
    const name = await required(ctx, 'name', opts.name);
    const vendor = await required(ctx, 'vendor', opts.vendor);
    const firefoxVersion = await required(ctx, 'firefoxVersion', opts.firefoxVersion);
    const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const prompted = ctx.interactive && opts.name === undefined;
    const spec: ProjectSpec = {
      name,
      vendor,
      firefoxVersion,
      appId: opts.appId ?? `org.${slug}.browser`,
      binaryName: opts.binaryName ?? slug,
      product: opts.product ?? inferFirefoxProduct(firefoxVersion),
      license:
        opts.license ??
        (prompted
          ? await choose(
              'Project license',
              PROJECT_LICENSES.map((value) => ({ value, label: value })),
              DEFAULT_LICENSE
            )
          : DEFAULT_LICENSE),
      mode:
        opts.mode ??
        (prompted
          ? await choose('Where do the owned changes live?', [
              { value: 'patches', label: 'A patch queue over engine/ (patches)' },
              { value: 'source', label: 'Tracked files under src/ (source)' },
            ])
          : 'patches'),
    };
    const written = await createProject(ctx.cwd, spec, {
      env: ctx.env,
      onProgress: step,
    });
    for (const file of written) ctx.out.line(`wrote ${file}`);
    ctx.out.line(
      `Created ${spec.name} (${spec.mode} mode). Next: fireforge download, fireforge bootstrap, fireforge build, fireforge run.`
    );
    ctx.out.json({ ...spec, files: written });
  },
});
