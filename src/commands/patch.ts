// SPDX-License-Identifier: EUPL-1.2
import { arg, defineCommand, lockOptions, lockWaitMs, opt } from '../cli/command.js';
import type { CommandContext } from '../cli/context.js';
import { withEngineLock } from '../engine/index.js';
import { defined } from '../kernel/errors.js';
import type { JsonObject } from '../kernel/json.js';
import { loadProject, type PatchProject } from '../project/index.js';
import {
  compactQueue,
  deletePatch,
  enginePaths,
  moveFiles,
  type Placement,
  type QueueEdit,
  renamePatch,
  reorderPatch,
  requirePatchMode,
  retirePatch,
  setPatchMeta,
  splitPatch,
  stagedDependencyOf,
} from '../queue/index.js';

/** Loads the patch-mode project and runs `body` under the exclusive engine lock. */
async function locked<T>(
  ctx: CommandContext,
  command: string,
  waitLock: number | undefined,
  body: (project: PatchProject) => Promise<T>
): Promise<T> {
  const project = requirePatchMode(await loadProject(ctx.cwd, ctx.env));
  return withEngineLock(
    project,
    { command: `patch ${command}`, waitMs: lockWaitMs(waitLock) },
    () => body(project)
  );
}

function report(ctx: CommandContext, edit: QueueEdit, extra: JsonObject = {}): void {
  for (const { from, to } of edit.renamed) ctx.out.line(`Renamed ${from} -> ${to}`);
  for (const filename of edit.created) ctx.out.line(`Created ${filename}`);
  for (const filename of edit.rewritten) ctx.out.line(`Rewrote ${filename}`);
  for (const filename of edit.removed) ctx.out.line(`Removed ${filename}`);
  const changed = edit.renamed.length + edit.created.length + edit.removed.length;
  if (changed + edit.rewritten.length === 0) ctx.out.line('Nothing changed.');
  ctx.out.json({
    renamed: edit.renamed.map(({ from, to }) => ({ from, to })),
    created: [...edit.created],
    rewritten: [...edit.rewritten],
    removed: [...edit.removed],
    ...extra,
  });
}

const placementOptions = {
  order: opt.integer('Place the patch at this order', { min: 1 }),
  before: opt.string('Place the patch right before this patch', { valueName: 'patch' }),
  after: opt.string('Place the patch right after this patch', { valueName: 'patch' }),
};

function placementOf(opts: {
  order: number | undefined;
  before: string | undefined;
  after: string | undefined;
}): Placement | undefined {
  if (opts.order !== undefined) return { order: opts.order };
  if (opts.before !== undefined) return { before: opts.before };
  if (opts.after !== undefined) return { after: opts.after };
  return undefined;
}

const rename = defineCommand({
  name: 'rename',
  summary: 'Rename a patch',
  description: 'The order, body and metadata stay; the file follows the name.',
  args: {
    patch: arg.string('The patch (order, filename or name)'),
    name: arg.string('The new name: lowercase words joined by hyphens, the first the category'),
  },
  options: { ...lockOptions },
  json: true,
  run: async (ctx, { patch, name }, opts) => {
    report(
      ctx,
      await locked(ctx, 'rename', opts.waitLock, (project) => renamePatch(project, patch, name))
    );
  },
});

const reorder = defineCommand({
  name: 'reorder',
  summary: 'Move a patch to another place in the apply order',
  description:
    'An occupied order is freed by moving the run of patches above it up by one. Refused when ' +
    'the queue would then produce different content: patches that change the same lines keep ' +
    'their relative order.',
  args: { patch: arg.string('The patch (order, filename or name)') },
  options: { ...placementOptions, ...lockOptions },
  constraints: { oneOf: [['order', 'before', 'after']] },
  json: true,
  run: async (ctx, { patch }, opts) => {
    const placement = defined(placementOf(opts), 'reorder is given exactly one placement');
    report(
      ctx,
      await locked(ctx, 'reorder', opts.waitLock, (project) =>
        reorderPatch(project, patch, placement)
      )
    );
  },
});

const split = defineCommand({
  name: 'split',
  summary: 'Move some files of a patch into a new patch',
  description:
    'The new patch goes right after the source unless placed elsewhere, and keeps its stamp and ' +
    'tier. Staged dependencies declared on the moved files go with them. Refused when the queue ' +
    'would then produce different content.',
  args: {
    patch: arg.string('The patch to split'),
    files: arg.list('Engine files (or directories) of the patch to move', { required: true }),
  },
  options: {
    name: opt.string('Name of the new patch', { required: true, valueName: 'name' }),
    description: opt.string('What the new patch does', { short: 'd', valueName: 'text' }),
    ...placementOptions,
    ...lockOptions,
  },
  constraints: { exclusive: [['order', 'before', 'after']] },
  json: true,
  run: async (ctx, { patch, files }, opts) => {
    const placement = placementOf(opts);
    const edit = await locked(ctx, 'split', opts.waitLock, (project) =>
      splitPatch(project, patch, {
        files: enginePaths(project.paths.engine, ctx.cwd, files),
        name: opts.name,
        ...(opts.description === undefined ? {} : { description: opts.description }),
        ...(placement === undefined ? {} : { placement }),
      })
    );
    report(ctx, edit);
  },
});

const moveFilesCommand = defineCommand({
  name: 'move-files',
  summary: 'Move files from one patch into another',
  description:
    'Where the target already changes a moved file, the two changes are combined. A source left ' +
    'with no files is removed. Refused when the queue would then produce different content.',
  args: {
    from: arg.string('The patch the files leave'),
    to: arg.string('The patch they join'),
    files: arg.list('Engine files (or directories) to move', { required: true }),
  },
  options: { ...lockOptions },
  json: true,
  run: async (ctx, { from, to, files }, opts) => {
    const edit = await locked(ctx, 'move-files', opts.waitLock, (project) =>
      moveFiles(project, from, to, enginePaths(project.paths.engine, ctx.cwd, files))
    );
    report(ctx, edit);
  },
});

const remove = defineCommand({
  name: 'delete',
  summary: 'Delete a patch',
  description:
    'Refused when another patch no longer applies without it. engine/ is not touched: the ' +
    'files the patch changed keep their content and belong to no patch ("fireforge discard" ' +
    'puts them back).',
  args: { patch: arg.string('The patch (order, filename or name)') },
  options: { ...lockOptions },
  json: true,
  run: async (ctx, { patch }, opts) => {
    const removal = await locked(ctx, 'delete', opts.waitLock, (project) =>
      deletePatch(project, patch)
    );
    report(ctx, removal, { files: [...removal.files] });
  },
});

const retire = defineCommand({
  name: 'retire',
  summary: 'Delete a patch and keep its order as a retired slot',
  description:
    'Like "patch delete", but the order stays recorded in patches.json, so it is not given to ' +
    'another patch and the gap check sees no gap.',
  args: { patch: arg.string('The patch (order, filename or name)') },
  options: {
    reason: opt.string('Why, recorded with the slot', { valueName: 'text' }),
    ...lockOptions,
  },
  json: true,
  run: async (ctx, { patch }, opts) => {
    const removal = await locked(ctx, 'retire', opts.waitLock, (project) =>
      retirePatch(project, patch, opts.reason)
    );
    report(ctx, removal, { files: [...removal.files] });
  },
});

const compact = defineCommand({
  name: 'compact',
  summary: 'Close the gaps in the queue numbering',
  description:
    'Keeps the apply order. With patchPolicy ranges, each category range is numbered from its ' +
    'first patch; otherwise the queue is numbered from 1.',
  options: { ...lockOptions },
  json: true,
  run: async (ctx, _args, opts) => {
    report(ctx, await locked(ctx, 'compact', opts.waitLock, (project) => compactQueue(project)));
  },
});

const set = defineCommand({
  name: 'set',
  summary: "Edit a patch's metadata",
  description:
    'Description, tier, lint waivers and staged dependencies, in one transaction; the body is ' +
    'not touched. A waiver for a rule replaces any waiver the patch has for it; with --max ' +
    '(and --reason) it waives a size rule only up to that measurement. A staged dependency ' +
    '<file>:<creates> declares that <file> in this patch imports or registers <creates>, which ' +
    'a later patch creates.',
  args: { patch: arg.string('The patch (order, filename or name)') },
  options: {
    description: opt.string('What the patch does', { short: 'd', valueName: 'text' }),
    tier: opt.enum(['branding', 'none'], 'Size tier the patch is held to'),
    lintIgnore: opt.list('Waive this lint rule for the patch', { valueName: 'rule' }),
    max: opt.integer('Waive the --lint-ignore size rules only up to this measurement', {
      min: 0,
    }),
    reason: opt.string('Why, for the waivers and staged dependencies added', {
      valueName: 'text',
    }),
    removeLintIgnore: opt.list('Drop the waiver of this rule', { valueName: 'rule' }),
    stagedDependency: opt.list('Declare a staged dependency', { valueName: 'file:creates' }),
    removeStagedDependency: opt.list('Drop a staged dependency', { valueName: 'file:creates' }),
    ...lockOptions,
  },
  constraints: { requires: { max: ['lintIgnore', 'reason'] } },
  json: true,
  run: async (ctx, { patch }, opts) => {
    const reason = opts.reason === undefined ? {} : { reason: opts.reason };
    const result = await locked(ctx, 'set', opts.waitLock, (project) =>
      setPatchMeta(project, patch, {
        ...(opts.description === undefined ? {} : { description: opts.description }),
        ...(opts.tier === undefined ? {} : { tier: opts.tier === 'none' ? null : opts.tier }),
        lintIgnore: {
          add: opts.lintIgnore.map((rule) =>
            opts.max === undefined ? rule : { rule, max: opts.max, reason: opts.reason ?? '' }
          ),
          remove: opts.removeLintIgnore,
        },
        stagedDependencies: {
          add: opts.stagedDependency.map((spec) => ({ ...stagedDependencyOf(spec), ...reason })),
          remove: opts.removeStagedDependency.map(stagedDependencyOf),
        },
      })
    );
    ctx.out.line(result.changed ? `Updated ${result.patch}` : `${result.patch} already says so.`);
    const { entry } = result;
    ctx.out.json({
      patch: result.patch,
      changed: result.changed,
      description: entry.description,
      tier: entry.tier ?? null,
      lintIgnore: (entry.lintIgnore ?? []).map((waiver) =>
        typeof waiver === 'string'
          ? waiver
          : { rule: waiver.rule, max: waiver.max, reason: waiver.reason }
      ),
      stagedDependencies: (entry.stagedDependencies ?? []).map((declared) => ({ ...declared })),
    });
  },
});

export const patch = defineCommand({
  name: 'patch',
  summary: 'Rename, reorder, split, delete and annotate patches, and move files between them',
  group: 'Patches',
  subcommands: [rename, reorder, split, moveFilesCommand, remove, retire, compact, set],
});
