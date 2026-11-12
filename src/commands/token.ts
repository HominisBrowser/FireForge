// SPDX-License-Identifier: EUPL-1.2
import { arg, defineCommand, lockOptions, lockWaitMs, opt } from '../cli/command.js';
import type { CommandContext } from '../cli/context.js';
import { loadFurnaceConfig } from '../furnace/index.js';
import { FireForgeError } from '../kernel/errors.js';
import { exists } from '../kernel/fs.js';
import {
  editTracked,
  type OwnedFiles,
  ownedFiles,
  trackedFiles,
  withOwnedRead,
} from '../mode/index.js';
import { loadProject, type Project, type TrackedFiles } from '../project/index.js';
import {
  addToken,
  lintTokens,
  listTokens,
  measureCoverage,
  readTokenFile,
  TOKEN_MODES,
  tokenName,
  type TokenSettings,
  tokenSettings,
  tokenValues,
} from '../tokens/index.js';

/** The project's token file and conventions. */
interface TokenTarget {
  project: Project;
  files: TrackedFiles;
  /** Engine path of the token file. */
  path: string;
  settings: TokenSettings;
}

async function target(ctx: CommandContext): Promise<TokenTarget> {
  const project = await loadProject(ctx.cwd, ctx.env);
  const furnace = (await exists(project.paths.furnace))
    ? await loadFurnaceConfig(project)
    : undefined;
  const settings = tokenSettings(furnace, project.config.binaryName);
  return { project, files: await trackedFiles(project), path: settings.file, settings };
}

/** Runs `judge` over the files the project owns, held still for the duration. */
function withOwnedFiles<T>(
  { project }: TokenTarget,
  wait: { command: string; waitLock: number | undefined },
  judge: (owned: OwnedFiles) => Promise<T>
): Promise<T> {
  const options = { command: wait.command, waitMs: lockWaitMs(wait.waitLock) };
  return withOwnedRead(project, options, async () => judge(await ownedFiles(project)));
}

const add = defineCommand({
  name: 'add',
  summary: 'Add a design token to the token file',
  description:
    'Names start with "--", which the parser reads as a flag: put "--" before them, as in ' +
    '`token add --category Spacing --mode static -- --brand-gap 8px`. A bare name takes the ' +
    'project token prefix.',
  args: {
    name: arg.string('Token name, such as --brand-gap or gap'),
    value: arg.string('CSS value'),
  },
  options: {
    category: opt.string('Category banner to add the token under', { valueName: 'name' }),
    mode: opt.enum(
      TOKEN_MODES,
      'Dark mode: auto follows the platform, static never changes, override has its own dark value',
      {
        required: true,
      }
    ),
    darkValue: opt.string('Dark value (override only)', { valueName: 'value' }),
    description: opt.string('Comment written above the declaration', {
      short: 'd',
      valueName: 'text',
    }),
    variant: opt.string('Add to the :root<selector> block, such as [data-skin=precision]', {
      valueName: 'selector',
    }),
    createCategory: opt.flag('Declare the category banner when the file has none by that name'),
    dryRun: opt.flag('Show what would change without writing'),
    ...lockOptions,
  },
  json: true,
  run: async (ctx, { name, value }, opts) => {
    const { project, files, path, settings } = await target(ctx);
    const text = await readTokenFile(files, path);
    const full = tokenName(name, settings.prefix);
    const result = addToken(text, {
      name: full,
      value,
      mode: opts.mode,
      category: opts.category,
      description: opts.description,
      darkValue: opts.darkValue,
      variant: opts.variant,
      createCategory: opts.createCategory,
    });
    if (result.changed && !opts.dryRun) {
      await editTracked(
        project,
        { label: `adding token ${full}`, command: 'token add', waitMs: lockWaitMs(opts.waitLock) },
        (tx) => files.write(tx, path, result.text)
      );
    }
    const where =
      result.existing === undefined
        ? ''
        : ` in ${result.existing.where} (line ${result.existing.line})`;
    if (!result.changed) ctx.out.line(`${full} already declared${where}; unchanged`);
    else ctx.out.line(`${opts.dryRun ? 'Would add' : 'Added'} ${full} to ${path}`);
    if (result.categoryCreated) ctx.out.line(`  declared category "${opts.category ?? ''}"`);
    for (const selector of result.mirrored) ctx.out.line(`  also written to ${selector}`);
    for (const note of result.notes) ctx.out.line(`  ${note}`);
    ctx.out.json({
      token: full,
      file: path,
      changed: result.changed,
      dryRun: opts.dryRun,
      categoryCreated: result.categoryCreated,
      mirrored: result.mirrored,
    });
  },
});

const list = defineCommand({
  name: 'list',
  summary: 'List the token categories and their tokens',
  options: { category: opt.string('Only this category', { valueName: 'name' }) },
  json: true,
  run: async (ctx, _args, opts) => {
    const { files, path } = await target(ctx);
    const text = await readTokenFile(files, path);
    const groups = listTokens(text).filter(
      (group) => opts.category === undefined || group.category === opts.category
    );
    if (opts.category !== undefined && groups.length === 0) {
      const known = listTokens(text).flatMap((group) =>
        group.category === null ? [] : [`"${group.category}"`]
      );
      throw new FireForgeError('token-category-missing', `Category "${opts.category}" not found.`, {
        hint: known.length > 0 ? `Categories: ${known.join(', ')}.` : 'The file has no categories.',
      });
    }
    for (const group of groups) {
      ctx.out.line(`${group.category ?? '(no category)'} (${group.tokens.length})`);
      for (const token of group.tokens) ctx.out.line(`  ${token.name}`);
    }
    ctx.out.json({
      categories: groups.map((group) => ({
        category: group.category,
        tokens: group.tokens.map((token) => ({ ...token })),
      })),
    });
  },
});

const show = defineCommand({
  name: 'show',
  summary: 'Show every value a token takes and where it is declared',
  args: { name: arg.string('Token name, such as --brand-gap') },
  json: true,
  run: async (ctx, { name }) => {
    const { files, path, settings } = await target(ctx);
    const full = tokenName(name, settings.prefix);
    const text = await readTokenFile(files, path);
    const values = tokenValues(text, full);
    if (values.length === 0) {
      throw new FireForgeError('token-missing', `${full} is not declared in the token file.`, {
        hint: '"fireforge token list" shows the declared tokens; "fireforge token add" declares one.',
      });
    }
    for (const entry of values)
      ctx.out.line(`${entry.value}  (${entry.block}, line ${entry.line})`);
    ctx.out.json({ token: full, values: values.map((entry) => ({ ...entry })) });
  },
});

const lint = defineCommand({
  name: 'lint',
  summary: 'Check themed blocks against the base block and token references against declarations',
  options: { ...lockOptions },
  json: true,
  run: async (ctx, _args, opts) => {
    const tokens = await target(ctx);
    const { filesScanned, findings } = await withOwnedFiles(
      tokens,
      { command: 'token lint', waitLock: opts.waitLock },
      (owned) => lintTokens(tokens.path, owned, tokens.settings)
    );
    for (const finding of findings) {
      ctx.out.line(`${finding.file}:${finding.line} [${finding.check}] ${finding.message}`);
    }
    ctx.out.line(`${filesScanned} stylesheet(s) scanned`);
    ctx.out.json({ filesScanned, findings: findings.map((finding) => ({ ...finding })) });
    if (findings.length > 0) {
      throw new FireForgeError(
        'token-lint-failed',
        `Token lint found ${findings.length} finding(s).`,
        {
          hint: 'Fix each finding as its message says; "fireforge token add" declares a missing token.',
        }
      );
    }
  },
});

const coverage = defineCommand({
  name: 'coverage',
  summary: 'Measure how much of the owned stylesheets uses project tokens',
  options: {
    min: opt.integer('Fail when coverage is below this percentage', {
      min: 0,
      max: 100,
      valueName: 'percent',
    }),
    ...lockOptions,
  },
  json: true,
  run: async (ctx, _args, opts) => {
    const tokens = await target(ctx);
    const report = await withOwnedFiles(
      tokens,
      { command: 'token coverage', waitLock: opts.waitLock },
      (owned) => measureCoverage(tokens.path, owned, tokens.settings)
    );
    for (const file of report.files) {
      ctx.out.line(
        `${file.file}  tokens ${file.tokenUsages} | allowlisted ${file.allowlisted} | unknown ${file.unknownVars} | raw colors ${file.rawColors}`
      );
    }
    for (const name of report.foreignDeclarations) {
      ctx.out.line(`token file declares ${name}, which is outside the project prefix`);
    }
    ctx.out.line(
      `Token coverage ${report.percent}%: ${report.tokenUsages} tokens, ${report.rawColors} raw colors, ${report.unknownVars} unknown variables in ${report.files.length} stylesheet(s)`
    );
    ctx.out.json({ ...report, files: report.files.map((file) => ({ ...file })) });
    if (opts.min !== undefined && report.percent < opts.min) {
      throw new FireForgeError(
        'token-coverage-low',
        `Token coverage ${report.percent}% is below ${opts.min}%.`,
        {
          hint: 'Replace the raw colors and unknown variables listed above with project tokens.',
        }
      );
    }
  },
});

export const token = defineCommand({
  name: 'token',
  summary: 'Design tokens: add, list, show, lint, coverage',
  group: 'Authoring',
  subcommands: [add, list, show, lint, coverage],
});
