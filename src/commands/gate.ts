// SPDX-License-Identifier: EUPL-1.2
import {
  acceptGate,
  checkJson,
  gateFailure,
  gateStatus,
  renderCheck,
  renderGate,
  runGate,
  VERIFIED_REF,
} from '../check/index.js';
import { arg, defineCommand, lockWaitMs, opt } from '../cli/command.js';
import { loadProject } from '../project/index.js';
import { workspaceOptions } from './workspace.js';

const accept = defineCommand({
  name: 'accept',
  summary: "Record a person's decision for the checked-out commit",
  description:
    'Records who decided, when, and the note for a gate.acceptance entry, against the tree of ' +
    'the checked-out commit. The lanes the entry names as evidence must have passed for this ' +
    'commit in this checkout. The record is a git ref, shared by every worktree.',
  args: { id: arg.string('The acceptance ID from gate.acceptance') },
  options: {
    note: opt.string('What was looked at and decided', { required: true, valueName: 'text' }),
    by: opt.string("Who decides (default: the repository's user.name, else the login name)", {
      valueName: 'name',
    }),
  },
  json: true,
  run: async (ctx, { id }, opts) => {
    const project = await loadProject(ctx.cwd, ctx.env);
    const result = await acceptGate(project, id, { note: opts.note, by: opts.by });
    ctx.out.line(
      `Recorded "${id}" by ${result.acceptance.by} for commit ${result.commit.slice(0, 12)}.`
    );
    ctx.out.line(
      result.pending.length === 0
        ? 'Every acceptance is recorded; run "fireforge gate" to move the verified ref.'
        : `Still outstanding: ${result.pending.join(', ')}.`
    );
    ctx.out.json({ ...result });
  },
});

const status = defineCommand({
  name: 'status',
  summary: 'Show where the verified ref is and what the gate recorded for HEAD',
  json: true,
  run: async (ctx) => {
    const project = await loadProject(ctx.cwd, ctx.env);
    const report = await gateStatus(project);
    const short = (commit: string): string => commit.slice(0, 12);
    const where = {
      verified: `${VERIFIED_REF} is at HEAD (${short(report.head)}).`,
      ahead: `HEAD (${short(report.head)}) is ${report.ahead ?? 0} commit(s) ahead of ${VERIFIED_REF} (${short(report.verified ?? '')}).`,
      diverged: `HEAD (${short(report.head)}) does not descend from ${VERIFIED_REF} (${short(report.verified ?? '')}).`,
      unverified: `No commit is verified yet; HEAD is ${short(report.head)}.`,
    };
    ctx.out.line(where[report.relation]);
    if (!report.clean) ctx.out.line('The working tree has uncommitted changes.');
    if (report.result === undefined) {
      ctx.out.line('No gate result is recorded for HEAD in this checkout.');
    } else {
      const red = report.result.entries.filter((entry) => entry.status !== 'pass');
      ctx.out.line(
        `The gate ${report.result.pass ? 'passed' : 'failed'} on HEAD at ${report.result.finishedAt}` +
          (red.length === 0
            ? '.'
            : `: ${red.map((entry) => `${entry.id} ${entry.status}`).join(', ')}.`)
      );
    }
    for (const [id, acceptance] of Object.entries(report.accepted)) {
      ctx.out.line(`accepted  ${id}  by ${acceptance.by} at ${acceptance.at}: ${acceptance.note}`);
    }
    for (const id of report.pending) ctx.out.line(`pending   ${id}`);
    ctx.out.json({
      ...report,
      verified: report.verified ?? null,
      ahead: report.ahead ?? null,
      result: report.result ?? null,
    });
  },
});

export const gate = defineCommand({
  name: 'gate',
  summary: 'Check, build and test the committed tree; on a pass, mark the commit verified',
  description:
    'On a clean committed tree, in one workspace: check, the build (gate.build), then every ' +
    'declared lane, stress run, negative control and smoke start. One run reports every entry. ' +
    `When all pass and every gate.acceptance is recorded, ${VERIFIED_REF} moves to the commit, ` +
    'fast-forward only. Outstanding acceptances leave the result pending, and the next gate ' +
    'reuses the recorded pass. A commit changing only gate.documents paths needs check alone. ' +
    '--lane is feedback only: it runs the named entries plus the build on the working tree ' +
    'as it is, committed or not, runs no check, records nothing and never moves ' +
    `${VERIFIED_REF}.`,
  group: 'Daily',
  options: {
    lane: opt.list(
      'Feedback only: run this declared entry (an ID, or kind:id) and the build on the working ' +
        'tree as it is, with no check, no record and no move of the verified ref; repeat for several',
      { valueName: 'id' }
    ),
    allowRewrite: opt.flag('Move the verified ref to a commit that does not descend from it'),
    ...workspaceOptions,
  },
  constraints: { exclusive: [['lane', 'allowRewrite']] },
  json: true,
  verdict: true,
  subcommands: [accept, status],
  run: async (ctx, _args, opts) => {
    const project = await loadProject(ctx.cwd, ctx.env);
    const report = await runGate(project, {
      only: opts.lane,
      allowRewrite: opts.allowRewrite,
      workspace: opts.workspace,
      waitMs: lockWaitMs(opts.waitLock),
    });
    if (report.check !== undefined)
      for (const line of renderCheck(report.check)) ctx.out.line(line);
    for (const line of renderGate(report)) ctx.out.line(line);
    ctx.out.json({
      outcome: report.outcome,
      basis: report.basis,
      pass: report.pass,
      commit: report.commit ?? null,
      tree: report.tree ?? null,
      entries: report.entries,
      check: report.check === undefined ? null : checkJson(report.check),
      pending: report.pending,
      artifacts: report.artifacts ?? null,
    });
    const red = report.entries.filter((entry) => entry.status === 'fail').map((entry) => entry.id);
    ctx.out.verdict(report.pass, {
      result: report.outcome,
      ...(report.pass ? {} : { reason: 'gate-failed', failed: red.join(',') }),
      ...(report.commit === undefined ? {} : { commit: report.commit }),
      ...(report.pending.length === 0 ? {} : { accept: report.pending.join(',') }),
    });
    const failure = gateFailure(report);
    if (failure !== undefined) throw failure;
  },
});
