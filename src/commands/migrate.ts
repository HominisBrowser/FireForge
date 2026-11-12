// SPDX-License-Identifier: EUPL-1.2
import { defineCommand, opt } from '../cli/command.js';
import { step } from '../kernel/log.js';
import { migrate as toSourceMode, upgrade, verifyOutcome } from '../mode/index.js';
import { loadProject } from '../project/index.js';

export const migrate = defineCommand({
  name: 'migrate',
  summary: 'Upgrade a project of the previous format, or convert a patch queue to source mode',
  description:
    'Without options: brings a project written by the previous FireForge to the current format, ' +
    'in place: fireforge.json keys, override records, waivers, the merge driver, and files ' +
    'nothing reads any more. Everything rewritten or dropped is listed; anything that needs a ' +
    'decision stops the upgrade before a file is written. A project already current is left ' +
    'alone. It ends by running verify.\n\n' +
    '--to-source converts a patch-mode project to source mode: the queue is replayed onto the ' +
    'pinned Firefox and written as owned files under src/ with an override record per changed ' +
    'upstream file (component: the patch), and the result is proven to reproduce the tree the ' +
    'queue replays to.\n\n' +
    'Both need a committed tree: git is the undo.',
  group: 'Project',
  options: {
    toSource: opt.flag('Convert a patch-mode project to source mode'),
  },
  json: true,
  run: async (ctx, _args, opts) => {
    if (opts.toSource) {
      const result = await toSourceMode(await loadProject(ctx.cwd, ctx.env));
      ctx.out.line(
        `${result.created.length} created, ${result.overridden.length} overridden and ` +
          `${result.deleted.length} deleted upstream file(s) are now owned files under src/.`
      );
      ctx.out.line('engine/ is no longer used and can be removed. Review and commit the result.');
      ctx.out.json({ ...result });
      return;
    }
    const result = await upgrade(ctx.cwd, ctx.env, { onProgress: step });
    if (result.state === 'current') {
      ctx.out.line('The project is in the current format; nothing was changed.');
    } else {
      const list = (title: string, notes: readonly { key: string; message: string }[]): void => {
        if (notes.length === 0) return;
        ctx.out.line(`${title}:`);
        for (const note of notes) ctx.out.line(`  ${note.key}: ${note.message}`);
      };
      list('Converted', result.converted);
      list('Removed', result.removed);
      list('For you to check or decide', result.manual);
      if (result.deleted.length > 0) {
        ctx.out.line(`Deleted files: ${result.deleted.join(', ')}`);
      }
      ctx.out.line(
        `${result.rewritten.length} file(s) rewritten, ${result.deleted.length} deleted.`
      );
      for (const line of result.followUp) ctx.out.line(`Left for you: ${line}`);
      ctx.out.line('Review the result with "git diff" and commit it; "git checkout ." undoes it.');
    }
    for (const problem of result.verify.problems) {
      const subject = problem.subject === undefined ? '' : `${problem.subject}: `;
      ctx.out.line(`${problem.code}  ${subject}${problem.message}`);
      if (problem.hint !== undefined) ctx.out.line(`  ${problem.hint}`);
    }
    const outcome = verifyOutcome(result.verify);
    if ('sound' in outcome) ctx.out.line(outcome.sound);
    ctx.out.json({
      ...result,
      converted: result.converted.map((note) => ({ ...note })),
      removed: result.removed.map((note) => ({ ...note })),
      manual: result.manual.map((note) => ({ ...note })),
      pass: result.verify.problems.length === 0,
    });
    if ('failure' in outcome) throw outcome.failure;
  },
});
